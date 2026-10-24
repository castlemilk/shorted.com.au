# Short-interest alerts: operator runbook

The alerts a customer sets up on `/alerts` are evaluated by `shorted alerts`, a VKE
CronJob (`shorted-alerts`, hourly on weekdays at :55 UTC). It is VKE-native: there is no
Cloud Run twin. The code is in `services/jobs/internal/jobs/alerts/`, and its README
covers the design. This runbook covers operating it.

## What a run does, in order

1. Waits (exit 0) while an ASIC sync is running (`sync_status` running, under 2 hours old).
2. Holds every unevaluated report date (exit 10) while the **latest** sync did not
   complete (`failed`, `partial`, or `running` for over 2 hours). A failed or cancelled
   sync can leave its last report part-written, so the job waits for a completed sync.
3. Plans the new daily dates and the new complete weeks, then evaluates every active
   monitor against them. A date with under half the rows of the report before it is held.
4. Commits the `alert_events` rows and the watermarks in one transaction.
5. Resolves owners whose entitlement lookup failed on an earlier run (`awaiting_entitlement`).
6. Sends the canary when mail is about to go out, or once a day. The canary checks that
   Resend accepts mail and that the one-click pause link verifies end to end.
7. Sends the queued customer emails, one per event, rate-limited.

The exit codes are 0 (success, nothing to do, a sync in progress, a bootstrap, or a dry
run), 1 (configuration, database, a transport-wide entitlement failure, a canary that is
rejected or whose pause link does not verify, or a Resend credential failure) and 10
(DEGRADED: a held date, an email still retrying or failed, alerts awaiting an entitlement
lookup, or Resend's quota spent). Telesis pages on any non-zero exit.

## Reading the log

The summary line ends each run:

```
alerts: dates=[...] weekly=... monitors=N candidates=N events=N sent=N retrying=N failed=N
  skipped_unentitled=N skipped_no_email=N awaiting=N canary=ok|skipped|failed exit=N [note="..."]
```

- `note="bootstrap"`: the first run only. It sets the watermarks to the newest data and
  evaluates nothing, so no backlog of old alerts goes out. Its line reads
  `dates=[] ... canary=ok exit=0`. The `bootstrap:` line before it confirms the watermarks.
- `note="held YYYY-MM-DD"`: the job is holding that date. A line before it says why: an
  incomplete report (a short row count) or the latest sync not completing.
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
Look at the latest `sync_status` row. Once a sync completes, the next run
evaluates the held dates. Do not hand-edit the watermark. A sync that stays failed holds
alerts, and that is the intended outcome: it pages until the sync is fixed.

**`N alert(s) waiting on an entitlement lookup`.** One owner's lookup failed for that owner alone,
such as a per-user error from the shorts API. Their events wait as `awaiting_entitlement`
and are re-checked on every run. They expire after 48 hours. Nobody else is held back.

**`alert one-click pause failed: invalid` in the web logs, or `pause link round trip` in the job.**
The one-click pause path does not verify. The usual cause is that `UNSUBSCRIBE_SECRET` was
rotated in Secret Manager and the job's copy was not refreshed. The canary fails on the
round trip, and no customer mail goes out until it verifies. Fix: after rotating a secret,
re-run `CONFIRM=prod deploy/kubernetes/jobs/scripts/sync-secrets.sh`, then the API picks up
the new value. The API reads `latest`, and the job reads its copy from `shorted-jobs-env`.

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
- Rotating `UNSUBSCRIBE_SECRET` invalidates newsletter and alert links alike. Rotate it in
  Secret Manager, then re-run `sync-secrets.sh`.
