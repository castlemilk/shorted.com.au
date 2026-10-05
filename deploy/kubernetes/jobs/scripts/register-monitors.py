#!/usr/bin/env python3
"""Register one Telesis cron monitor (+ alert) per shorted-jobs CronJob.

    telesis login                                   # fresh Firebase session
    KUBECONFIG=~/projects/paprika/terraform/omega.kubeconfig \\
      deploy/kubernetes/jobs/scripts/register-monitors.py          # plan
    ... CONFIRM=prod deploy/kubernetes/jobs/scripts/register-monitors.py   # apply

Reads deploy/kubernetes/jobs/chart/values.yaml and converges Telesis on it:

* a Telesis service ("shorted.com.au scheduled jobs") to hang the monitors on;
* one cron monitor per CronJob — same cron expression (UTC), grace
  `monitoring.graceSeconds`, max runtime = the Job's own deadline + slack —
  created, or updated in place when the chart's schedule/timeout changed;
* one alert per monitor: consecutive failures >= 1 (a failed, missed or
  timed-out run) to `monitoring.telesis.alertEmail`;
* a heartbeat monitor for the reporter itself (secret key `_reporter`);
* the Kubernetes Secret `shorted-jobs-cron-monitors` mapping CronJob name ->
  private check-in URL, which the reporter mounts.

A check-in URL is only ever returned when a monitor is created or its token is
rotated. So a monitor that exists in Telesis but has no URL in the Secret (a
new cluster, a deleted Secret) is ROTATED to mint one — the old URL keeps
working through Telesis' rotation grace.

Auth: a Firebase ID token (TELESIS_TOKEN, else ~/.telesis/credentials.json from
`telesis login`). Telesis project tokens (upk_...) cannot be used — the cron
monitor RPCs check org membership of a *user*, and a project token resolves to
a synthetic user with no membership.

Stdlib + PyYAML only.
"""

from __future__ import annotations

import base64
import json
import os
import subprocess
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path

try:
    import yaml
except ImportError:  # pragma: no cover
    sys.exit("PyYAML is required: python3 -m pip install pyyaml")

HERE = Path(__file__).resolve().parent
VALUES = HERE.parent / "chart" / "values.yaml"
NAMESPACE = os.environ.get("NAMESPACE", "shorted-jobs")
HEARTBEAT_KEY = "_reporter"
ALERT_NAME_PREFIX = "shorted-jobs: "
APPLY = os.environ.get("CONFIRM") == "prod"


def log(msg: str) -> None:
    print(msg, flush=True)


# --- Telesis Connect-JSON client --------------------------------------------


class TelesisError(Exception):
    pass


class Telesis:
    def __init__(self, base: str, token: str) -> None:
        self.base = base.rstrip("/")
        self.token = token

    def call(self, service: str, method: str, body: dict) -> dict:
        req = urllib.request.Request(
            f"{self.base}/uptimeapi.v1.{service}/{method}",
            data=json.dumps(body).encode(),
            method="POST",
            headers={
                "Authorization": f"Bearer {self.token}",
                "Content-Type": "application/json",
                "Connect-Protocol-Version": "1",
                "User-Agent": "shorted-register-monitors/1.0",
            },
        )
        try:
            with urllib.request.urlopen(req, timeout=30) as resp:
                raw = resp.read()
        except urllib.error.HTTPError as err:
            detail = err.read().decode(errors="replace")[:500]
            raise TelesisError(f"Telesis {service}/{method} failed: HTTP {err.code}: {detail}") from None
        return json.loads(raw or b"{}")

    def paged(self, service: str, method: str, body: dict, items_key: str) -> list[dict]:
        out: list[dict] = []
        token = ""
        while True:
            page = {"pageSize": 100}
            if token:
                page["pageToken"] = token
            resp = self.call(service, method, {**body, "page": page})
            out.extend(resp.get(items_key, []))
            info = resp.get("pageInfo", {})
            token = info.get("nextPageToken", "")
            if not info.get("hasNextPage") or not token:
                return out


def load_credentials() -> tuple[str, str, str]:
    token = os.environ.get("TELESIS_TOKEN", "")
    base = os.environ.get("TELESIS_API", "")
    org = os.environ.get("TELESIS_ORG_ID", "")
    cred_path = Path.home() / ".telesis" / "credentials.json"
    if cred_path.exists():
        creds = json.loads(cred_path.read_text())
        token = token or creds.get("token", "")
        base = base or creds.get("api_endpoint", "")
        org = org or creds.get("organization", "")
    base = base or "https://api.telesis.dev"
    if not token:
        sys.exit("no Telesis token: run `telesis login` or set TELESIS_TOKEN")
    if token.startswith("upk_"):
        sys.exit("project tokens (upk_) cannot manage cron monitors; use a user session (`telesis login`)")
    try:
        payload = token.split(".")[1]
        claims = json.loads(base64.urlsafe_b64decode(payload + "=" * (-len(payload) % 4)))
        remaining = int(claims.get("exp", 0) - time.time())
        if remaining < 120:
            sys.exit(f"Telesis session expired {-remaining}s ago — run `telesis login` and retry")
    except (IndexError, ValueError):
        pass  # not a JWT we can introspect; let the API decide
    return base, token, org


# --- Desired state from the chart -------------------------------------------


def desired_monitors(values: dict) -> dict[str, dict]:
    mon = values["monitoring"]
    d = values["defaults"]
    out: dict[str, dict] = {}
    for name, job in sorted(values["jobs"].items()):
        timeout = int(job.get("timeoutSeconds", d["timeoutSeconds"]))
        retries = int(job.get("maxRetries", d["maxRetries"]))
        # Mirrors templates/cronjobs.yaml: Job deadline = timeout x attempts + 300.
        job_deadline = timeout * (retries + 1) + 300
        out[name] = {
            "schedule": {"cronExpression": job["schedule"], "timezone": "UTC"},
            "gracePeriodSeconds": int(mon["graceSeconds"]),
            "maxRuntimeSeconds": job_deadline + int(mon["maxRuntimeSlackSeconds"]),
            "affectsServiceStatus": True,
        }
    for name, m in sorted((values.get("schedulerMonitors") or {}).items()):
        # A scheduler-driven HTTP call reports only its outcome (no start), so
        # there is no hung-run window to watch.
        out[name] = {
            "schedule": {"cronExpression": m["schedule"], "timezone": "UTC"},
            "gracePeriodSeconds": int(mon["graceSeconds"]),
            "maxRuntimeSeconds": 0,
            "affectsServiceStatus": True,
        }
    reporter = values.get("reporter", {})
    if reporter.get("enabled", True):
        hb = parse_duration(reporter.get("heartbeatInterval", "5m"))
        # Twice the ping cadence, so one dropped ping is not an incident.
        out[HEARTBEAT_KEY] = {
            "schedule": {"intervalSeconds": str(max(600, hb * 2)), "timezone": "UTC"},
            "gracePeriodSeconds": max(300, hb),
            "maxRuntimeSeconds": 0,
            "affectsServiceStatus": True,
            "displayName": "cronjob-reporter heartbeat",
        }
    return out


def parse_duration(s: str) -> int:
    units = {"s": 1, "m": 60, "h": 3600}
    return int(s[:-1]) * units[s[-1]] if s and s[-1] in units else int(s)


def drift(have: dict, want: dict) -> dict:
    """Fields of `want` that differ from the live monitor (protojson int64s are strings)."""
    changes: dict = {}
    sched = have.get("schedule", {})
    if (sched.get("cronExpression"), str(sched.get("intervalSeconds", "")) or None, sched.get("timezone")) != (
        want["schedule"].get("cronExpression"),
        str(want["schedule"].get("intervalSeconds", "")) or None,
        want["schedule"]["timezone"],
    ):
        changes["schedule"] = want["schedule"]
    for key in ("gracePeriodSeconds", "maxRuntimeSeconds"):
        if int(have.get(key, 0) or 0) != int(want[key]):
            changes[key] = want[key]
    if bool(have.get("affectsServiceStatus")) != want["affectsServiceStatus"]:
        changes["affectsServiceStatus"] = want["affectsServiceStatus"]
    return changes


# --- Kubernetes Secret -------------------------------------------------------


def kubectl(*args: str, stdin: bytes | None = None) -> bytes:
    return subprocess.run(["kubectl", *args], input=stdin, check=True, capture_output=True).stdout


def existing_urls(secret: str) -> dict[str, str]:
    try:
        raw = kubectl("-n", NAMESPACE, "get", "secret", secret, "-o", "json")
    except subprocess.CalledProcessError:
        return {}
    data = json.loads(raw).get("data") or {}
    return {k: base64.b64decode(v).decode().strip() for k, v in data.items()}


def write_urls(secret: str, urls: dict[str, str]) -> None:
    doc = {
        "apiVersion": "v1",
        "kind": "Secret",
        "type": "Opaque",
        "metadata": {
            "name": secret,
            "namespace": NAMESPACE,
            "labels": {"app.kubernetes.io/part-of": "shorted", "shorted.com.au/managed-by": "register-monitors"},
        },
        "data": {k: base64.b64encode(v.encode()).decode() for k, v in sorted(urls.items())},
    }
    # Streamed on stdin: the URLs are credentials and never touch argv or disk.
    kubectl("apply", "-f", "-", stdin=json.dumps(doc).encode())


# --- Main -------------------------------------------------------------------


def converge(api: Telesis, key: str, spec: dict, live: dict, urls: dict, service_id: str,
             alert_email: str, secret: str) -> bool:
    """Create/update one monitor and its alert. Returns True if `urls` changed."""
    changed = False
    name = spec.get("displayName", key)
    have = live.get(name)
    body = {k: v for k, v in spec.items() if k != "displayName"}

    if have is None:
        log(f"  + monitor {name!r}  {json.dumps(body['schedule'])}  "
            f"grace={body['gracePeriodSeconds']}s maxRuntime={body['maxRuntimeSeconds']}s")
        if not APPLY:
            return False
        resp = api.call("CronMonitorService", "CreateCronMonitor", {"serviceId": service_id, "name": name, **body})
        have = resp["monitor"]
        urls[key] = resp["telemetryUrl"]
        changed = True
    else:
        changes = drift(have, body)
        if changes:
            log(f"  ~ monitor {name!r}: {sorted(changes)}")
            if APPLY:
                have = api.call("CronMonitorService", "UpdateCronMonitor", {"id": have["id"], **changes})["monitor"]
        if key not in urls:
            log(f"  ~ monitor {name!r}: no check-in URL in {NAMESPACE}/{secret} — rotating its token to mint one")
            if APPLY:
                resp = api.call("CronMonitorService", "RotateCronMonitorToken", {"id": have["id"]})
                urls[key] = resp["telemetryUrl"]
                changed = True

    if not APPLY:
        return changed
    alerts = api.paged("AlertService", "ListAlerts", {"checkId": have["checkId"]}, "alerts")
    if not any(a.get("name", "").startswith(ALERT_NAME_PREFIX) for a in alerts):
        log(f"  + alert on {name!r} -> {alert_email}")
        api.call(
            "AlertService",
            "CreateAlert",
            {
                "checkId": have["checkId"],
                "name": f"{ALERT_NAME_PREFIX}{name} failed, missed or timed out",
                "conditionType": "ALERT_CONDITION_TYPE_CONSECUTIVE_FAILURES",
                "conditionConfig": {"consecutiveFailures": {"count": 1}},
                "channels": [{"type": "email", "target": alert_email}],
            },
        )
    return changed


def main() -> None:
    values = yaml.safe_load(VALUES.read_text())
    mon_cfg = values["monitoring"]
    if not mon_cfg.get("enabled", True):
        sys.exit("monitoring.enabled is false in values.yaml — nothing to register")
    tcfg = mon_cfg["telesis"]
    alert_email = os.environ.get("ALERT_EMAIL", tcfg["alertEmail"])
    secret = mon_cfg["checkinSecret"]

    base, token, org_id = load_credentials()
    api = Telesis(base, token)
    ctx = subprocess.run(["kubectl", "config", "current-context"], capture_output=True, text=True).stdout.strip()
    log(f"==> Telesis {base}   kube context {ctx or '?'}   namespace {NAMESPACE}")
    if not APPLY:
        log("==> PLAN ONLY — re-run with CONFIRM=prod to create/update monitors and write the Secret")

    if not org_id:
        orgs = api.paged("OrganizationService", "ListOrganizations", {}, "organizations")
        if len(orgs) != 1:
            sys.exit(f"{len(orgs)} Telesis organizations visible; set TELESIS_ORG_ID")
        org_id = orgs[0]["id"]

    services = api.paged("ServiceService", "ListServices", {"orgId": org_id}, "services")
    service = next((s for s in services if s.get("name") == tcfg["serviceName"]), None)
    if service is None:
        log(f"  + service {tcfg['serviceName']!r}")
        if APPLY:
            service = api.call(
                "ServiceService",
                "CreateService",
                {"orgId": org_id, "name": tcfg["serviceName"], "url": tcfg["serviceUrl"],
                 "description": "Kubernetes CronJobs on omega (deploy/kubernetes/jobs), reported by cronjob-reporter"},
            )["service"]
    service_id = service["id"] if service else "<new>"

    live = {}
    if service:
        for m in api.paged("CronMonitorService", "ListCronMonitors", {"orgId": org_id, "serviceId": service_id}, "monitors"):
            live[m["name"]] = m

    urls = existing_urls(secret)
    want = desired_monitors(values)
    changed_urls = False

    for key, spec in want.items():
        try:
            changed_urls |= converge(api, key, spec, live, urls, service_id, alert_email, secret)
        except TelesisError as err:
            if key != HEARTBEAT_KEY:
                raise
            # The heartbeat is a nicety; a plan whose minimum interval rejects
            # it must not block the per-job monitors that matter.
            log(f"  ! reporter heartbeat monitor not registered: {err}")

    orphans = sorted(set(live) - {s.get("displayName", k) for k, s in want.items()})
    for name in orphans:
        log(f"  ! monitor {name!r} is in Telesis but no longer in values.yaml — pause or delete it in the Telesis console")

    stale_keys = sorted(set(urls) - set(want))
    for key in stale_keys:
        log(f"  - check-in URL {key!r} dropped from {secret} (job removed)")
        urls.pop(key)
        changed_urls = True

    if APPLY and changed_urls:
        write_urls(secret, urls)
        log(f"==> wrote {len(urls)} check-in URLs to {NAMESPACE}/{secret}")
    log("==> done" if APPLY else "==> plan complete")


if __name__ == "__main__":
    try:
        main()
    except TelesisError as err:
        sys.exit(str(err))
