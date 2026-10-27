"""Render the jobs chart without contacting a cluster or running a business job."""
import base64
import copy
import json
import os
import re
import tempfile
import pathlib
import subprocess
import unittest

import yaml

ROOT = pathlib.Path(__file__).resolve().parents[2]
CHART = ROOT / "deploy/kubernetes/jobs/chart"
ENDPOINT = "https://origin-vke.telesis.dev/v1/metrics"
ENABLED = {"profiles": {"otel": {"metrics": {"enabled": True, "endpoint": ENDPOINT, "headersSecretKey": "TELESIS_OTLP_METRICS_HEADERS"}}}}


def render(values):
    return subprocess.run(["helm", "template", "shorted-jobs", str(CHART), "--namespace", "shorted-jobs", "-f", "-"],
                          input=json.dumps(values), text=True, capture_output=True)


def objects(values):
    result = render(values)
    assert result.returncode == 0, result.stderr
    return {(doc["kind"], doc["metadata"]["name"]): doc for doc in yaml.safe_load_all(result.stdout) if doc}


class MetricsRoutingTest(unittest.TestCase):
    def test_all_shared_sdk_cloud_run_templates_receive_metrics_routing(self):
        production = (ROOT / "terraform/environments/prod/main.tf").read_text()
        modules = dict(re.findall(r'^module "([^"]+)" \{\n(.*?)^\}', production, re.M | re.S))
        standalone = {"shorts_api", "market_data", "enrichment_processor", "chat_service", "weekly_report_generator", "market_discovery_sync"}
        # The consolidated jobs opt into OTLP explicitly. Include retained and
        # paused templates, because manual Run-now uses those same templates.
        jobs = {name for name, block in modules.items()
                if 'source = "../../modules/shorted-job"' in block and "OTEL_EXPORTER_OTLP_ENDPOINT" in block}
        self.assertEqual(jobs, {"shorted_job_announcements", "shorted_job_index_sync", "shorted_job_price_sync", "shorted_job_weekly_report", "shorted_job_news", "shorted_job_signals"})
        for name in standalone | jobs:
            with self.subTest(module=name):
                self.assertRegex(modules[name], r"(?m)^\s*otel_metrics\s*=\s*var\.otel_metrics\s*$")

    def test_disabled_has_no_metrics_override_even_with_staged_configuration(self):
        configured = copy.deepcopy(ENABLED)
        configured["profiles"]["otel"]["metrics"]["enabled"] = False
        self.assertEqual(objects({}), objects(configured))
        self.assertNotIn("OTEL_EXPORTER_OTLP_METRICS", render({}).stdout)

    def test_enabled_changes_only_metrics_environment_on_otel_jobs(self):
        baseline, enabled = objects({}), objects(ENABLED)
        values = yaml.safe_load((CHART / "values.yaml").read_text())
        active = []
        self.assertEqual(set(baseline), set(enabled))
        for identity, original in baseline.items():
            actual = copy.deepcopy(enabled[identity])
            name = identity[1]
            if identity[0] == "CronJob" and "otel" in values["jobs"][name].get("profiles", []):
                env = actual["spec"]["jobTemplate"]["spec"]["template"]["spec"]["containers"][0]["env"]
                overrides = {item["name"]: item for item in env if item["name"].startswith("OTEL_EXPORTER_OTLP_METRICS")}
                self.assertEqual(set(overrides), {"OTEL_EXPORTER_OTLP_METRICS_ENDPOINT", "OTEL_EXPORTER_OTLP_METRICS_PROTOCOL", "OTEL_EXPORTER_OTLP_METRICS_HEADERS", "OTEL_EXPORTER_OTLP_METRICS_TEMPORALITY_PREFERENCE"})
                self.assertEqual(overrides["OTEL_EXPORTER_OTLP_METRICS_ENDPOINT"]["value"], ENDPOINT)
                self.assertEqual(overrides["OTEL_EXPORTER_OTLP_METRICS_PROTOCOL"]["value"], "http/protobuf")
                self.assertEqual(overrides["OTEL_EXPORTER_OTLP_METRICS_TEMPORALITY_PREFERENCE"]["value"], "cumulative")
                self.assertEqual(overrides["OTEL_EXPORTER_OTLP_METRICS_HEADERS"]["valueFrom"]["secretKeyRef"], {"name": "shorted-jobs-env", "key": "TELESIS_OTLP_METRICS_HEADERS"})
                env[:] = [item for item in env if item["name"] not in overrides]
                if not original["spec"]["suspend"]:
                    active.append(name)
            self.assertEqual(actual, original, name + ": traces, scheduling, images and other configuration must remain unchanged")
        self.assertEqual(set(active), {"shorted-news-cluster", "shorted-index-sync", "shorted-news", "shorted-news-backfill-images", "shorted-news-resolve-googlenews", "shorted-news-digest"})

    def test_enabled_requires_https_exact_path_and_dedicated_secret_key(self):
        for override in [{"endpoint": ""}, {"endpoint": "http://metrics.test/v1/metrics"}, {"endpoint": "https://user:secret@metrics.test/v1/metrics"}, {"endpoint": "https://metrics.test/v1/traces"}, {"headersSecretKey": ""}, {"headersSecretKey": "OTEL_EXPORTER_OTLP_HEADERS"}]:
            with self.subTest(override=override):
                values = copy.deepcopy(ENABLED)
                values["profiles"]["otel"]["metrics"].update(override)
                self.assertNotEqual(render(values).returncode, 0)


    def test_normal_pipeline_provisions_only_a_supplied_dedicated_secret(self):
        workflow = yaml.safe_load((ROOT / ".github/workflows/terraform-deploy.yml").read_text())
        for job, name in [("terraform-plan", "Ensure secrets exist in Secret Manager"), ("terraform-apply", "Ensure all secrets exist in Secret Manager")]:
            step = next(s for s in workflow["jobs"][job]["steps"] if s.get("name") == name)
            self.assertEqual(step["env"].get("TELESIS_OTLP_METRICS_HEADERS"), "${{ secrets.TELESIS_OTLP_METRICS_HEADERS }}")
            self.assertIn("github.event_name != 'pull_request'", step.get("if", workflow["jobs"][job].get("if", "")))
            for value in ["", " \n", "Authorization=Bearer%20fixture-only"]:
                with self.subTest(job=job, present=bool(value.strip())), tempfile.TemporaryDirectory() as temporary:
                    directory = pathlib.Path(temporary)
                    (directory / "scripts").mkdir()
                    (directory / "scripts/ensure-secret.sh").write_text('#!/usr/bin/env bash\nprintf "%s|%s\\n" "$1" "$2" >> "$CALL_LOG"\ncat >/dev/null\n')
                    (directory / "scripts/validate-gemini-key.sh").write_text('#!/usr/bin/env bash\ncat >/dev/null\nexit 4\n')
                    env = {"PATH": os.environ["PATH"], "GITHUB_WORKSPACE": temporary, "CALL_LOG": str(directory / "calls")}
                    env.update({key: re.sub(r"\$\{\{.*?\}\}", "", str(content)) for key, content in step["env"].items()})
                    env["TELESIS_OTLP_METRICS_HEADERS"] = value
                    result = subprocess.run(["bash", "-e", "-c", step["run"]], env=env, text=True, capture_output=True)
                    self.assertEqual(result.returncode, 0, result.stderr)
                    calls = (directory / "calls").read_text().splitlines()
                    self.assertEqual("TELESIS_OTLP_METRICS_HEADERS|-" in calls, bool(value.strip()))
                    self.assertTrue(all(call.endswith("|-") for call in calls), "Secret values must travel on stdin")
                    self.assertNotIn("fixture-only", result.stdout + result.stderr)
            self.assertEqual(step["env"].get("ENSURE_SECRET_CREATE_ONLY"), "1" if job == "terraform-plan" else None)

    def test_secret_preflight_includes_optional_key_before_enablement(self):
        # Real Helm render and key extraction; only external cloud calls are stubs.
        with tempfile.TemporaryDirectory() as temporary:
            directory = pathlib.Path(temporary)
            for name, source in {
                "kubectl": '#!/usr/bin/env bash\n[[ "$*" == "config current-context" ]] || exit 91\necho fixture-omega\n',
                "gcloud": '#!/usr/bin/env bash\n[[ "$1 $2" == "secrets describe" ]] || exit 92\n[[ "$3" != "${MISSING_KEY:-}" ]]\n',
                "jq": '#!/usr/bin/env bash\nexit 93 # No Secret may be written in these preflight tests.\n',
            }.items():
                target = directory / name
                target.write_text(source)
                target.chmod(0o700)
            env = {"PATH": temporary + os.pathsep + os.environ["PATH"]}
            script = str(ROOT / "deploy/kubernetes/jobs/scripts/sync-secrets.sh")
            flags = ["--set", "profiles.otel.metrics.enabled=true", "--set-string", "profiles.otel.metrics.endpoint=" + ENDPOINT]
            baseline = subprocess.run(["bash", script], env=env, text=True, capture_output=True)
            self.assertEqual(baseline.returncode, 0, baseline.stderr)
            self.assertNotIn("TELESIS_OTLP_METRICS_HEADERS", baseline.stdout)
            enabled = subprocess.run(["bash", script, *flags], env=env, text=True, capture_output=True)
            self.assertEqual(enabled.returncode, 0, enabled.stderr)
            self.assertIn("TELESIS_OTLP_METRICS_HEADERS", enabled.stdout)
            self.assertIn("PLAN ONLY", enabled.stdout)
            missing = subprocess.run(["bash", script, *flags], env={**env, "CONFIRM": "prod", "MISSING_KEY": "TELESIS_OTLP_METRICS_HEADERS"}, text=True, capture_output=True)
            self.assertEqual(missing.returncode, 1, missing.stderr)
            self.assertIn("refusing to sync a partial Secret", missing.stderr)


    def test_secret_sync_never_applies_partial_or_empty_values(self):
        # Use the real Helm/yq/jq pipeline with fake cloud endpoints. A Secret
        # object can exist while its latest version is disabled or inaccessible.
        expected_keys = {item["valueFrom"]["secretKeyRef"]["key"]
                         for obj in objects(ENABLED).values() if obj["kind"] == "CronJob"
                         for item in obj["spec"]["jobTemplate"]["spec"]["template"]["spec"]["containers"][0]["env"]
                         if "secretKeyRef" in item.get("valueFrom", {})}
        for fail_key, empty_key in [("", ""), ("TELESIS_OTLP_METRICS_HEADERS", ""), ("DATABASE_URL", ""), ("", "TELESIS_OTLP_METRICS_HEADERS")]:
            with self.subTest(fail_key=fail_key, empty_key=empty_key), tempfile.TemporaryDirectory() as temporary:
                directory = pathlib.Path(temporary)
                for name, source in {
                    "kubectl": '#!/usr/bin/env bash\ncase "$*" in\n "config current-context") echo fixture-omega ;;\n "apply -f -") cat > "$CAPTURE" ;;\n *) exit 91 ;;\nesac\n',
                    "gcloud": '#!/usr/bin/env bash\ncase "$1 $2" in\n "secrets describe") exit 0 ;;\n "secrets versions")\n  [[ "$6" != "${FAIL_KEY:-}" ]] || exit 9\n  [[ "$6" != "${EMPTY_KEY:-}" ]] || exit 0\n  printf "fixture-only:%s\\n" "$6" ;;\n *) exit 92 ;;\nesac\n',
                }.items():
                    target = directory / name
                    target.write_text(source)
                    target.chmod(0o700)
                capture = directory / "applied.json"
                env = {"PATH": temporary + os.pathsep + os.environ["PATH"], "CONFIRM": "prod", "FAIL_KEY": fail_key, "EMPTY_KEY": empty_key, "CAPTURE": str(capture)}
                (directory / "xtrace.sh").write_text("set -x\n")
                env["BASH_ENV"] = str(directory / "xtrace.sh")
                result = subprocess.run(["bash", str(ROOT / "deploy/kubernetes/jobs/scripts/sync-secrets.sh"), "--set", "profiles.otel.metrics.enabled=true", "--set-string", "profiles.otel.metrics.endpoint=" + ENDPOINT], env=env, text=True, capture_output=True)
                self.assertNotIn("fixture-only:", result.stdout + result.stderr, "Secret values must never be logged")
                self.assertFalse(any(base64.b64encode(("fixture-only:" + key + "\n").encode()).decode() in result.stdout + result.stderr for key in expected_keys), "Encoded Secret values must never be traced")
                if fail_key or empty_key:
                    self.assertNotEqual(result.returncode, 0)
                    self.assertFalse(capture.exists(), "No Kubernetes apply may start until every latest secret value has been read")
                else:
                    self.assertEqual(result.returncode, 0, result.stderr)
                    document = json.loads(capture.read_text())
                    self.assertEqual(document["metadata"]["name"], "shorted-jobs-env")
                    self.assertEqual(document["metadata"]["namespace"], "shorted-jobs")
                    self.assertEqual(set(document["data"]), expected_keys)
                    for key, value in document["data"].items():
                        self.assertEqual(base64.b64decode(value), ("fixture-only:" + key + "\n").encode())


if __name__ == "__main__":
    unittest.main()
