# `shorted short-data-sync`

**This IS the ASIC short-position pipeline.** The `shorts-data-sync` Cloud Run
Job runs `/shorted short-data-sync` from this package.

Historically it was a port of `services/daily-sync/deprecated/
comprehensive_daily_sync.py` (the script the job's old Python image ran, built
from `services/daily-sync/Dockerfile`; `services/short-data-sync/main.py` was a
never-deployed sibling and was never the source of truth). Cutover slice 4
swapped the job's image in place after shadow parity passed 6/6 dates
byte-identically, and the cleanup slice **deleted both Python trees**. Parity
notes below are kept as provenance for the behaviour they explain — the Python
is no longer available to diff against.

```
shorted short-data-sync                 # live run
shorted short-data-sync -dry-run        # download + parse, write nothing
shorted short-data-sync -shadow         # dry run + JSON parity summary on stdout
shorted short-data-sync -days 30        # wider window on an empty table
```

## Environment contract

Every flag defaults from the env var, so the deployed env-only invocation keeps
working; a flag wins when both are present.

| Python env var | Go flag | Default | Notes |
|---|---|---|---|
| `SYNC_DAYS_SHORTS` | `-days` | 7 | Look-back used when the `shorts` table is EMPTY. With data present the window is always `MAX("DATE") + 1 day` → today. |
| `SYNC_BATCH_SIZE` | `-batch-size` | 500 | Only written to `sync_status.checkpoint_batch_size` for dashboard continuity — there is no stock batching left to size. |
| `SYNC_ALGOLIA` | `-sync-algolia` | false | Triggers the index sync after a successful run. |
| `DATABASE_URL` | — (env only) | — | Required. |
| `ENVIRONMENT` | — (env only) | `development` | → `sync_status.environment`. |
| `CLOUD_RUN_EXECUTION` → `K_SERVICE` → `CLOUD_RUN_JOB` → hostname | — (env only) | — | → `sync_status.hostname`, and the resume key. Order is load-bearing (PR #231). |
| `REVALIDATION_URL`, `REVALIDATION_SECRET` | — (env only) | — | Unset ⇒ the ping no-ops, as today. |
| `ALGOLIA_APP_ID`, `ALGOLIA_ADMIN_KEY`, `ALGOLIA_INDEX`, `ALGOLIA_SYNC_URL`, `ALGOLIA_SYNC_TOKEN` | — (env only) | — | Same two mechanisms as the Python (in-image script, else HTTP POST). |
| `GCP_PROJECT` | — | — | Set by Terraform, read by neither implementation. |
| `SYNC_DAYS_STOCK_PRICES`, `SYNC_KEY_METRICS`, `ALPHA_VANTAGE_API_KEY`, `MAX_STOCK_FAILURE_RETRIES` | **unsupported** | — | Price/metric tier — see below. Setting one logs a loud warning rather than being silently ignored. |

## What this job does not do

The Python script bundled three unrelated pipelines. This job takes ONE:

| Python stage | Where it lives now |
|---|---|
| ASIC shorts ingest, MV refresh, revalidation, Algolia, `sync_status` | **here** |
| `stock_prices` sweep (yfinance + Alpha Vantage, 500-stock batches, gap fill) | `shorted market-data serve\|sync` (Phase 2c) — already ported, already deployed, own checkpoint store |
| `key_metrics` refresh of `"company-metadata"` (yfinance `ticker.info`) | the shorts API's `SyncKeyMetrics` RPC, fired by the `key-metrics-scheduler` Cloud Scheduler (`terraform/modules/shorts-api/main.tf`, `enable_key_metrics_scheduler = true` in prod) |

`shorted market-data` only READS `key_metrics` (to build Algolia records) and
this job never writes it either — but that is fine: the shorts API already runs
its own daily key-metrics refresh (the Python job was a duplicate second
writer). The cutover PR only needs to CONFIRM that scheduler is enabled and
healthy in prod before pausing the Python job.

Consequences of dropping the stock loop (all deliberate):

- **No exit code 2.** The Python exited 2 when a run finished a partial batch so
  Cloud Run would retry it. With no per-stock work there is no partial state:
  exit 0 on success, 1 on failure, like every other job in the binary.
- The `sync_status` price/metric counters are written as **0** rather than left
  alone, so an adopted row cannot show a previous run's numbers.
- `max_retries = 5` / `timeout = 28800s` on the Cloud Run Job are sized for the
  ~5h price sweep. A shorts-only run is minutes; right-size them at cutover.

## Deliberate divergences from the Python

1. **Legacy files now parse.** Encoding is detected (UTF-8/UTF-16 BOM → UTF-8
   validity → CP1252) and the delimiter is sniffed (TAB vs comma). Pre-2023 ASIC
   files are UTF-16LE + TAB; the Python read them with `sep=","`, found no
   `PRODUCT_CODE` column and silently ingested nothing. Files inside the daily
   window are modern comma/UTF-8, so a scheduled run is unaffected — a deep
   backfill ingests strictly more.
2. **A blank numeric cell becomes 0**, where pandas produced `NaN` (`NaN or 0`
   is `NaN`) and stored NaN. No blank has been observed in the daily files.
3. **A header-mismatched file is named in the log** (`errNoUsableHeader`)
   instead of silently producing zero rows.
4. **SIGTERM stops between rows** and the run exits non-zero, with everything
   already committed left committed. The Python's `_terminating` flag polling is
   replaced by the runner's signal-aware context.
5. **The revalidation secret travels only as a header** (`X-Revalidate-Secret`)
   via `platform.PingRevalidate`, which also adds a 45s deadline on a detached
   context and redacts the URL from error logs.

Everything else is carried over verbatim, including the two changes made to the
deployed script the same day this port was written: the `SET statement_timeout =
0; SELECT refresh_all_materialized_views()` **single-statement** MV refresh, and
`trigger_frontend_revalidation` (fires only when `record_count > 0`, never fails
the run, same tag/path/flush values).

## Shadow comparison (run this BEFORE the cutover PR)

`-shadow` runs the entire read path — index fetch, download, decode, parse,
classify against the rows already in the table — and writes **nothing**: no
`shorts` rows, no `sync_status` row, no MV refresh, no revalidation ping, no
Algolia call. It prints one JSON object on **stdout** (all logs go to stderr).

Run it AFTER the Python job's scheduled 10:00 UTC run has finished, so the
Python's writes are already in the table and every parsed row should classify as
`would_update`:

```bash
cd services/jobs
DATABASE_URL="$PROD_TXN_POOLER_DSN" \
  GOWORK=off go run ./cmd/shorted short-data-sync -shadow \
  > /tmp/shadow-$(date -u +%F).json 2>/tmp/shadow-$(date -u +%F).log

jq '{files_selected, files_parsed, rows_parsed, would_insert, would_update, duplicate_keys, checksum}' \
  /tmp/shadow-$(date -u +%F).json
```

### How to read it

| Field | A healthy post-Python run |
|---|---|
| `already_up_to_date` | `true` only if the Python already ingested TODAY's file; then every other count is 0 and the comparison must be redone with `-days` widened (below). |
| `would_insert` | **0** — anything above zero is a row the Python did NOT write. Investigate before cutting over. |
| `would_update` | equals `rows_parsed` — the Go parse produced exactly the rows already present. |
| `duplicate_keys` | 0 unless ASIC published two versions of one date. |
| `files_failed` | Empty, or only 404s for non-trading days. |

### Checksum comparison

`checksum` is `sha256` over the sorted `date|CODE|positions` tuples the run
parsed. Compute the same value from what the Python actually wrote:

```sql
-- Same window the shadow run used: see "cutoff_date" in the JSON.
-- Float rendering: a plain ::text cast — Postgres float8 output uses the same
-- shortest-round-trip algorithm as Go's strconv.FormatFloat(v,'f',-1,64) for
-- these magnitudes. Do NOT use to_char() with a format mask: its fixed-
-- precision output differs from Go on nearly every value and every checksum
-- will falsely mismatch (verified during the 2026-08-21 parity run).
-- Sort: COLLATE "C" to match Go's sort.Strings byte ordering.
SELECT encode(
         sha256(
           convert_to(
             string_agg(line, E'\n' ORDER BY line COLLATE "C") || E'\n',
             'UTF8')),
         'hex') AS checksum,
       count(*) AS rows
FROM (
  SELECT to_char("DATE", 'YYYY-MM-DD') || '|' ||
         "PRODUCT_CODE" || '|' ||
         "REPORTED_SHORT_POSITIONS"::text AS line
  FROM shorts
  WHERE "DATE" >= to_date(:cutoff_date::text, 'YYYYMMDD')
) t;
```

Equal checksums ⇒ the Go parse reproduces the Python's rows exactly. If they
differ, narrow it with the per-date `dates[]` block (each entry carries its own
`checksum` and `rows_parsed`) and this query per date:

```sql
SELECT "PRODUCT_CODE", "REPORTED_SHORT_POSITIONS"
FROM shorts
WHERE "DATE" = DATE '2026-08-14'
ORDER BY "PRODUCT_CODE";
```

> If the totals match but the checksums do not, dump both sides and diff the
> tuples before concluding the parse diverged. Scientific notation is the one
> known edge: Postgres switches to it around |v| ≥ 1e16 while Go's 'f' format
> never does — irrelevant for REPORTED_SHORT_POSITIONS (~1e10 max) but format
> explicitly if this query is ever reused for TOTAL_PRODUCT_IN_ISSUE.
>
> Parity evidence (2026-08-21 pre-cutover run): 6/6 Python-written dates
> (2026-08-07 → 2026-08-14, 4,471 rows) matched byte-identically with this
> corrected query.

### Also worth checking

```sql
-- Row counts per date across the window, Python-written.
SELECT "DATE"::date AS d, count(*)
FROM shorts WHERE "DATE" >= CURRENT_DATE - 10 GROUP BY 1 ORDER BY 1;

-- The sync_status row the Python wrote for the run you are shadowing.
SELECT run_id, status, hostname, shorts_records_updated, total_duration_seconds
FROM sync_status ORDER BY started_at DESC LIMIT 5;
```

To shadow a WIDER window than the table's current head (the table is already up
to date, so a live window is empty), point `DATABASE_URL` at a **restore or a
local copy**, delete the last N days there, and re-run with `-days N`. Never
delete rows in prod to make a shadow run interesting.

## Tests

All offline: golden CSV fixtures in `testdata/` (a trimmed REAL modern ASIC
file including a quoted product name with a comma, a legacy UTF-16LE/TAB file
and a CP1252 file), a fake `database` for the upsert/refresh/`sync_status`
semantics, an `httptest` server for the 404 path and for the revalidation wire
format, and determinism tests for the shadow checksum. There is no network and
no database in the suite.
