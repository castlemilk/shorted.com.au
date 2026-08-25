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

Both policies match every Cloud Run Job in the project. The single exception is
`var.excluded_job_names`, wired in prod to `shorted-economy-freshness`: that job
IS a sentinel, its exit code is its verdict, and `economy-freshness.yml` already
turns a non-zero run into a labelled issue carrying the per-source report. A
parallel email saying only "a Cloud Run Job failed" would be a second, vaguer
page for the same event. Add to that list only jobs with their own alerting.

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
| `economy-freshness.yml` | monthly, 8th | Executes the `shorted-economy-freshness` job on prod (a separate Cloud Run job from the `shorted-economy` ingest, so a stale verdict never reads as an ingest outage) | `economy-freshness` |
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
The one scoped exception is the validation endpoint below.

Adding a new job module means adding a line to that map — otherwise "Run now"
returns `502 run_failed` for it with a permission error in the logs. Retired jobs
are deliberately absent from the map: the API refuses them anyway.

### "Validate sync" — validating the sync for a stock

**When to reach for it.** The sync exited 0, the dashboard is green, and a stock
still looks wrong on the site — stale, or a number nobody believes. "Run now"
does not help: it re-runs the same pipeline and tells you nothing about *why*.
The validation run answers the actual question for one handful of codes: what
does the latest ASIC file contain for them, what would the sync insert or update,
and what is in the database right now.

It is **read-only by construction**. The backend always runs the job with
`-shadow`, which opens no write path at all: no `shorts` upsert, no `sync_status`
row, no MV refresh, no revalidation ping, no Algolia call. Its only database
contact is two SELECTs.

**Operator steps**

1. `/admin` → jobs console → the *Validate sync for specific stocks* panel
   (rendered above the table whenever `shorts-data-sync` is in the fleet).
2. Type codes — `BHP, DRO` — and press **Validate**. Up to 20, each
   `^[A-Z0-9]{1,5}$`; the input refuses bad codes before they cost an execution,
   and the backend re-validates regardless.
3. The panel shows the execution name and polls every 10s (giving up after 10
   minutes). A shadow run over a week of ASIC files usually finishes inside the
   first poll.
4. Read the per-stock table: file value, DB value, and a status badge —
   `new` / `unchanged` / `changed` / `missing from file`. `changed` lists the
   columns that differ. "Show raw JSON" has the whole summary.

Status meanings, and the two things that look like bugs but are not (a product
rename never counts as `changed`; ASIC omits stocks with no reportable position,
which is what `missing from file` usually is), are documented in
[`services/jobs/internal/jobs/shortdatasync/README.md`](../../services/jobs/internal/jobs/shortdatasync/README.md)
§"Per-stock validation".

**Endpoints.** `/admin` → server actions `startSyncValidation` /
`getSyncValidation` (`web/src/app/actions/validateSync.ts`, `requireAdmin()`-gated)
→ the shorts API (`INTERNAL_SERVICE_SECRET`,
`services/shorts/internal/services/shorts/jobs_validate.go`):

| Call | Response |
|---|---|
| `POST /api/admin/jobs/validate-sync` `{"stocks":["BHP","DRO"]}` | `202 {executionName, job, region, stocks, args}` |
| `GET  /api/admin/jobs/validate-sync?execution=<name>` | `200 {status:"running"}` while in flight |
| ″ | `200 {status:"succeeded", summary:{…}}` once complete |
| ″ | `200 {status:"failed", message, logUri}` |
| ″ | `502 {error:"summary_not_found", message, status, logUri}` — finished cleanly but published no report; `message` names the missing object |
| either | `400 invalid_stocks` / `400 invalid_execution` / `404 unknown_job` / `409 retired` / `409 not_executable` / `503 not_configured` / `502 validation_failed` |

The request body carries **stock codes and nothing else** — no job name, no
region, no arguments. `jobmonitor.RunValidation` normalises the codes and builds
the argv itself (`["short-data-sync","-shadow","-stocks","BHP,DRO"]`), and the
job it targets is a compile-time constant. There is no path by which caller input
becomes an argv element verbatim.

**The already-running guard does not apply here, on purpose.** "Run now" refuses
a second execution because a real sync writes. A shadow run writes nothing, and
the sync legitimately runs 26–29h — blocking the diagnostic behind it would mean
waiting a day to find out why the data looks wrong. `retired` and `unknown_job`
still refuse.

**Retrieval — a durable GCS artifact, not the logs.** The job writes its whole
summary to

```
gs://$SHORTS_DATA_BUCKET/validations/<execution-name>.json
```

(prod: `shorted-short-selling-data-prod`; dev: `shorted-short-selling-data`) and
the API reads exactly that key. The JSON is passed through **verbatim** — the
schema belongs to the job (`schema_version`), and a translation layer here would
be a second place for it to drift. The job *also* still prints the one-line
`SHORTED_VALIDATION_JSON ` form to stdout, which is what you grep when you are
already in the logs; nothing reads it programmatically.

A still-running execution costs no bucket read. An object that exists but is not
a shadow summary reads as "no report", never as an empty diff. A permission or
transport failure degrades into `message` alongside the execution status rather
than raising.

> **Why not the logs?** The first cut did read them back
> (`logging.logEntries.list`), and it worked — but log access is only grantable
> at the **project** level, and **the CI deploy service account cannot set
> project IAM** (`getIamPolicy` yes, `setIamPolicy` no). The
> `roles/logging.viewer` grant therefore 403'd on *every* `terraform apply` and
> blocked all infrastructure deploys, not just this feature. This is a
> **repo-wide constraint**, and the reason `run.viewer` /
> `cloudscheduler.viewer` are `import` blocks rather than managed resources and
> `run.invoker` / `run.developer` are per-job bindings.
>
> **Do not add a project-level IAM grant to make a feature work.** If a
> capability is only available at project scope, this pipeline cannot deploy it
> — find a resource-scoped alternative. Here that was bucket IAM, which the
> deploy SA can set because it owns the bucket, and which is better anyway: no
> log-retention dependency, no stdout parsing, no newline-splitting fragility.

**IAM — this is the one scoped elevation, plus one bucket read.**

| Binding | Scope | Why |
|---|---|---|
| `google_cloud_run_v2_job_iam_member.shorts_api_validate_sync` → `roles/run.developer` | **`shorts-data-sync` only** | `run.jobs.runWithOverrides` is what makes passing `-shadow -stocks` possible at all. `roles/run.invoker` cannot do it. |
| `google_storage_bucket_iam_member.readers` → `roles/storage.objectViewer` | **the short-selling-data bucket only** | Read the report object back. Granted by the module that OWNS the bucket (`modules/short-data-sync`, `var.reader_service_accounts`) — binding IAM on another module's bucket is what produced the `getIamPolicy` 403 in `modules/report-extractor`. |

What keeps that safe is the **pairing**, not the binding alone: IAM narrows
*where* overrides are possible (one job — nothing else in the fleet becomes
override-able), and the service narrows *what* an override can say (a
server-constructed argv from a validated code list, always containing `-shadow`).
Remove either half and it becomes a real privilege escalation. If the validation
endpoint is ever deleted, delete the binding with it.

> **This needs a `terraform apply` before it works.** Until
> `shorts_api_validate_sync` is applied the POST returns `502 validation_failed`
> (permission denied on `run.jobs.runWithOverrides`); until the bucket reader
> grant and the `SHORTS_DATA_BUCKET` env var are applied the GET returns
> `503 not_configured` or a "could not be read" message.

Every accepted validation writes an audit line, including the argv that actually
ran: `AUDIT jobs/validate-sync actor=… job=… region=… execution=… stocks=… args=…`.

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
