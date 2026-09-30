# Scheduled jobs on Kubernetes (omega VKE, via Paprika)

Shorted's scheduled batch jobs run as Kubernetes CronJobs on the omega Vultr VKE
cluster. Paprika delivers them, and Telesis cron monitors alert on them. They
replace Cloud Scheduler → Cloud Run Jobs, one job at a time.

```
 git main ──poll 60s──▶ Paprika Application `shorted-jobs` (ns shorted-jobs)
                          │ renders deploy/kubernetes/jobs/chart
                          ▼
             21 CronJobs ─┬─ Job/pod ── DB (Supabase), APIs, GCS via keyless WIF
                          │
      cronjob-reporter ◀──┘ watches Jobs, POSTs start / complete / fail
             │                (exit code, OOMKilled / DeadlineExceeded, log tail)
             ▼
   Telesis cron monitors ── failed · missed · timed out ──▶ email alert
```

## Layout

| Path | What |
|---|---|
| `chart/values.yaml` | Every job: image, args, env, secrets, schedule, timeout, retries. Mirrors its Cloud Run job in `terraform/environments/prod/main.tf` |
| `chart/templates/cronjobs.yaml` | One Indexed CronJob per job, with Cloud Run env parity (`CLOUD_RUN_EXECUTION`, `CLOUD_RUN_TASK_ATTEMPT`, …) |
| `chart/templates/reporter.yaml` | `shorted cronjob-reporter` Deployment, RBAC, and the health Service |
| `chart/templates/identity.yaml` | Default ServiceAccount, plus one WIF ServiceAccount and credential config per Google SA |
| `chart/tests/render.sh` | Render contract, run in CI by `repo-hygiene.yml` |
| `paprika/application.yaml` | The Paprika Application, applied by hand once |
| `scripts/bootstrap.sh` | Namespace, Artifact Registry pull secret, WIF pool/provider and bindings |
| `scripts/sync-secrets.sh` | Secret Manager → `shorted-jobs-env` |
| `scripts/register-monitors.py` | Telesis service, monitors, alerts → `shorted-jobs-cron-monitors` |
| `scripts/bump-image-tag.sh` | Called by CI after each main deploy |
| `services/jobs/internal/jobs/cronreporter/` | The reporter's source |

## What moved, what stayed

Every **scheduled** Cloud Run job has a CronJob. One Cloud Run job with several
Cloud Scheduler triggers becomes several CronJobs. `shorted-news` has five
triggers, so it has five CronJobs, and each gets its own Telesis monitor.

These stay on Cloud Run, because something other than a clock starts them:

| Job | Started by |
|---|---|
| `shorted-news-publish` | `POST /api/admin/news/publish` (shorts API, argv override) |
| `shorted-economy-freshness` | `.github/workflows/economy-freshness.yml` |
| `influence-collector` register modes | `.github/workflows/register-freshness.yml`, operators |
| `shorts-data-sync` validation runs | `GET /api/admin/jobs/validate-sync` |
| `shorted-price-sync` catch-ups / re-fetches | `.github/workflows/price-sync.yml` |
| `shorted-picks` other modes | admin MCP `run_picks_job` |
| any job, "Run now" | `/admin` Jobs page |

The Cloud Run jobs are **not deleted** when a schedule moves. Only their Cloud
Scheduler trigger is paused, so all of the above keeps working, and rollback
is a one-line revert.

## Monitoring: who catches what

Every chart job has a Telesis cron monitor, wherever it runs:

- **Live on omega** (in `enabled`): the reporter watches the Kubernetes Job.
- **Still on Cloud Run**: the reporter lists the Cloud Run job's executions
  (`-cloudrun-config`, rendered from each job's `cloudRun` mapping) through a
  keyless read-only identity, `vke-cronjob-reporter`, which has job-level
  `roles/run.viewer` from Terraform. An execution counts only when its
  effective args (and the env a schedule overrides, such as `REPORT_TYPE`)
  match the monitor exactly. Ad hoc runs are ignored rather than paged on:
  operator re-fetches, validation runs, freshness checks.

A cutover moves a job's reporting from Cloud Run to Kubernetes
automatically. **Keep `args` in `values.yaml` identical to the Cloud Run
job's.** A drifted job's runs no longer match, so its monitor pages as MISSED.
That is loud, but it is a false alarm.


| Failure | Caught by |
|---|---|
| Non-zero exit, crash | reporter → `fail` (exit code + reason + log tail) |
| OOMKilled | reporter → `fail` (`container exited 137 (OOMKilled)`) |
| Per-attempt timeout (`activeDeadlineSeconds`) | reporter → `fail` (`pod DeadlineExceeded`) |
| Image pull failure, pod never scheduled | reporter → `fail` at the Job-level deadline (timeout × attempts + 5 min); Telesis **timed out** is the backstop |
| CronJob suspended by mistake, controller down, cluster down | Telesis **missed** after schedule + 30 min grace |
| Reporter dead or unable to list Jobs | Telesis **missed** on the next job, plus the `cronjob-reporter heartbeat` monitor (10 min) |
| Manual `kubectl create job --from=cronjob/x` | reported like a scheduled run |

Each monitor has one alert, "consecutive failures ≥ 1", sent to
`monitoring.telesis.alertEmail`.

**Not caught, unlike Cloud Run.** The GCP `job_log_errors` policy also fired
on any ERROR log line from a run that exited 0. Kubernetes has no such signal.
A job that logs an error but exits 0 now reports success. Make such paths exit
non-zero (the `runner.ExitCodeError` pattern, e.g. exit 10 = degraded) if they
should page. The GCP policies still cover Cloud Run executions, which are now
only the manual and API-started runs.

## First-time setup

Do these in order. Each step is idempotent and prints a plan unless
`CONFIRM=prod` is set.

```bash
export KUBECONFIG=~/projects/paprika/terraform/omega.kubeconfig
export CLOUDSDK_CORE_ACCOUNT=ben@shorted.com.au

# 1. Namespace, pull secret, WIF (pool vke-omega / provider omega in rosy-clover)
deploy/kubernetes/jobs/scripts/bootstrap.sh              # read the plan
CONFIRM=prod deploy/kubernetes/jobs/scripts/bootstrap.sh

# 2. Runtime secrets (keys derived from the chart; refuses if any is missing)
CONFIRM=prod deploy/kubernetes/jobs/scripts/sync-secrets.sh

# 3. The Paprika Application (every CronJob renders suspended)
kubectl apply -f deploy/kubernetes/jobs/paprika/application.yaml
kubectl -n shorted-jobs get application shorted-jobs -w      # wait for Healthy

# 4. Telesis monitors, alerts, and check-in URLs (needs a user session)
telesis login
CONFIRM=prod deploy/kubernetes/jobs/scripts/register-monitors.py

# 5. Keep chart image tags in step with each main deploy
gh variable set VKE_JOBS_IMAGE_BUMP --body true --repo castlemilk/shorted.com.au
```

Check WIF before cutting over a GCS-writing job (`financial-report-extractor`,
`asx-discovery`, `shorted-price-sync`):

```bash
kubectl -n shorted-jobs create job wif-check --from=cronjob/asx-discovery  # runs the real job
```

## Cutting a job over

Cut over one PR per job or small batch. The change is two lists that
`scripts/tests/vke-jobs-cutover.test.mjs` forces to be equal:

1. Add the CronJob name to `enabled:` in `chart/values.yaml`, and set
   `suspendAll: false` if it is the first.
2. Add the same name to `local.jobs_on_vke` in
   `terraform/environments/prod/main.tf`.
3. Merge. `terraform-deploy` pauses the Cloud Scheduler trigger, then moves
   the `deploy/vke-jobs` branch, and only then does Paprika unsuspend the
   CronJob. If the deploy fails, nothing changes on the cluster; re-run it.
4. After the first scheduled run, check the monitor is **Healthy** in Telesis.
   Then compare the run's effect with a recent Cloud Run run (row counts, the
   job's own report).

Start with something cheap and frequent, like `shorted-news-cluster` (every
2h) or `shorted-index-sync`. Leave the paid LLM jobs and the 6h
`influence-collector-monthly` until a few have run cleanly.

**Rollback:** remove the name from both lists and merge. The Cloud Scheduler
trigger resumes and the CronJob suspends.

**Emergency stop, everything, now** (no merge needed; Paprika keeps it until
the parameter is removed):

```bash
kubectl -n shorted-jobs patch application shorted-jobs --type merge \
  -p '{"spec":{"parameters":{"suspendAll":"true"}}}'
```

This stops the CronJobs only. Cloud Scheduler stays paused for cut-over jobs,
so run them on Cloud Run from `/admin` until one of the two is resumed.

## Operating

```bash
kubectl -n shorted-jobs get cronjobs                           # schedule, suspend, last run
kubectl -n shorted-jobs get jobs -L shorted.com.au/cronjob     # runs + reporter annotations
kubectl -n shorted-jobs logs job/<job-name>                    # a run's logs
kubectl -n shorted-jobs create job <name>-manual-$(date +%s) --from=cronjob/<name>   # run now
kubectl -n shorted-jobs logs deploy/cronjob-reporter           # what was reported
```

- **Logs** stay in the cluster for the last 3 successful and 5 failed runs per
  CronJob. There is no Cloud Logging for scheduled runs any more. A failure's
  last 60 lines, redacted, travel with its Telesis alert. The Go jobs still
  export OTel to Grafana Cloud.
- **Rotating a secret:** update Secret Manager, then re-run `sync-secrets.sh`.
  The next run reads it at pod start.
- **Cluster signing-key rotation** breaks WIF (`invalid_grant`), because the
  provider holds an uploaded JWKS. Fix with
  `ONLY=wif CONFIRM=prod scripts/bootstrap.sh`.
- **A Job annotated `shorted.com.au/checkin-end: rejected-404`** means Telesis
  no longer knows that check-in URL (monitor deleted or token rotated). Re-run
  `register-monitors.py`, which mints a new URL for any monitor missing from the
  Secret.

## Landmines

- **Two sources of truth while both exist.** Until a job's Cloud Run
  definition is retired, a change to its args, env, timeout or schedule must be
  made in `values.yaml` **and** Terraform. `render.sh` catches schedule drift
  only. `main` moved the financial-report extractor to daily, 120 filings and 4
  workers while this chart was being written, which is how this was found.
- **Cloud Run env is emulated, not inherited.** `CLOUD_RUN_EXECUTION` is the
  Job name, which is short-data-sync's resume key and price-sync's report key.
  `CLOUD_RUN_TASK_ATTEMPT` is the Indexed Job's
  `batch.kubernetes.io/job-index-failure-count` (0, 1, 2…, verified on 1.36),
  and picks and price-sync shrink a retry's budget on it. That is why the Jobs
  are `completionMode: Indexed` with `backoffLimitPerIndex`. Do not "simplify"
  them to a plain `backoffLimit`: the attempt number would silently become
  empty.
- **Admin surfaces read Cloud Run.** The `/admin` Jobs page, `price-sync.yml
  report_only=latest` and `shorts-data-repair.yml` list Cloud Run executions.
  They will not see a CronJob run. Telesis run history is the record for
  scheduled runs.
- **Telesis project tokens (`upk_…`) cannot register monitors.** The cron RPCs
  check a user's org role, and a project token is a synthetic user with none.
  Use `telesis login`.
- **`prune: true`.** Deleting a job from `values.yaml` deletes its CronJob.
  That is intended. Remove it from `enabled`/`jobs_on_vke` in the same PR, and
  resume or delete its Cloud Scheduler trigger deliberately.
- **No automatic rollback.** The Application self-heals drift but does not
  roll back on a failed health check. The first rollout proved why: its
  pinned image predated `cronjob-reporter`, and every newer release was
  applied and reverted to that broken snapshot in the same second until the
  retry budget ran out. Fix a bad chart forward with a commit. If Paprika has
  parked the app (`ReleaseRetriesExhausted`), run
  `kubectl -n shorted-jobs annotate applications.pipelines.paprika.io shorted-jobs paprika.io/manual-sync=$(date +%s) --overwrite`.
- **Paprika tracks `deploy/vke-jobs`, not `main`.** CI force-pushes it
  after each successful Terraform apply: the applied commit plus one commit
  setting that deploy's image tags. Image tags in `values.yaml` on main are
  therefore stale by design. Never push to that branch by hand except to
  recover; a hand push that runs ahead of Terraform re-creates the double-run
  window this design closes.
- **Image tags are immutable `main-<sha8>`.** Until `VKE_JOBS_IMAGE_BUMP=true`,
  the pinned tag is whatever the chart was committed with. Enable the bump
  before the first cutover.
