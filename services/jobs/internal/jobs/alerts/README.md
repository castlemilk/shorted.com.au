# `shorted alerts`

The evaluator behind the short-interest alerts a customer creates on `/alerts`.
Each run turns each new ASIC report date into one `alert_events` row per firing
monitor, checks the owner's entitlement, and emails entitled owners through Resend.

Runs as the VKE CronJob `shorted-alerts` (`deploy/kubernetes/jobs/chart/values.yaml`),
hourly on weekdays at :55 UTC. It is VKE-native, with no Cloud Run twin. The
Telesis monitor is registered with `scripts/register-monitors.py`. The operator
runbook, which covers the prod smoke test, is `docs/alerts-runbook.md`.

## Modes

- **Dry run is the default.** A hand run writes nothing and sends nothing. The CronJob
  sets `ALERTS_DRY_RUN=false`. Only that, or `-dry-run=false`, writes. A hand run still needs
  `SHORTS_API_URL` and `INTERNAL_SERVICE_SECRET`, because it asks the shorts API for each
  owner's entitlement, and it fails at startup without them.
- **Replay**: `-date YYYY-MM-DD [-user UID]` evaluates daily monitors for one report
  date. It never moves a watermark. It is the prod smoke test's tool (see the runbook).
- **Canary**: `-canary auto` (the default) sends a canary to `ALERTS_CANARY_TO`
  (`delivered@resend.dev`) at least every 20 hours, and also before any customer mail in a run. The
  canary also checks the one-click pause path: its token must reach the API and come back
  NotFound. A rejected canary, or a pause link that does not verify, stops the run with exit 1
  before a customer email goes out.

## Readiness and holds

- A sync in progress (an ASIC `sync_status` row running, under two hours old) makes the run exit 0 and
  wait.
- The newest sync must have **completed**. A failed, partial, or unfinished sync can leave its
  last report part-written, so every unevaluated date is held (exit 10) until a completed sync
  lands. The job does not evaluate a half-written date.
- A date with under half the rows of the report before it is held the same way.
- A weekly comparison never reads a held date. A week is compared once, by ISO week, even when a
  late report lands in it.

## Owners and lookups

- The entitlement lookup is one `GetMySubscription` call per owner per run, through the API's
  internal-auth path. It is **exempt** from the owner's per-user rate limit: the API exempts the
  call only when the internal secret matches and the user agent is `shorted-alerts/`. An owner
  at their monthly quota does not stop their own alert.
- **An answer counts only when the lookup succeeds.** `ACTIVE` and `TRIALING` are entitled.
  Any other successful answer (no subscription, `CANCELED`, `INACTIVE`, and so on) is not
  entitled, and its events are `skipped_unentitled`. Any error fails the run before anything is
  committed, whether the whole API is unreachable or one owner's lookup errored
  (`resource_exhausted`, `not_found`, `permission_denied`, `internal`, and so on). No event is
  written, the watermarks stay, no email goes out, and the run exits 1. The next run retries the
  same dates. Nothing is committed as "unentitled" or "waiting" because a lookup failed.

## Side effects

- **The job holds `INTERNAL_SERVICE_SECRET`, and that is far more than `DATABASE_URL`.** On its
  own, the secret passes the admin middleware for every `/api/admin/*` HTTP endpoint, including
  the broadcast send that emails every newsletter subscriber. It also lets a caller act as any
  user on the Connect methods, with admin granted through `x-user-roles`. The same namespace
  holds `RESEND_API_KEY`, so a leaked `shorted-jobs-env` Secret can send arbitrary mail from
  shorted.com.au. Narrowing this is a follow-up: a credential the internal branch accepts only
  for `BillingService.GetMySubscription`, and a Resend key limited to sending on shorted.com.au.
- **Entitlement is the API's rule, not a copy of it.** The job maps `ACTIVE` and `TRIALING` to
  entitled (`entitlement.go`). The contract test
  `services/shorts/internal/services/shorts/subscriptions_entitlement_contract_test.go` fails if
  the API's `ResolveEntitlement` stops agreeing.
- **Rotating `UNSUBSCRIBE_SECRET` invalidates alert and newsletter links alike, and takes two
  steps.** Cloud Run resolves a `latest` secret only when a revision starts, so the shorts API keeps
  the old value until a new revision rolls out. The job reads its copy from `shorted-jobs-env`,
  which `sync-secrets.sh` writes. Rotate, re-run `CONFIRM=prod deploy/kubernetes/jobs/scripts/sync-secrets.sh`,
  and roll a new API revision (re-run `terraform-deploy`, or force one). Until both are done, the
  canary's pause round trip fails and customer mail is held. Links already sent stop working.

## The summary line

Each run ends with one line: `alerts: dates=[...] weekly=... monitors=N candidates=N events=N
vanished=N sent=N retrying=N failed=N skipped_unentitled=N skipped_no_email=N canary=... exit=N`.
`vanished` counts events whose monitor was deleted after the run read it: they are skipped, and
the rest of the run commits. A replay names its owner in the log only under `-verbose`; the run
row keeps the owner for the operator's record. Addresses, tokens and bodies are never logged.

## Tests

- `GOWORK=off go test ./internal/jobs/alerts/` from `services/jobs` runs the unit tests
  (evaluation, planning, holds, email goldens, config, entitlement, delivery).
- The end-to-end suites run `run()` against a real Postgres, the real 000074 and 000147
  migrations, a Resend stub, and a BillingService and AlertsService stub. They are skipped
  without `ALERTS_TEST_DATABASE_URL`. `make test-alerts-e2e` in `services/` starts a throwaway
  `postgres:15-alpine` for them, runs the shorts API's alert store integration tests against the
  same server, and the deploy gate runs it as its own step.
  - `e2e_pg_test.go` covers the lifecycle and every hold.
  - `e2e_hardening_pg_test.go` covers every failed lookup (the run fails closed), a monitor
    deleted after the read, a weekly week beside a held day, and a pause link that does not verify.
  - `e2e_binary_pg_test.go` runs the real binary with its real flags and exit codes.
- To update the email goldens after an intended wording change:
  `go test ./internal/jobs/alerts/ -run TestEmailGoldens -args -update`.
