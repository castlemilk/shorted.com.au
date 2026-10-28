"""Mock-provider plans only. No backend, credentials, cloud writes or real state."""
import os
import json
import pathlib
import re
import shutil
import subprocess
import tempfile

ROOT = pathlib.Path(__file__).resolve().parents[3]
HERE = pathlib.Path(__file__).resolve().parent
production = (ROOT / "terraform/environments/prod/main.tf").read_text()
production_metrics = ROOT / "terraform/environments/prod/metrics-routing.auto.tfvars"
if not production_metrics.is_file():
    raise RuntimeError("Production metrics profile is missing")
provider_versions = {}
# Each deployed resource shape is planned, including paused/manual templates.
# Market discovery has two distinct runtime identities and must grant both.
targets = [
    ("shorts-api", "service", "shorts_api", "otel_metrics_headers", {}),
    ("market-data", "service", "market_data", "otel_metrics_headers", {}),
    ("enrichment-processor", "service", "enrichment_processor", "otel_metrics_headers", {"postgres_address": "database.test", "postgres_database": "fixture", "postgres_username": "fixture"}),
    ("chat-service", "service", "chat_service", "otel_metrics_headers", {"shorts_api_url": "https://api.test"}),
    ("weekly-report-generator", "job", "weekly_report_generator", "otel_metrics_headers", {"scheduler_paused": True}),
    ("shorted-job", "job", "job", "otel_metrics_headers", {"name": "metrics-fixture", "args": ["weekly-report"], "schedule": "0 11 * * 5", "paused": True, "schedules": [{"name_suffix": "monthly", "cron": "0 1 1 * *", "env_override": {"REPORT_TYPE": "monthly"}}]}),
    ("market-discovery-sync", "job", "asx_discovery", "asx_discovery_otel_metrics_headers", {}),
    ("market-discovery-sync", "service", "market_data_sync", "market_data_sync_otel_metrics_headers", {}),
]
for provider in ("google", "random"):
    match = re.search(r'source\s*=\s*"hashicorp/' + provider + r'"\s+version\s*=\s*"(\d+\.\d+\.\d+)"', production)
    if not match:
        raise RuntimeError(f"Production {provider} provider must have an exact version pin")
    provider_versions[provider] = match.group(1)
with tempfile.TemporaryDirectory(prefix="shorted-metrics-terraform-") as temporary:
    work = pathlib.Path(temporary)
    cache = work / "plugins"
    cache.mkdir()
    env = {key: value for key, value in os.environ.items() if not key.startswith(("TF_VAR_", "TF_CLI_ARGS")) and key not in {"TF_DATA_DIR", "TF_WORKSPACE"}}
    env.update(TF_PLUGIN_CACHE_DIR=str(cache), TF_IN_AUTOMATION="1")
    for name, kind, resource, iam, fixtures in targets:
        target = work / (name + "-" + resource)
        target.mkdir()
        for source in (ROOT / "terraform/modules" / name).glob("*.tf"):
            shutil.copy2(source, target / source.name)
        variables = {"project_id": "metrics-test", "region": "australia-southeast1", "environment": "test", "image_url": "example.test/shorted:fixture", "otel_endpoint": "https://traces.test/otlp", **fixtures}
        if name == "market-discovery-sync":
            variables.pop("image_url")
            variables.update(asx_discovery_image="example.test/discovery:fixture", market_data_sync_image="example.test/market-sync:fixture", bucket_name="metrics-test-assets", asx_discovery_scheduler_paused=True, market_data_sync_scheduler_paused=True)
        elif name == "shorted-job":
            variables.pop("otel_endpoint")
            variables.update(env={"OTEL_EXPORTER_OTLP_ENDPOINT": "https://traces.test/otlp", "OTEL_EXPORTER_OTLP_PROTOCOL": "http/protobuf", "ENVIRONMENT": "fixture"}, secret_env={"OTEL_EXPORTER_OTLP_HEADERS": "OTEL_EXPORTER_OTLP_HEADERS", "DATABASE_URL": "DATABASE_URL"})
        # Use exactly the production provider versions, without initializing its
        # GCS backend. Generic default tests do not load production overrides.
        providers = "\n".join(f'    {name} = {{ source = "hashicorp/{name}", version = "{version}" }}' for name, version in provider_versions.items())
        # Override merges these exact pins with module-specific providers (chat
        # also requires time), rather than declaring a duplicate provider block.
        (target / "test-providers_override.tf").write_text("terraform {\n  required_providers {\n" + providers + "\n  }\n}\n")
        container = f"google_cloud_run_v2_{kind}.{resource}.template[0]." + ("template[0]." if kind == "job" else "") + "containers[0]"
        test = (HERE / "metrics.tftest.hcl.tpl").read_text().replace("@CONTAINER@", container).replace("@IAM@", iam).replace("@ACCOUNT@", resource).replace("@VARIABLES@", "variables {\n" + "\n".join(f"  {key} = {json.dumps(value)}" for key, value in variables.items()) + "\n}")
        if name == "chat-service":
            test = 'mock_provider "time" {}\n' + test
        if name == "shorted-job":
            # Generic maps must not create duplicate Cloud Run env names or
            # two Terraform resources owning the same secret IAM membership.
            for label, overrides in [
                ("duplicate_plain_metrics_env", {"env": {"OTEL_EXPORTER_OTLP_METRICS_ENDPOINT": "https://other.test/v1/metrics"}}),
                ("duplicate_secret_metrics_env", {"secret_env": {"OTEL_EXPORTER_OTLP_METRICS_HEADERS": "OTHER_HEADERS"}}),
                ("duplicate_metrics_secret_grant", {"secret_env": {"OTHER_HEADERS": "TELESIS_OTLP_METRICS_HEADERS"}}),
            ]:
                overrides["otel_metrics"] = {"enabled": True, "endpoint": "https://origin-vke.telesis.dev/v1/metrics", "headers_secret": "TELESIS_OTLP_METRICS_HEADERS"}
                test += '\nrun "reject_' + label + '" {\n  command = plan\n  variables {\n' + '\n'.join(f'    {key} = {json.dumps(value)}' for key, value in overrides.items()) + '\n  }\n  expect_failures = [google_cloud_run_v2_job.job]\n}\n'
        (target / "metrics.tftest.hcl").write_text(test)
        (target / "test-outputs.tf").write_text('output "non_metrics_env" {\n  value = [for e in ' + container + '.env : e if !startswith(e.name, "OTEL_EXPORTER_OTLP_METRICS")]\n}\n')
        subprocess.run(["terraform", "init", "-backend=false", "-input=false", "-no-color"], cwd=target, env=env, check=True)
        subprocess.run(["terraform", "test", "-no-color"], cwd=target, env=env, check=True)
        # The real, non-secret production profile is tested separately so
        # reusable module defaults remain independently disabled and verified.
        production_test = (HERE / "production.tftest.hcl.tpl").read_text().replace("@CONTAINER@", container).replace("@IAM@", iam).replace("@VARIABLES@", "variables {\n" + "\n".join(f"  {key} = {json.dumps(value)}" for key, value in variables.items()) + "\n}")
        if name == "chat-service":
            production_test = 'mock_provider "time" {}\n' + production_test
        (target / "production.tftest.hcl").write_text(production_test)
        subprocess.run(["terraform", "test", "-no-color", "-filter=production.tftest.hcl", "-var-file=" + str(production_metrics)], cwd=target, env=env, check=True)
