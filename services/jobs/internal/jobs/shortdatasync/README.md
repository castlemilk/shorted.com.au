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

## Per-stock validation — `-stocks BHP,DRO`

The shadow summary answers "does the pipeline work" for ~2,000 stocks at once,
which is to say it answers it for none of them. `-stocks` answers it for the
handful an operator is actually asking about:

```bash
cd services/jobs
DATABASE_URL="$PROD_TXN_POOLER_DSN" \
  GOWORK=off go run ./cmd/shorted short-data-sync -shadow -stocks BHP,DRO \
  2>/dev/null | sed 's/^SHORTED_VALIDATION_JSON //' | jq .stocks
```

**`-stocks` requires `-shadow` and is refused without it.** The flag scopes the
*report*, never the writes: a live run with `-stocks` would still upsert every
row of every file while printing a report about three of them — the most
misleading possible combination. So it only exists where nothing is written.

Codes are comma- and/or whitespace-separated, upper-cased, de-duplicated, and
each must match `^[A-Z0-9]{1,5}$`; at most **20** per run. One bad code fails
the run rather than being silently dropped.

### The validation window — `-validate-days N` (default 7, max 30)

**A validation run does not use the sync's window.** The sync processes
`MAX("DATE") + 1 day → today`, which is right for an ingest and useless for a
diagnostic: on any day ASIC has published nothing new — most days, since the job
runs daily and keeps up — that window is *empty*. Run live against prod on
2026-08-21, the report came back:

```
rows_parsed: 0, would_insert: 0, would_update: 0
stocks: { requested: [BHP, DRO], not_found: [BHP, DRO], db_rows_in_window: 0 }
```

Correct, and worthless. "not found" reads as a failure when the truth was "there
was nothing to do", and a diagnostic that only reports on days new data happens
to exist is backwards.

So `-stocks` runs scan **the last N dates ASIC actually published**, ignoring
the ingested cutoff, and re-parse days that are already in the database on
purpose. There is then always something to compare, and for a healthy pipeline
every row comes back `unchanged` — the file says 1.35%, the DB says 1.35%, they
agree. That is the positive signal the operator was asking for.

N counts **published ASIC dates, not calendar days** (`selectRecentFiles`): ASIC
publishes on business days and stops for holidays and its own outages, so a
calendar window can legitimately be empty — the exact failure this removes.

The flag is refused without `-stocks`, because on a sync or a plain `-shadow`
run it does nothing, and silently doing nothing is how a number gets trusted
that was never used. Sync, `-dry-run` and plain `-shadow` are byte-for-byte
unchanged; `syncFileWindow` (cutoff-based) and `validationScan` (index-based)
are separate functions and `TestSyncFileWindowIsCutoffBased` pins the first.

The summary gains a `validation` section (omitted otherwise) recording `days`,
`from`/`to`, the `files` scanned, the `ignored_cutoff` a sync would have used,
and — only when the window came out **empty** — a `problem` string saying so in
words. Empty-window is the one genuinely broken outcome, and it must never be
confused with "the code was absent from the files".

Because the window is re-parsed rather than new, the summary's top-level
`would_insert` / `would_update` / `would_revalidate` describe what a sync *would*
do over **this** window, not what tonight's scheduled sync will do.

### Output shape

Three differences from a plain `-shadow` run:

* the summary gains a `stocks` section (absent otherwise, so the parity artefact
  above is byte-for-byte unchanged);
* it is printed as **one compact line** prefixed `SHORTED_VALIDATION_JSON `,
  which greps cleanly out of Cloud Logging (which splits container stdout into
  one entry per newline, so the pretty-printed block cannot be reassembled);
* it is also **stored as a durable object** — see below — and the summary gains
  an `artifact` section recording where, or why not.

Every summary — plain or validation — now carries `schema_version` (currently
`1`). Bump it when a field changes meaning or disappears.

### The report artifact — `gs://$SHORTS_DATA_BUCKET/validations/<execution>.json`

A validation run additionally writes its whole summary to the job's own GCS
bucket, keyed by the Cloud Run execution id:

```
gs://shorted-short-selling-data-prod/validations/shorts-data-sync-v4l1d.json
```

That object is what the admin console reads. It replaced reading the stdout
line back out of Cloud Logging, for one blocking reason and three good ones:

* **Blocking.** Reading logs needs `logging.logEntries.list`, and log access is
  only grantable at the **project** level. The CI deploy service account cannot
  set project IAM (it can `getIamPolicy` but not `setIamPolicy`), so the grant
  403'd on every `terraform apply` — it broke all infrastructure deploys, not
  just this feature. Bucket IAM *is* writable by the deploy SA, because the
  deploy SA owns the bucket. **Do not add a project-level IAM grant to make a
  feature work in this repo.**
* No dependency on log retention: a report outlives the log sink.
* No parsing a payload back out of unstructured log chatter, and no constraint
  that it be exactly one newline-free line.
* The object records its own address, so the stdout line tells you where the
  durable copy is.

Mechanics and their guardrails:

* **The write is gated on `-stocks`.** A plain `-shadow` parity run writes
  **absolutely nothing** — no object, no GCS client, no call. The gate lives
  inside `publishValidationArtifact` rather than only at its call site, and
  `TestPlainShadowWritesNoArtifact` pins it.
* **It fails soft.** No `SHORTS_DATA_BUCKET`, no `CLOUD_RUN_EXECUTION` (a local
  run), or a refused upload → the run still succeeds and the reason is recorded
  in `artifact.skipped` / `artifact.error`, which the stdout line carries. A
  diagnostic must not itself need diagnosing.
* **A stored object never carries `artifact.error`** — if it stored, the write
  worked.
* IAM: the job's SA already holds `roles/storage.objectAdmin` on the bucket; the
  shorts API SA is granted `roles/storage.objectViewer` on it via the
  short-data-sync module's `reader_service_accounts`.

The object path is a **cross-module contract**: `validations/<execution>.json`
is duplicated in `services/shorts/internal/jobmonitor/validate.go`, since the
two are separate Go modules. Both sides pin it with a test
(`TestValidationArtifactObjectPath` / `TestValidationObjectPathMatchesTheJob`) —
change one, change the other.

### Reading the `stocks` section

`observations` is one row per requested code per date in the window:

| `status` | Meaning |
|---|---|
| `new` | The file has the row, the DB does not → the sync would INSERT it. |
| `unchanged` | Both sides agree on every column the upsert writes → the write is a no-op. |
| `changed` | The DB has the row and at least one written column differs. `changed_fields` names them. |
| `missing-from-file` | The DB has a row for that (code, date) but the file omits the code. ASIC drops a stock with no reportable short position, so this is informative, not automatically wrong — but it is also the shape of a bad parse. Nothing is written and nothing is deleted (`would_skip`). |

Two subtleties worth knowing before you read a diff as a bug:

* **A product rename is not a change.** `ON CONFLICT` deliberately does not
  refresh `PRODUCT` (see `upsertShortsSQL`), so `changed_fields` never lists it —
  both names are still shown in `file_values` / `db_values` for context.
* **`not_found` means "absent from the files", not "no window".** A requested
  code that appeared in *no* parsed file is listed there — a real signal (a
  delisted or never-shorted ticker), and it keeps "BHP is missing from the data"
  distinct from "BHP was never asked for". The other case — there were no files
  at all — is `files_in_window: 0` / `window_empty: true` plus
  `validation.problem`, a different problem with a different fix. **Read
  `window_empty` first**; with no files, `not_found` is vacuous.
* **Everything `unchanged` is the pass.** Since the window is deliberately
  already-ingested days, `unchanged` on every row is the expected, healthy
  result — not "nothing happened".

`counts` is the per-status tally. `db_rows_in_window` is how many rows the
comparison SELECT returned **for the requested codes** — deliberately scoped,
not "all rows in the window": scoped, it is a direct denominator for the table
next to it ("2 codes × 5 dates, 10 of 10 rows present"); unscoped it would put a
five-figure number beside a two-row table, answer a question nobody asked (that
is what run-level `rows_parsed` covers) and cost a full-window scan. A zero there
alongside non-zero file rows means the whole window is genuinely new for these
codes.

### From the admin console

Same run, driven from `/admin`: see
[`docs/observability/job-alerting.md`](../../../../../docs/observability/job-alerting.md)
§"Validate sync" — the console builds `-shadow -stocks <codes>` server-side and
reads the report back from `validations/<execution>.json` in the bucket.

## Tests

All offline: golden CSV fixtures in `testdata/` (a trimmed REAL modern ASIC
file including a quoted product name with a comma, a legacy UTF-16LE/TAB file
and a CP1252 file), a fake `database` for the upsert/refresh/`sync_status`
semantics, an `httptest` server for the 404 path and for the revalidation wire
format, and determinism tests for the shadow checksum. There is no network and
no database in the suite.
