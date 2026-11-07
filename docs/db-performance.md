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
| **price-sync N+1** | `Run` prefetches latest date per stock in one `GROUP BY` (was 992k per-stock `SELECT MAX(date)` queries); the single-stock API path falls back to a direct lookup. | `market-data-sync/sync/sync.go` |
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

## Follow-ups

- ✅ **Reset `pg_stat_statements`** — done 2026-06-19 (1729 → 1 rows); the
  measurement window now starts fresh. Re-run after deploying this branch for a
  clean post-fix comparison.
- ✅ **Price-sync N+1** — done (the 992k-call per-stock `SELECT MAX(date)`; see the
  fixes table). Still open but low-priority: `SELECT DISTINCT stock_code FROM
  stock_prices` (~3.3s/call) lives only in one-off backfill/audit scripts —
  source from `company-metadata` if it ever moves to the hot path.
- **Connection churn:** `pgbouncer.get_auth` ran 1.25M times (per-instance Cloud
  Run pools / cold starts); watch against the 60-conn cap.
- **Migration tracking:** prod migrations are applied by hand with no recorded
  state — consider a tracked runner.
- **Legacy `supabase/migrations`** (14 files) is diverged from the canonical
  `services/migrations` (48); document/retire it.
- **RLS and the Supabase Data API:** "backend-only" was never true of the database
  itself. Prod is a Supabase project, so PostgREST serves schema `public` to anyone
  holding the anon key, and Supabase's default privileges had granted `anon` and
  `authenticated` everything there: on 2026-10-21 `scripts/prod-data-api-check.sql`
  listed 385 violations (every table, view, materialized view and sequence, all 23
  functions, RLS off on 16 tables). `000138_harden_data_api_grants` revokes all of
  it, closes `postgres`'s default privileges and enables RLS on every table, with no
  policies and no FORCE. The backend owns everything and has BYPASSRLS, so it sees no
  change. Zero rows from the check means closed. Apply it by hand, after the
  read-only pre-check, before its merge: every push to `main` deploys (Cuttlefish
  runs `terraform-deploy.yml`) and replays 000138 last, which writes nothing on a
  closed database and re-closes any later drift. The procedure is in
  `docs/operations/supabase-data-api.md`.

## Note on the news-aggregator build

`origin/main` currently fails to build `news-aggregator` — `main.go` imports
`services/pkg/jobstatus`, which isn't present on main (an incomplete merge of the
job-monitoring work). This is unrelated to the `store.go` change here, which
compiles cleanly; the package will build once main restores `pkg/jobstatus`.

## Materialized view benchmarks and the production database

Moved here from `CLAUDE.md` on 2026-11-07 (it keeps the short form).

Query performance expectations (measured January 2026):

| Query | Without MV | With MV | Improvement |
|-------|-----------|---------|-------------|
| GetTopShorts (50 stocks) | ~2,300ms | ~6ms | **380x** |
| GetIndustryTreeMap | ~500ms | ~3ms | **165x** |
| Watchlist defaults (8 stocks) | ~227ms | <1ms | **227x+** |
| Time series (5 stocks, 6mo) | ~140ms | ~140ms | (still raw query) |

**Backend Implementation:**
- `getTopshorts.go` uses `mv_top_shorts` with fallback to raw query
- `getShortsTreeMap.go` uses `mv_treemap_data` with fallback to raw query
- Fallback ensures tests and dev environments work without MVs

**Production Database (Supabase):**
- Host: `aws-0-ap-southeast-2.pooler.supabase.com`
- Transaction pooler port: 6543 (use this for queries)
- Session pooler port: 5432 (limited connections)
- ~2.1M rows in shorts, ~3.7M rows in stock_prices

**Supabase Limits:**
- max_connections: 60
- shared_buffers: 224 MB
- work_mem: 2 MB
- Use transaction pooler (port 6543) to avoid connection limits

**Supabase Data API: closed by `000138_harden_data_api_grants`; keep it closed.**
PostgREST serves whatever `anon` and `authenticated` can reach in `public` to
anyone with the (non-secret) anon key, and nothing here uses it.
- Never `GRANT` anything to `anon`, `authenticated` or `PUBLIC`, make one of them
  an owner, create a policy, or FORCE/DISABLE row level security, in ANY `.sql`
  file (migrations, the legacy `supabase/` and `web/supabase/` SQL that
  `supabase db push` would apply, `analysis/`, `scripts/`):
  `services/migrations/data_api_grants.test.mjs` fails. A GRANT with a computed
  grantee is allowed only in the reviewed carries in 000131 and 000132. A
  `SECURITY DEFINER` function pins `search_path` and revokes `PUBLIC`'s EXECUTE
  in the same file. The same test pins 000138's catalog queries and the check's
  classes whole: change one only with a re-verification, pin included.
- Closed = zero rows from `task db:prod:psql -- -P pager=off -f scripts/prod-data-api-check.sql`.
  Apply 000138 by hand (pre-check, `task db:prod:apply`, check, until zero rows)
  BEFORE its merge, and open its PR only after (the repo is public). The merge
  deploys (see "A merge is not a deploy until its deploy has run"): on a
  still-open database the replay stops with `object_in_use` if a refresh is in
  flight, failing `terraform-apply` before any image is swapped, but
  `deploy-vercel-prod` still promotes the web app. On a closed database it does
  nothing. Runbook: `docs/operations/supabase-data-api.md`.
- 000138 stays the LAST file the deploy replays, so each deploy re-closes what
  the others open (re-running it by hand is the immediate fix): a new
  allowlisted migration goes ABOVE it in `terraform-deploy.yml`.

