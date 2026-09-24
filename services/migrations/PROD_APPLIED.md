# Prod migration ledger

**Prod does not run `migrate up`.** The deploy applies a hardcoded allowlist in
`.github/workflows/terraform-deploy.yml` and then force-writes
`schema_migrations` to version 75:

```sql
DELETE FROM schema_migrations; INSERT INTO schema_migrations (version, dirty) VALUES (75, false);
```

So the database cannot tell you what it has. `schema_migrations` is not merely
stale, it is deliberately meaningless — every deploy resets it to the same
number regardless of what ran. This file is the only record.

## The two ways a migration reaches prod

**Allowlisted** — listed as `-f /migrations/<file>` in `terraform-deploy.yml`.
The deploy **replays it on every run**, so an allowlisted migration MUST be
replay-safe: every statement `IF NOT EXISTS` / `CREATE OR REPLACE`, no bare
`ADD COLUMN`, no `INSERT` without `ON CONFLICT`, and no `DROP … CREATE` of a
materialized view. `000112_add_api_usage_monthly` is the worked example — every
statement guarded, touches no rows.

Most existing housing migrations are **not** replay-safe and must never be added
here: `000086`, `000090`, `000092`, `000054` and others drop and recreate
materialized views, which would rebuild them on every deploy; `000105` inserts
without `ON CONFLICT` and would duplicate rows.

**Hand-applied** — run by an operator with `task db:prod:apply FILE=…
CONFIRM=prod` (session pooler 5432, one transaction, `SET LOCAL
statement_timeout = 0`), then recorded below. Entries before 2026-09-24 were
applied with `PGOPTIONS="-c statement_timeout=0"`, which Supavisor drops: they
ran under the role's 2-minute default and happened to fit.

## Baseline

Everything up to and including **`000115`** predates this ledger and is
grandfathered. That is not a claim they are all applied — it is an explicit
statement that their status was never recorded and reconstructing it would mean
auditing 114 files against prod. The guard
(`scripts/tests/migration-drift.test.mjs`) therefore enforces only migrations
**after** the baseline, so drift stops accumulating from here rather than
demanding a retro-audit nobody will finish.

If you do audit a pre-baseline migration, add it under "Applied by hand" with
the date and how you verified it, and it stops being grandfathered.

```
BASELINE: 000115
```

## Applied by hand

One row per migration. `Verified` should say how you know — the query you ran,
not "ran it".

| Migration | Date | By | Verified |
|---|---|---|---|
| `000083_add_state_exposure` | pre-2026-08-29 | (historical) | Removed from the replayed allowlist 2026-08-29. Prod confirmed to hold all three objects it creates: `mv_company_state_exposure` (`pg_matviews`), `idx_mv_company_state_exposure_region_weight` (`pg_indexes`), and `refresh_all_materialized_views` in its **hardened** form (`pg_proc.prosrc ILIKE '%query_canceled%'`). Recorded here because it is applied but no longer replayed. |
| `000122_add_suburb_hazard_exposure` | 2026-09-09 | Claude (session 01QaKEGrZewvHZ3QnSsYu7ey), via `task db:prod:apply CONFIRM=prod` | `to_regclass('public.suburb_hazard_exposure')` non-null; `pg_constraint` lists `suburb_hazard_exposure_share_bounds_check`, `suburb_hazard_exposure_licence_check` and the PK/FK; `CREATE TABLE` + `CREATE INDEX` echoed by psql. Also allowlisted (replay-safe). |
| `000124_housing_drops_recency` | 2026-09-24 | Claude, via `task db:prod:apply CONFIRM=prod` (`scripts/prod-psql.sh`, one transaction, `SET LOCAL statement_timeout=0`) | psql echoed the 4 MV drop/recreate/`CREATE INDEX` blocks, `CREATE TABLE housing_mv_refresh`, `CREATE FUNCTION`, `UPDATE 2872` (suburb index medians under k=3 withheld) and `COMMIT`. Read-only check afterwards: `housing_mv_refresh` has 4 rows (refreshed 2026-09-24 01:57 UTC, data_through 2026-09-15 01:46); `mv_state_price_drops` has `suburbs_swept_14d`/`catalog_suburbs` (AU 173/500); `refresh_housing_materialized_views()` has 19 `query_canceled` guards and `proconfig {statement_timeout=0}`. |
| `000125_add_suburb_planning` | 2026-09-24 | Claude, via `task db:prod:apply CONFIRM=prod` | `to_regclass('public.suburb_planning')` non-null; 7 constraints on it in `pg_constraint` (PK/FK, licence and share-bound CHECKs); `CREATE TABLE` + `CREATE INDEX` echoed. |
| `000126_council_foundation` | 2026-09-24 | Claude, via `task db:prod:apply CONFIRM=prod` | All 12 new `lga` columns present in `information_schema.columns`; `suburb_lga.dominant_share` present; `idx_lga_state_slug` in `pg_indexes`; `lga_series` exists with 3 constraints. |
