# Production data corrections

One-off corrections to production rows: not migrations (they change data, not schema), so they are not in
`services/migrations/` and not in its ledger (`PROD_APPLIED.md` holds migrations only). Each file is applied once,
by hand, with `task db:prod:apply FILE=scripts/data-fixes/<file> CONFIRM=prod` (one transaction). A file must match
every row it changes on its current values and abort on any mismatch, and the rows it changes are backed up in full
before it runs.

| File | Applied | By | What and how it was verified |
|---|---|---|---|
| `2026-11-08-stock-prices-bad-bars.sql` | 2026-11-08 14:01:37 UTC | Claude, via `task db:prod:apply CONFIRM=prod` | Deleted 51 `stock_prices` bars that are not the ASX listing's prices: SLM x3 (NASDAQ SLM Corp's bars, 2025-11-25/26 and 2025-12-24), ENX x37 (0.01-0.02 on the last session before each market closure, 2023-11-03 to 2025-04-04, chosen against each bar's ±6-session median), HRZ x4, BMO x1, and six one-day unit-split artefacts (IVV, IJH x2, IJP, BBUS x2). Before: all 51 matched on code, date and close; full rows backed up as JSON in PR #934's thread. After: `select count(*)` over the 51 (code, date) pairs returned 0. Cause and guard: PR #934. |
