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

The other replay-safe shape is a whole body guarded on the catalog.
`000131_widen_stock_price_precision` rewrites `stock_prices` and rebuilds the
views that read it, but its first statement returns when the price columns are
already `numeric(12,4)`, so only the first deploy does that work and every
replay is one catalog read. It runs through `run_psql_session`, on the session
pooler, rather than in the `run_psql` list: the transaction pooler kills DDL
that holds its locks for minutes.

`000132_extend_fundamentals` is the same idea, step by step rather than for
the whole body. Every column add, the CHECK and both unique indexes run only
when the catalog lacks them, and `mv_fundamentals_growth` is dropped and
rebuilt only while it lacks its last column (`revenue_prior_period_end`), so
the rebuild happens on the first deploy and never again. It is two
transactions (the refresh function first, then the tables and views in the
order that function locks them) and runs through `run_psql_session` after
000131. Its allowlist line is not a lever for unblocking a deploy: the jobs
image the same deploy ships writes the new columns. If it cannot apply,
hand-apply it (`task db:prod:apply`) and re-run the deploy, or revert.

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
| `000127_council_price_drops_mv` | 2026-09-24 | Claude, via `task db:prod:apply CONFIRM=prod` | psql echoed `SELECT 229`, both `CREATE INDEX`, the `housing_mv_refresh` seed `INSERT 0 1`, `CREATE FUNCTION` and `COMMIT`. A later `task db:prod:refresh WHICH=housing` exited 0 with no Skipping line. `housing_mv_refresh` has an `mv_council_price_drops` row refreshed 2026-09-24 05:28 UTC, and `mv_council_price_drops` holds 229 rows. |
| `000128_repoint_stripped_sal_links` | 2026-09-24 | Claude, via `task db:prod:apply CONFIRM=prod` | A read-only dry run of the candidate selection returned 30 before the apply. The apply echoed `SELECT 30`, `UPDATE 30` (regions), `UPDATE 222` (listings), `UPDATE 403` (events), `UPDATE 46` (drop-index rows) and `COMMIT`. Afterwards `SUBURB:NSW-MAYFIELD` links `12540` (Mayfield, Newcastle), and re-running the selection returns 0. |
| `000135_drop_headline_dividends` | 2026-10-11 | Claude, via `task db:prod:apply CONFIRM=prod` | Before: a read-only count of 91 rows with `announcement_url IS NULL` (35 with an ex-date in the last 12 months). The apply echoed `SELECT 91` (the backup) and `DELETE 91`. Read-only check afterwards: `dividend_history` has 0 rows with `announcement_url IS NULL` and 157 in all; `dividend_history_headline_rows` holds 91. Tested first on a scratch Postgres: up, re-run (`DELETE 0`) and down. |
| `000140_suburb_demographics_division_index` | 2026-10-22 | Claude, via `task db:prod:apply CONFIRM=prod` (one transaction) | Applied 01:17 UTC, the first of this round, after both read-only pre-checks (`scripts/prod-data-api-precheck.sql`, `scripts/prod-data-api-progress.sql`) returned zero rows. psql echoed `NOTICE: 000140: built idx_suburb_demographics_federal_division` and `COMMIT`. Read-only check afterwards: `to_regclass('public.idx_suburb_demographics_federal_division') IS NOT NULL` is `t`, and `EXPLAIN SELECT federal_party FROM suburb_demographics WHERE upper(btrim(federal_division)) = 'KOOYONG' LIMIT 1` plans `Index Scan using idx_suburb_demographics_federal_division` under its Limit. |
| `000141_shorts_timeseries_full_index` | 2026-10-22 | Claude, via `task db:prod:apply CONFIRM=prod` (session fallback, `statement_timeout = 0`) | Applied 01:19:50-01:19:59 UTC, after 000144 and the one-off VACUUM, with both pre-checks at zero rows; the weekday ASIC poll before it (01:15 UTC) had finished at 01:15:12 and loaded nothing. psql echoed `CREATE INDEX` and `RESET`. `SELECT indisvalid FROM pg_index WHERE indexrelid = 'idx_shorts_timeseries_full'::regclass` is `t` (`indisready` `t`, 129 MB). The EXPLAIN gate before the drops: the chart query (`WHERE "PRODUCT_CODE" = 'BHP' ORDER BY "DATE"`) plans `Index Only Scan Backward using idx_shorts_timeseries_full`, estimating 4,523 rows (BHP has 4,131; before the ANALYZE the review's EXPLAIN estimated 284), and the bucketed MAX chart read plans `Index Only Scan using idx_shorts_timeseries_full` under its HashAggregate. |
| `000142_drop_idx_shorts_product_code_date` | 2026-10-22 | Claude, via `task db:prod:apply CONFIRM=prod` (session fallback) | Applied 01:20:32 UTC, once 000141's EXPLAIN gate had passed, with both pre-checks at zero rows. psql echoed `DROP INDEX`. `to_regclass('public.idx_shorts_product_code_date')` is NULL. |
| `000143_drop_idx_shorts_timeseries_covering` | 2026-10-22 | Claude, via `task db:prod:apply CONFIRM=prod` (session fallback) | Applied 01:20:46 UTC, right after 000142, with both pre-checks at zero rows. psql echoed `DROP INDEX`. Read-only check after both drops: `to_regclass` of `idx_shorts_product_code_date` and of `idx_shorts_timeseries_covering` are both NULL; the top-shorts sparkline query plans `Index Only Scan using idx_shorts_timeseries_full`; GetStock (`WHERE "PRODUCT_CODE" = 'BHP' ORDER BY "DATE" DESC LIMIT 1`) plans `Index Scan using idx_shorts_timeseries_full`; the chart query is still `Index Only Scan Backward` on it. `shorts` keeps three indexes: `shorts_date_product_code_unique` (70 MB), `idx_shorts_percent_nonzero` (69 MB) and `idx_shorts_timeseries_full` (129 MB), in place of the dropped 75 MB and 95 MB. |
| `000144_autovacuum_append_tables` | 2026-10-22 | Claude, via `task db:prod:apply CONFIRM=prod` (one transaction), then the one-off `VACUUM (ANALYZE)` file the same way (session fallback) | Applied 01:17:57 UTC, with both pre-checks at zero rows. psql echoed one `NOTICE: 000144: set …` line per table and `COMMIT`. `SELECT relname, reloptions FROM pg_class WHERE relname IN ('shorts','news_articles','asx_announcements')` shows `shorts` `{autovacuum_vacuum_insert_threshold=5000,autovacuum_vacuum_insert_scale_factor=0,autovacuum_analyze_threshold=2000,autovacuum_analyze_scale_factor=0}`, `news_articles` `{autovacuum_vacuum_scale_factor=0.02,autovacuum_vacuum_insert_scale_factor=0.02,autovacuum_analyze_scale_factor=0.02}` and `asx_announcements` `{autovacuum_vacuum_insert_scale_factor=0.02,autovacuum_analyze_scale_factor=0.02}`. Autovacuum then ran on all three within a minute (`last_autovacuum` 01:18:21-01:18:37 UTC), the first on any of them in the statistics window: `autovacuum_count` was 0 for all three. The one-off `VACUUM (ANALYZE)` of `shorts`, `news_articles` and `asx_announcements` ran 01:19:07-01:19:17 UTC, once the progress pre-check was empty again: `last_vacuum` and `last_analyze` are set on all three; all-visible pages are 100.0% for `shorts` (was 90.4%), 100.0% for `news_articles` (was 55.6%) and 99.3% for `asx_announcements` (was 71.1%); the last bound of the `shorts` `DATE` histogram is 2026-10-16, the table's latest date (the review read 2026-06-12). |

## Written, not yet applied

Hand-apply migrations that are merged before an operator runs them. **None of
these is on prod until its row moves to "Applied by hand" above** with a
Verified column. Each one's header has the full context.

The drift guard (`scripts/tests/migration-drift.test.mjs`) reads this table
and the one above, not the prose: a migration counts only by its own row. A row
here satisfies the guard without claiming the migration is applied, and every
run of the guard names these migrations as not on prod. A row needs the
`task db:prod:apply FILE=… CONFIRM=prod` command and a way to verify the apply.
Once it is applied, move the row up (do not copy it) and fill in Verified.
The guard runs in the Repository Hygiene workflow, which is `disabled_manually`
on GitHub as of 2026-10-22, and Cuttlefish CI does not run it; until that
changes, run `node --test scripts/tests/migration-drift.test.mjs` by hand.

The API reads them only through 42P01 fallbacks, so merging the code first is
safe for every reader. It is not the whole order: 000139's views have a
writer, house-price-collector, and an older collector never refreshes them.
Apply 000139 only once both collector deployments carry this change (its
"Before applying" cell), or the suburb pages keep the apply date's prices.

From the 2026-10-21 database review (DBP-01). Its other migrations, 000140
to 000144 (DBP-02, -04, -05), were applied on 2026-10-22 and are recorded
above:

| Migration | Before applying | Command | How to verify, then move the row up |
|---|---|---|---|
| `000139_suburb_reference_mvs` | Both collectors call `refresh_suburb_reference_views()`, since nothing else refreshes these views. Each must run a commit for which `git grep -q refresh_suburb_reference_views <commit> -- services/house-price-collector/store.go` succeeds: the Cloud Run job `house-price-collector` (official ingest, the 5th), whose image tag in `gcloud run jobs describe house-price-collector --region australia-southeast2` names the commit (`main-<sha8>`, `manual-<sha>`; `latest` does not count), and the rig binary (`vg-nsw` on the 8th, a hand-run `vg-vic`), whose revision `services/house-price-collector/deploy/stage-rig.sh --check` prints (`unknown` does not count). If either still runs an older binary after the apply, run `task db:prod:refresh WHICH=suburbs CONFIRM=prod` after each of its loads until it is redeployed. | `task db:prod:apply FILE=services/migrations/000139_suburb_reference_mvs.up.sql CONFIRM=prod` (one transaction, about 3 s) | `SELECT count(*) FROM mv_suburb_latest_price` (about 3,795), `mv_housing_state_baselines` (8), `mv_suburb_similarity_features` (about 15,345); `to_regprocedure('refresh_suburb_reference_views()')` non-null; then `task db:prod:refresh WHICH=suburbs CONFIRM=prod` exits 0. After the next official or Valuer-General load, its log has `refreshed the suburb reference views`, and the views read as refreshed after that load: housing-freshness's `SUBURB_VIEW_STALENESS`, or by hand while that workflow stays disabled, the read-only query in `docs/feature/housing/operations.md` ("MV refresh") |

