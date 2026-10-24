# `shorted alerts`

The evaluator behind the short-interest alerts a customer creates on `/alerts`.
Each run turns each new ASIC report date into one `alert_events` row per firing
monitor, checks the owner's entitlement, and emails entitled owners through Resend.

Runs as the VKE CronJob `shorted-alerts` (`deploy/kubernetes/jobs/chart/values.yaml`),
hourly on weekdays at :55 UTC. It is VKE-native, with no Cloud Run twin. The
Telesis monitor is registered with `scripts/register-monitors.py`.

## Modes

- **Dry run is the default.** A hand run with nothing set writes nothing and sends
  nothing. The CronJob sets `ALERTS_DRY_RUN=false`. Only that, or `-dry-run=false`,
  writes.
- **Replay**: `-date YYYY-MM-DD [-user UID]` evaluates daily monitors for one report
  date. It never moves a watermark. The smoke test in the alerts runbook uses it.
- **Canary**: `-canary auto` (the default) sends a canary to `ALERTS_CANARY_TO`
  (`delivered@resend.dev`) once a day, and also before any customer mail in a run.
  A rejected canary stops the run with exit 1 before a customer email goes out.

## Side effects

- **Entitlement lookups are metered.** Each owner with an email costs one
  `GetMySubscription` call per evaluated date, through the API's internal-auth path,
  so it counts against that user's API quota (about 22 a month for a daily monitor).
- **The job holds `INTERNAL_SERVICE_SECRET`.** That secret opens the shorts API's
  internal-auth path. The blast radius is the same as the `DATABASE_URL` this
  namespace already holds.
- **Entitlement is the API's rule, not a copy of it.** The job maps `ACTIVE` and
  `TRIALING` to entitled (`entitlement.go`). The contract test
  `services/shorts/internal/services/shorts/subscriptions_entitlement_contract_test.go`
  fails if the API's `ResolveEntitlement` stops agreeing.

## Tests

- `GOWORK=off go test ./internal/jobs/alerts/` from `services/jobs` runs the unit
  tests (evaluation, planning, email goldens, config, entitlement, delivery).
- The end-to-end suite (`e2e_pg_test.go`) runs `run()` against a real Postgres, the
  real 000074 and 000147 migrations, a Resend stub and a BillingService stub. It is
  skipped without `ALERTS_TEST_DATABASE_URL`. `make test-alerts-e2e` in `services/`
  starts a throwaway `postgres:15-alpine` for it.
- To update the email goldens after an intended wording change:
  `go test ./internal/jobs/alerts/ -run TestEmailGoldens -args -update`.
