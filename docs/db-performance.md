# Database Performance — load investigation & fixes

Investigation of prod DB load via `supabase inspect db` (2026-06-19, against the
prod transaction/session pooler). `pg_stat_statements` had not been reset in 658
days, so totals are lifetime-cumulative — but the proportions cleanly identify
the structural hot-spots.

## Top sources of load (before)

| Rank | Query | % of total exec time | Calls | ~per call |
|---|---|---|---|---|
| 1 | `SELECT DISTINCT "DATE"::date FROM shorts WHERE "DATE" < $1 ORDER BY date DESC` | 35.5% | 56,751 | ~2.1 s |
| 2 | `SELECT DISTINCT "DATE"::date FROM shorts ORDER BY date DESC` | 24.0% | 56,924 | ~1.4 s |
| 3 | `INSERT INTO news_articles … ON CONFLICT (url) DO NOTHING` | 12.7% | **72.2M** | ~0.6 ms |
| 4 | `INSERT INTO director_trades … ON CONFLICT DO NOTHING` | 4.5% | **4.8M** | — |

- **#1 + #2 = ~60% of all DB query time** — both are `GetAvailableDates`, a full
  DISTINCT scan over 2.2M `shorts` rows. The result changes only once/day.
- **#3: 72.2M INSERT attempts → only 336,975 rows kept** — the news aggregator
  re-attempted ~every article every run; `ON CONFLICT(url)` dedups but each
  attempt still probes the unique index.
- **#4: `director_trades` had no natural-key constraint** (only a uuid PK), so
  `ON CONFLICT DO NOTHING` never deduped → 4.8M rows / ~1.2 GB, almost all
  duplicates (biggest table in the DB).

Health was otherwise fine: cache hit 0.98/0.97, no long-running/blocking queries,
~13/60 connections. So these are structural inefficiencies, not a live incident.

## Fixes in this branch

| Fix | What | Files |
|---|---|---|
| **`mv_available_dates`** | Materialize `DISTINCT "DATE"` (≈60% of read load → ~1ms). `GetAvailableDates` queries the MV with raw fallback. Added to `refresh_all_materialized_views()`. | `000049_*`, `postgres.go` |
| **`director_trades` dedup** | Collapse to one row per natural key, add `uq_director_trades_natural` so re-crawls dedup. Reclaims ~1 GB. | `000050_*` |
| **news pre-filter** | `StoreArticles` skips already-stored URLs before inserting (72M attempts → new-only). Safe fallback to insert-all on error. | `news-aggregator/store.go` |
| **drop unused index** | `idx_company_metadata_financial_statements` (0 scans). | `000051_*` |
| **supabase config** | Remove CLI-rejected `[project]` + `[environments.*]` from `config.toml`. | `supabase/config.toml` |

## Prod rollout (migrations applied manually via psql)

```sql
-- statement_timeout=0: the director_trades dedup DELETE over 4.8M rows is heavy.
SET statement_timeout = 0;
\i services/migrations/000049_mv_available_dates.up.sql
\i services/migrations/000050_director_trades_dedup.up.sql
\i services/migrations/000051_drop_unused_index.up.sql

-- Populate the new MV and reclaim/refresh stats:
REFRESH MATERIALIZED VIEW mv_available_dates;
VACUUM (ANALYZE) director_trades;   -- reclaim ~1 GB freed by the dedup
ANALYZE shorts;                     -- stats were stale (last_analyze 2025-12-07)
```

Then redeploy **shorts** (MV-backed `GetAvailableDates`) and **news-aggregator**
(pre-filter). The MV is refreshed automatically by `refresh_all_materialized_views()`
after each sync.

## Recommended follow-ups (not in this branch)

- **Reset `pg_stat_statements`** (`SELECT pg_stat_statements_reset();`) so the next
  measurement reflects current (post-fix) load rather than 658 days of history.
- **N+1 in price sync:** `SELECT MAX(date) FROM stock_prices WHERE stock_code=$1`
  ran 992k times — replace with one `GROUP BY stock_code`. `SELECT DISTINCT
  stock_code FROM stock_prices` (~3.3s/call) → source from `company-metadata`.
- **Connection churn:** `pgbouncer.get_auth` ran 1.25M times (per-instance Cloud
  Run pools / cold starts); watch against the 60-conn cap.
- **Migration tracking:** prod migrations are applied by hand with no recorded
  state — consider a tracked runner.
- **Legacy `supabase/migrations`** (14 files) is diverged from the canonical
  `services/migrations` (48); document/retire it.
- **RLS:** no row-level security (fine for backend-only access; revisit if direct
  client access is ever added).

## Note on the news-aggregator build

`origin/main` currently fails to build `news-aggregator` — `main.go` imports
`services/pkg/jobstatus`, which isn't present on main (an incomplete merge of the
job-monitoring work). This is unrelated to the `store.go` change here, which
compiles cleanly; the package will build once main restores `pkg/jobstatus`.
