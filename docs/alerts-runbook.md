# Short-interest alerts: operator runbook

The alerts a customer sets up on `/alerts` are evaluated by `shorted alerts`, a VKE
CronJob (`shorted-alerts`, hourly on weekdays at :55 UTC). It is VKE-native: there is no
Cloud Run twin. The code is in `services/jobs/internal/jobs/alerts/`, and its README
covers the design. This runbook covers operating it.

## What a run does, in order

1. Waits (exit 0) while an ASIC sync is running (`sync_status` running, under 2 hours old). Only
   rows the ASIC recorder wrote count: it sets `environment` and `hostname`, and the market-data
   price sweep sets neither, so a price sweep never holds or releases a report.
2. Holds every unevaluated report date (exit 10) while the **latest** sync did not
   complete (`failed`, `partial`, or `running` for over 2 hours). A failed or cancelled
   sync can leave its last report part-written, so the job waits for a completed sync.
3. Plans the new daily dates and the new complete weeks, then evaluates every active
   monitor against them. A date with under half the rows of the report before it is held.
4. Commits the `alert_events` rows and the watermarks in one transaction.
5. Sends the canary when mail is about to go out, or at least every 20 hours. The canary
   checks that Resend accepts mail and that the one-click pause link verifies end to end.
7. Sends the queued customer emails, one per event, rate-limited.

The exit codes are 0 (success, nothing to do, a sync in progress, a bootstrap, or a dry
run), 1 (configuration, database, an entitlement lookup that did not answer, a canary that is
rejected or whose pause link does not verify, or a Resend credential failure) and 10
(DEGRADED: a held date, an email still retrying or failed, or Resend's quota spent). Telesis
pages on any non-zero exit.

## Reading the log

The summary line ends each run:

```
alerts: dates=[...] weekly=... monitors=N candidates=N events=N vanished=N sent=N retrying=N failed=N
  skipped_unentitled=N skipped_no_email=N canary=ok|skipped|failed exit=N [note="..."]

`vanished` counts events whose monitor was deleted after the run read it. Those rows are
skipped, and the rest of the run commits. A deleted monitor never fails a run.
```

- `note="bootstrap"`: the first run only. It sets the watermarks to the newest data and
  evaluates nothing, so no backlog of old alerts goes out. Its line reads
  `dates=[] ... canary=ok exit=0`. The `bootstrap:` line before it confirms the watermarks.
- `note="held YYYY-MM-DD"`: the job is holding that date. A line before it says why: an
  incomplete report (a short row count) or the latest ASIC sync not completing.
- `dry run: nothing written, nothing sent`: `ALERTS_DRY_RUN` is not `false`. The CronJob
  sets it; a hand run with nothing set is dry.

Addresses, tokens, rendered bodies and subjects are never logged, except dry-run subjects,
which carry a ticker and figures only.

## Before merge

Run these from the PR branch checkout, with the ordinary prod-ops credentials:

```bash
export KUBECONFIG=~/projects/paprika/terraform/omega.kubeconfig
export CLOUDSDK_CORE_ACCOUNT=ben@shorted.com.au
# 1. Secrets. The PR adds RESEND_API_KEY, INTERNAL_SERVICE_SECRET and UNSUBSCRIBE_SECRET.
deploy/kubernetes/jobs/scripts/sync-secrets.sh               # plan: the three keys listed, none MISSING
CONFIRM=prod deploy/kubernetes/jobs/scripts/sync-secrets.sh  # writes shorted-jobs-env
# 2. Telesis monitor and its check-in URL in shorted-jobs-cron-monitors.
telesis login
deploy/kubernetes/jobs/scripts/register-monitors.py          # plan: create "shorted-alerts"
CONFIRM=prod deploy/kubernetes/jobs/scripts/register-monitors.py
```

Registering the monitor before merge is safe: a Telesis monitor is not armed until its
first check-in. Without step 1 the pod fails with `CreateContainerConfigError` on every
run. Without step 2 the reporter logs `no check-in URL ... NOT monitored`.

## After merge

1. Watch `terraform-deploy`. The migration step applies `000147`, `terraform apply` swaps
   the API, and `bump-vke-jobs-image` promotes the chart.
2. Check the CronJob is live. It should show `SUSPEND False`:

   ```bash
   kubectl -n shorted-jobs get cronjob shorted-alerts
   ```

3. Run it once by hand. Expect a `bootstrap` note and `canary=ok`. If a scheduled run
   already bootstrapped, the hand run logs `nothing to do` with no canary, so check the
   scheduled run's log, or the newest run row:

   ```bash
   kubectl -n shorted-jobs create job shorted-alerts-manual-$(date +%s) --from=cronjob/shorted-alerts
   kubectl -n shorted-jobs logs job/shorted-alerts-manual-...
   ```

   ```sql
   SELECT note, outcome, canary_resend_id FROM alert_evaluator_runs ORDER BY id DESC LIMIT 1;
   ```

## Prod smoke test

This is the check that alerts work end to end. It sends one real alert, to a test
account you control, on a report date that is known to have crossed a level.

1. On a Premium account, create a stock monitor in `/alerts` for a code that crossed a level on
   a known recent report date `D`.
2. Replay that date for this user only. `kubectl create job --from` cannot override args, so
   render the Job, patch its args and apply it:

   ```bash
   kubectl -n shorted-jobs create job alerts-replay-$(date +%s) --from=cronjob/shorted-alerts --dry-run=client -o yaml \
     | yq '.spec.template.spec.containers[0].args = ["alerts","-date","<D>","-user","<uid>","-canary","off"]' \
     | kubectl apply -f -
   ```

   A replay never moves a watermark, and it evaluates daily monitors only.
3. Confirm the email arrives with the right figures, links and headers.
4. Click "Pause this alert" and check that `/alerts` shows Paused.
5. Check that `/alerts` "Recent alerts" shows "Emailed".
6. Delete the test monitor.

## Troubleshooting

**A date is held, and the log says `report ... is held: the latest ASIC sync did not complete`.**
Look at the latest ASIC `sync_status` row (the one with `environment` and `hostname` set). Once a sync completes, the next run
evaluates the held dates. Do not hand-edit the watermark. A sync that stays failed holds
alerts, and that is the intended outcome: it pages until the sync is fixed.

**`entitlement lookup failed (CODE): nothing was committed, the next run retries`.** The shorts
API did not give a definitive answer for an owner, whether the whole API was down or that one
owner's lookup errored (`resource_exhausted`, `not_found`, `permission_denied`, `internal`, and
so on). No event is written, the watermarks stay, no email goes out, and the run exits 1. Nothing
is ever committed as unentitled or waiting because a lookup failed. Look up the code in the log
and in the API's logs for the owner's request. Once the lookup answers, the next run evaluates
the same dates. A lookup that keeps failing pages Telesis until it is fixed, by design.

**`alert one-click pause failed: invalid` in the web logs, or `pause link round trip` in the job.**
The one-click pause path does not verify. The usual cause is that `UNSUBSCRIBE_SECRET` was
rotated in Secret Manager and the job's copy was not refreshed. The canary fails on the
round trip, and no customer mail goes out until it verifies. Fix: rotating a secret takes two
steps. Re-run `CONFIRM=prod deploy/kubernetes/jobs/scripts/sync-secrets.sh` so the job reads the new
value from `shorted-jobs-env`, and roll a new shorts API revision (re-run `terraform-deploy`, or force
one). Cloud Run resolves `latest` only when a revision starts, so until a new revision rolls out the
API still holds the old value. Links already sent stop working when the secret rotates.

**Customer reports no email.** Check, in order: the monitor's status (paused alerts do not
send); whether the owner has a verified address (an unverified sign-up's monitors are recorded
but not emailed, and `/alerts` says so); the owner's subscription (an unentitled owner's events
are `skipped_unentitled`); and the event's `email_status` and `last_error`:

```sql
SELECT id, monitor_id, report_date, email_status, last_error, sent_at
  FROM alert_events WHERE user_id = '<uid>' ORDER BY report_date DESC LIMIT 20;
```

**Resend credential or quota failures.** A credential failure stops the run with exit 1 and
returns the claimed rows to `pending` without using an attempt. A quota failure leaves the
rest `pending` and exits 10. Both resume on the next run.

## Rules to keep

- The dry run is the default. Only `ALERTS_DRY_RUN=false` or `-dry-run=false` writes.
- `SHORTS_API_URL` must be the Cloud Run origin, not `api.shorted.com.au`. A lookup through
  Cloudflare lands in the anonymous per-IP bucket.
- The entitlement rule is the API's `ResolveEntitlement`, and the job maps `ACTIVE` and
  `TRIALING` to entitled. The contract test in `services/shorts` fails if the two disagree.
- The job's entitlement lookups are exempt from the owner's per-user rate limit, only when
  the internal secret matches and the user agent is `shorted-alerts/`. An owner at their quota
  does not stop their own alert.
- `SHORTS_API_URL` and `INTERNAL_SERVICE_SECRET` are required for every run, dry runs included.
  `SHORTS_API_URL` is validated after trimming: an empty value, `/`, a relative path or a URL
  without a host fails at startup. A run never evaluates entitlement against no origin.
- Rotating `UNSUBSCRIBE_SECRET` invalidates newsletter and alert links alike. Rotate it in
  Secret Manager, re-run `sync-secrets.sh`, and roll a new shorts API revision. The API reads
  `latest` only when a revision starts.
- The job's `INTERNAL_SERVICE_SECRET` is an admin-grade credential, not a database one. It
  passes the admin middleware on `/api/admin/*`, including the broadcast send. Treat a leak of
  `shorted-jobs-env` as a leak of the newsletter sender and of the API's internal identity.
