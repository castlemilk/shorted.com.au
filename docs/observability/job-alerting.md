# Job alerting — the three layers

Shorted's async work is a fleet of Cloud Run Jobs (shorts sync, price ingestion,
enrichment, news, economy, housing collectors, report generation, …) plus the
off-cloud housing crawl rig. They fail in three different ways, and each way is
invisible to the others' detector. So there are three layers, deliberately
independent, ordered from "closest to the failure" to "hardest to break".

| Layer | What it is | Detects | Fails silently when |
|---|---|---|---|
| 1. GCP alert policies | `terraform/modules/job-monitoring` → email | A job crashed, OOM'd, exited non-zero, logged ERROR, or hit its task timeout | The job never started; alerting itself is misconfigured or the channel bounces |
| 2. GitHub sentinels | `.github/workflows/*-freshness.yml` → GitHub issue | The *data* is stale, whatever the jobs claim | GitHub Actions is down (rare, and visibly so) |
| 3. Admin console | `/admin` jobs dashboard | Everything, but only when a human opens it | Nobody looks |

The ordering matters. Layer 1 tells you fastest, but it lives inside the thing
being monitored: a job that is never invoked emits no logs and no failed
execution, so it raises nothing. That is the exact shape of several past
outages — a paused scheduler, never-attempted jobs banked as "succeeded", a rig
whose launchd wrapper was unloaded. Layer 2 asks the only question that cannot
be faked from inside: *is the data newer than it was yesterday?* It runs on
GitHub's infrastructure with no GCP credentials and no database credentials, so
it keeps working when the deploy, the service account, or the alert policy is
broken. Layer 3 is for diagnosis, not detection.

## Layer 1 — Cloud Monitoring (Terraform)

Module: `terraform/modules/job-monitoring`, wired in
`terraform/environments/prod/main.tf` as `module "job_monitoring"`.

It creates, in `rosy-clover-477102-t5`:

- **`google_monitoring_notification_channel.email`** — "Job alerts (email)",
  addressed to `var.alert_recipient_email` (prod default `ben@shorted.com.au`).
- **`google_monitoring_alert_policy.cloud_run_job_failed`** (severity ERROR) —
  fires on `run.googleapis.com/job/completed_execution_count` with
  `metric.label.result = "failed"`, grouped by `resource.label.job_name`, so each
  failing job raises its own incident. Catches non-zero exits, OOM, and startup
  failures.
- **`google_logging_metric.job_errors`** — a log-based counter over
  `resource.type="cloud_run_job"` matching `severity>=ERROR` or the textPayload
  shapes `"Terminating task"` / `"DeadlineExceeded"`, labelled by job name.
- **`google_monitoring_alert_policy.job_log_errors`** (severity WARNING) — fires
  on that metric. This is the "exit 0 having done nothing" / hung-to-its-deadline
  class the execution-count metric cannot see.

Both filters key off `resource.type="cloud_run_job"`, so **every** job in the
project is covered automatically — there is no per-job allowlist to keep in sync
when a job is added. Both auto-close after 30 minutes of quiet; the real all-clear
is the next successful scheduled run.

Setting `alert_recipient_email = ""` is the kill switch: the module becomes a
complete no-op (no channel, no policies). The variable *defaulted* to empty,
but prod was never actually dark: CI passes `TF_VAR_alert_recipient_email`
from the `ALERT_RECIPIENT_EMAIL` GitHub secret (verified live 2026-08-21: the
"Job alerts (email)" channel and both policies exist and are enabled, wired to
ben.ebsworth@gmail.com). The non-empty prod default exists for the OTHER apply
path: a local `terraform apply` without that env var would previously have
silently destroyed the whole alert layer. Note the two values differ — the CI
secret (ben.ebsworth@gmail.com) wins in CI; the default (ben@shorted.com.au)
only applies on a local apply, where it would retarget the channel.

## Layer 2 — GitHub sentinels

| Workflow | Cadence | Checks | Issue label |
|---|---|---|---|
| `shorts-data-freshness.yml` | daily 20:07 UTC | Newest ASIC report date, via the public edge API | `shorts-data-freshness` |
| `housing-freshness.yml` | daily 22:11 UTC | Housing ingest errors, event silence, per-suburb catalog staleness, rig status (read-only prod DB) | `housing-freshness` |
| `economy-freshness.yml` | monthly, 8th | Runs `shorted-economy -mode freshness` on prod | (run failure) |
| `register-freshness.yml` | weekly, Mon 21:47 UTC | Politician register freshness | (run failure) |

All of them file **one** tracking issue and reuse it, then close it on the next
green run. So an open issue always means "currently broken", never "broke once".
A daily sentinel that opens a daily issue is noise inside a week, and noise is
how the previous outage was missed.

### `shorts-data-freshness.yml` — the threshold

Logic lives in `.github/workflows/shorts-data-freshness.mjs` (unit-tested by
`shorts-data-freshness.test.mjs`, `node --test`).

It GETs `https://api.shorted.com.au/edge/v1/available-dates?limit=10` with a
browser-ish User-Agent (the bare `fetch` default UA is challenged by the
Cloudflare WAF), takes the newest `YYYY-MM-DD`, and measures its age in
**trading days**:

- Trading days are counted **strictly after** the report date, up to and
  including today's *Sydney* calendar date (`Australia/Sydney`, not the runner's
  UTC date — a 20:07 UTC run is already tomorrow in Australia).
- Weekends are excluded. ASX national holidays are excluded via a static table
  in the module, currently covering 2026–2027. Over-listing a holiday is the safe
  direction: it lowers the counted age, so the sentinel alerts *later*, never on a
  holiday artefact. When the table expires the check emits
  `HOLIDAY_TABLE_EXPIRED` instead of quietly drifting.
- **Breach when the age is strictly greater than 6 trading days.** ASIC publishes
  short-position reports on a T+4 basis, so the healthy steady state is 4 trading
  days. Six leaves two days of slack for an unlisted holiday or a one-day
  publication slip.

It also reports `DATA_UNAVAILABLE` (endpoint returned no usable dates),
`DATE_IN_FUTURE` (clock skew or a bad ingest — otherwise it would read as
maximally fresh), and `API_UNREACHABLE` (the edge API itself is down, which is a
production incident in its own right).

**Not checked: `sync_status`.** The table is only exposed by `GetSyncStatus`,
which is `VISIBILITY_PRIVATE` + `required_role = "admin"`. Reaching it would mean
putting either an admin credential or the prod DSN into this workflow, and the
whole point of this layer is that it holds no credentials. Sync-run failures are
covered by layer 1 (the job's own exit code) and inspected in layer 3; the
question this layer exists to answer — "did a new day actually land?" — is
answered without it.

## Layer 3 — admin console

`/admin` jobs dashboard, backed by `services/shorts/internal/jobmonitor`
(GCP-native). Use it to see the last N executions per job, durations, and error
text. It is a dashboard, not a detector.

### "Run now" — on-demand execution

Each non-retired Cloud Run Job row has a **Run** button:
`/admin` → server action `runJobNow` (`web/src/app/actions/runJob.ts`,
`requireAdmin()`-gated) → `POST /api/admin/jobs/run` on the shorts API
(`INTERNAL_SERVICE_SECRET`, `services/shorts/internal/services/shorts/jobs_run.go`)
→ `jobmonitor.Collector.RunJob` → Cloud Run `projects.locations.jobs.run`.

The name a caller sends is **never** passed through to GCP. It is resolved
against the fleet the collector has actually observed, and only the resolved
job's own name + region are used. That produces four refusals:

| Response | Meaning |
|---|---|
| `404 unknown_job` | Not in the collected fleet (or the supplied region disagrees with where the job is deployed). |
| `409 not_executable` | A scheduler-only *service* row or a residential *rig* row — there is no Cloud Run Job to execute. |
| `409 retired` | Marked `Retired` in the jobmonitor catalog (superseded, schedulers paused on purpose). Run its replacement. |
| `409 already_running` | An execution is in flight. Carries `executionName`, `runningForSeconds`, and `forceable: true`. |
| `202` | Accepted — body has the created `executionName`. |

**Force semantics.** `{"force": true}` overrides the already-running guard and
**only** that guard: a retired or unknown job stays refused with force set. It
exists because the ASIC short-positions sync legitimately runs 26–29h, so a
deliberate parallel run has to be possible — but never accidental. The console
therefore offers Force *only after* a first 409 `already_running`; the button
starts as a plain "Run".

Every accepted run writes an audit line to the shorts API log:
`AUDIT jobs/run actor=… job=… region=… execution=… forced=… previous=…`. The
actor is the admin's verified email, forwarded as `x-admin-actor` by the server
action; a direct caller holding only the internal secret is audited as
`unknown (internal secret)`.

**IAM.** The shorts service account (`shorts@<project>`) holds
`roles/run.invoker` **per job** — `google_cloud_run_v2_job_iam_member.shorts_api_run_now`,
a `for_each` over `local.admin_runnable_jobs` in `terraform/environments/{prod,dev}/main.tf`.
Per-job rather than a project-level role for two reasons: the CI deploy SA cannot
`setIamPolicy` at the project level (project-level grants have to be `import`ed,
not created), and a job-scoped grant means the console can execute exactly the
listed jobs and nothing else. `roles/run.invoker` is the weakest role carrying
`run.jobs.run`; `roles/run.developer` would also permit `runWithOverrides`
(executing a job with a different command/env), which this endpoint must never do.

Adding a new job module means adding a line to that map — otherwise "Run now"
returns `502 run_failed` for it with a permission error in the logs. Retired jobs
are deliberately absent from the map: the API refuses them anyway.

## How to respond

**A GCP email alert (`Cloud Run Job execution failed` / `logged ERROR / timeout`)**

1. The incident names the job. Read its logs:
   `gcloud logging read 'resource.type="cloud_run_job" AND resource.labels.job_name="<job>"' --project rosy-clover-477102-t5 --limit 50 --freshness 2h`
2. Cross-check `/admin` for whether previous runs were already failing (a first
   failure and a week-long streak are different problems).
3. Re-run manually once the cause is fixed:
   `gcloud run jobs execute <job> --project rosy-clover-477102-t5 --region australia-southeast2 --wait`
4. Timeout/`Terminating task` terminations are usually a wedged run, not slow
   work — check for a stale resume cursor or a held lock before raising the
   timeout.

**A `shorts-data-freshness` issue**

1. Confirm it is real, not a market closure:
   `curl -H 'User-Agent: Mozilla/5.0' https://api.shorted.com.au/edge/v1/available-dates`
2. If the API is unreachable, this is a site incident — use
   `$shorted-prod-troubleshooting`, not this runbook.
3. If the API is up but the date is old, the sync did not land a day. Check the
   sync job's recent executions (layer 1's logs, or `/admin`). Look for the known
   shapes: the UTC-midnight resume reset, a paused scheduler, an ASIC source
   change.
4. After a successful backfill, remember the read path is cached — bust it
   (`/api/revalidate`, `?flush=shorts`) or the site keeps serving the stale date
   even though the sentinel goes green.
5. The issue closes itself on the next green run. Do not close it by hand while
   the data is still stale — that is the signal.

**Nothing has alerted but something feels wrong**

Check that layer 1 is actually armed: `alert_recipient_email` non-empty in
`terraform/environments/prod`, and the notification channel not disabled in the
console. A bouncing or disabled channel is a silent single point of failure, and
is precisely why layer 2 does not depend on it.
