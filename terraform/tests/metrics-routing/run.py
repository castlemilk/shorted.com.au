"""Mock-provider plans only. No backend, credentials, cloud writes or real state."""
import os
import pathlib
import re
import shutil
import subprocess
import tempfile

ROOT = pathlib.Path(__file__).resolve().parents[3]
HERE = pathlib.Path(__file__).resolve().parent
production = (ROOT / "terraform/environments/prod/main.tf").read_text()
provider_versions = {}
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
    for name, resource in [("shorts-api", "shorts_api"), ("market-data", "market_data"), ("enrichment-processor", "enrichment_processor")]:
        target = work / name
        target.mkdir()
        for source in (ROOT / "terraform/modules" / name).glob("*.tf"):
            shutil.copy2(source, target / source.name)
        if name == "enrichment-processor":
            (target / "fixtures.auto.tfvars").write_text('postgres_address = "database.test"\npostgres_database = "fixture"\npostgres_username = "fixture"\n')
        # Use exactly the production provider versions, without initializing its
        # GCS backend or loading any production variable files.
        providers = "\n".join(f'    {name} = {{ source = "hashicorp/{name}", version = "{version}" }}' for name, version in provider_versions.items())
        (target / "test-providers.tf").write_text("terraform {\n  required_providers {\n" + providers + "\n  }\n}\n")
        (target / "metrics.tftest.hcl").write_text((HERE / "metrics.tftest.hcl.tpl").read_text().replace(".RESOURCE.", "." + resource + "."))
        subprocess.run(["terraform", "init", "-backend=false", "-input=false", "-no-color"], cwd=target, env=env, check=True)
        subprocess.run(["terraform", "test", "-no-color"], cwd=target, env=env, check=True)
