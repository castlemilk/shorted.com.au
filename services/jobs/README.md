# `shorted` — consolidated batch-job binary

One Go module, one binary, one image for every batch job/crawler/collector.
Implements **Phase 1** of `docs/jobs-consolidation-plan.md`.

```
shorted                          # list available jobs
shorted influence -mode all      # a job with its own flags
shorted reports coverage -h      # nested job group
shorted -verbose reports sync -limit 10
shorted market-data serve        # a long-running HTTP surface, not a batch run
```

## Layout

```
services/jobs/
  cmd/shorted/main.go         root CLI: global flags → registry dispatch
  internal/runner/            Job interface, Registry, Group, signal ctx, start/end logs
  internal/platform/          db (pgxpool), revalidate ping, env config
  internal/jobs/announcements/`shorted announcements` (was services/asx-announcement-crawler)
  internal/jobs/discovery/    `shorted discovery`  (was services/asx-discovery)
  internal/jobs/economy/      `shorted economy`    (was services/economy-collector)
  internal/jobs/influence/    `shorted influence`  (was services/influence-collector)
  internal/jobs/marketdata/   `shorted market-data serve|sync|audit-gaps|historical-backfill`
                              (was services/market-data-sync)
  internal/jobs/news/         `shorted news`       (was services/news-aggregator)
  internal/jobs/picks/        `shorted picks`      stock-picker data: full statements, filing
                              half-years + refresh_strategy_views() (new, not a port)
  internal/jobs/reportextract/`shorted report-extract concurrent|sequential`
                              + `shorted director-trades`
                              (was services/report-extractor, Python)
  internal/jobs/reports/      `shorted reports coverage|link|sync`
                              (was services/report-coverage / -linker / -sync)
  internal/jobs/shortdatasync/`shorted short-data-sync`
                              (was services/daily-sync, Python — ASIC tier only;
                               that tree is DELETED as of the cleanup slice)
  internal/jobs/signals/      `shorted signals`    (was services/signals-collector, Python)
  internal/jobs/weeklyreport/ `shorted weekly-report`
                              (was services/weekly-report-generator)
  Dockerfile                  standard image (context = services/) — 9 lean jobs
  Dockerfile.browser          browser image (Chromium + Playwright) — `discovery`
```

## Migration status

| Subcommand | Replaces | Deployed? |
|---|---|---|
| `announcements` | `services/asx-announcement-crawler` | yes — `shorted-announcements` (cutover 1; old scheduler paused) |
| `discovery` | `services/asx-discovery` | yes — the EXISTING `asx-discovery` job now runs the `shorted-jobs-browser` image with args `["discovery"]` (cutover 3, in-place; no old scheduler to pause) |
| `economy` | `services/economy-collector` | yes — `shorted-economy` (cutover 1; old scheduler paused) |
| ~~`house-prices`~~ | `services/house-price-collector` | **retired 2026-09-24** — the port was never scheduled and was deleted; `services/house-price-collector` is the only copy. See "Phase 2d (house-prices) — retired" |
| `influence` | `services/influence-collector` | no — laptop-only tool |
| `market-data serve` | `services/market-data-sync` (default mode) | yes — the EXISTING `market-data-sync` Cloud Run SERVICE now runs the `shorted-jobs` image with args `["market-data","serve"]` (cutover 3, in-place revision swap; same URI/SA/scheduler) |
| `market-data sync` | `services/market-data-sync -cli` | yes — `shorted-price-sync`, the daily price sweep (weekdays 10:00 UTC); the `market-data-sync-daily` scheduler that drove `serve`'s `POST /api/sync/all` is paused. See "Daily price sweep" |
| `market-data audit-gaps` | `services/market-data-sync/cmd/audit-gaps` | no — laptop-only tool |
| `market-data historical-backfill` | `services/market-data-sync/cmd/historical-backfill` | no — laptop-only tool |
| `news` | `services/news-aggregator` | yes — `shorted-news`, 1 job + 5 schedules (cutover 2; all 5 old schedulers paused) |
| `picks` | — (new job, stock picker) | `shorted-picks` in `terraform/environments/prod/main.tf`: `-mode refresh` weekdays 13:30 UTC + `-mode all` daily 15:00 UTC. See "picks" |
| `director-trades` | `services/report-extractor/extract_director_trades.py` | **not yet** — ported (Phase 3), no Terraform change; `director-trade-extractor` still runs the Python image |
| `report-extract concurrent` | `services/report-extractor/extract_reports_concurrent.py` | **not yet** — ported (Phase 3); `financial-report-extractor` still runs the Python image, which has since moved ahead of the port (see "Phase 3 port notes") |
| `report-extract sequential` | `services/report-extractor/extract.py` | no — laptop-only CLI |
| `reports coverage` | `services/report-coverage` | no — laptop-only tool |
| `reports link` | `services/report-linker` | no — laptop-only tool |
| `reports sync` | `services/report-sync` | no — laptop-only tool |
| `short-data-sync` | `services/daily-sync` (Python, **DELETED**) — **ASIC shorts tier only** | yes — `shorts-data-sync` (cutover 4, in-place image swap; Python source deleted in the cleanup slice) |
| `signals` | `services/signals-collector` (Python) | yes — `shorted-signals` (cutover 2; old scheduler paused) |
| `weekly-report` | `services/weekly-report-generator` | yes — `shorted-weekly-report`, weekly + monthly schedules (cutover 2; old schedulers paused) |

The old services are still present, still build and stay **deployed + manually
executable**; per the plan's invariants a service is only deleted in a later
cleanup PR, after its replacement has run green for ≥1 scheduled cycle. Only the
old *schedulers* are paused, so rollback is a `scheduler_paused` / `paused`
variable flip in `terraform/environments/{dev,prod}/main.tf` — see
`docs/jobs-consolidation-plan.md` ("Cutover slice 1" / "Cutover slice 2").

## Phase 2b port notes (news / signals / weekly-report)

Behaviour is carried over one-for-one except where a shared-binary invariant
forced a change. The deliberate divergences:

- **`news`: `RUN_MODE` → `-run-mode`.** The env var is still the flag's DEFAULT,
  so the deployed schedulers' `container_overrides` keep working untouched; an
  explicit flag wins. Unknown modes now fail fast instead of falling through to
  the aggregate path.
- **`news`: no implicit HTTP server.** The standalone binary served `/health` +
  `POST /run` whenever `CLOUD_RUN_JOB` was unset — a leftover from its Cloud Run
  *service* days (in prod it is a Job, and Cloud Run always sets that variable,
  so the branch was unreachable there). It is preserved behind an explicit
  `-run-mode serve` (with graceful shutdown) so `shorted news` on a laptop
  aggregates and exits instead of silently becoming a server.
- **`news`: `-dry-run` is refused** for `embed-backfill`,
  `embed-company-summaries`, `digest` and `serve` — those modes write
  regardless, and the standalone binary silently ignored the flag.
- **`news`: aggregate-only collaborators are built lazily.** The stock matcher
  (a DB query), the sentiment analyzer and the stealth RSS engine are only
  constructed for `aggregate`/`serve`; the standalone binary built them before
  the RUN_MODE switch, so a `cluster-news` or `digest` run paid for them.
- **`weekly-report`: the revalidation ping goes through `platform.PingRevalidate`.**
  Same endpoint and same query (`?secret=…&tag=report-<slug>` — `Tag` was added
  to `RevalidateRequest` for it), but the shared helper adds a 45s deadline on a
  detached context and REDACTS the URL from error logs; the original logged the
  raw `*url.Error`, which contains `?secret=`.
- **`signals` is a Python→Go rewrite.** Same flags, same SQL, same
  `sha1(code|polarity|headline)` content hash, same 1s/3s 5xx backoff. It writes
  through the shared pgx pool inside a per-stock transaction instead of one
  psycopg2 connection behind a mutex, dedupes rows by content hash before the
  multi-row upsert (Postgres rejects a second hit on the same conflict target,
  which failed the whole stock in `collect.py`), and stops on SIGTERM (selection
  is `last_fetched_at`-driven, so a partial sweep resumes next run).
- **`log.Fatal*` is gone** from every ported path (including
  `NewRSSFetcher`), per the convention below.

## Phase 2c port notes (market-data / discovery)

Both source services live in their OWN Go modules (`services/market-data-sync`,
`services/asx-discovery`, both members of `services/go.work`). Those modules are
untouched and still build; this slice is CODE ONLY — no Terraform, no schedule
change, no deletion.

### `market-data` — a service, not a job

`market-data-sync` is the only source service that is a Cloud Run **service**
(a weekday scheduler POSTs its endpoints), so the HTTP surface is preserved
verbatim behind `serve` — exactly the way `news` kept its serve mode.

| Old invocation | New |
|---|---|
| `market-data-sync` (default) | `shorted market-data serve` |
| `market-data-sync -cli` | `shorted market-data sync` |
| `cmd/audit-gaps -minGapDays -years -details` | `shorted market-data audit-gaps` (same flags) |
| `cmd/historical-backfill -years -limit -priority-only -force -symbol` | `shorted market-data historical-backfill` (same flags) |

Endpoints, paths, request/response shapes, CORS and readiness semantics are
unchanged: `/healthz`, `/readyz`, `/health`, `POST /api/sync/stock/{symbol}`,
`POST /api/sync/all`, `GET /api/sync/status[/{runId}]`,
`GET /api/gaps/detect/{symbol}`, `POST /api/gaps/repair/{symbol}`,
`GET /api/gaps/report/{symbol}`, `GET /api/gaps/detect-all`. Environment is
unchanged (`DATABASE_URL`, `DB_MAX_CONNS`/`DB_MIN_CONNS`, `GCS_BUCKET_NAME`,
`PRIORITY_STOCK_COUNT`, `ALPHA_VANTAGE_API_KEY`, `ALGOLIA_*`, `SYNC_ALGOLIA`,
`PORT`, `LOCAL_ASX_CSV`, `GOOGLE_APPLICATION_CREDENTIALS`).
`serve` also gained a `-port` flag that overrides `$PORT`; unset, behaviour is
identical.

`sync/stock_price_coverage.go` is carried over byte-for-byte, so the
`REFRESH MATERIALIZED VIEW CONCURRENTLY mv_stock_price_coverage` that runs after
a sweep with `pricesUpdated > 0` — plus both `mv_stock_price_coverage` →
`stock_prices` query fallbacks — behave exactly as before.

**No `-dry-run`.** The source service has no dry-run concept in any mode, so no
subcommand declares `DryRun`, and a global `shorted -dry-run market-data …` is
refused before anything opens a pool (asserted in `job_test.go`).

**DB pool does NOT go through `platform`.** `platform.Connect` only exposes
`MaxConns`; market-data needs `MinConns`, `MaxConnLifetime`, `MaxConnIdleTime`,
`HealthCheckPeriod` and `ConnConfig.ConnectTimeout` for its multi-hour sweeps,
plus operator-tunable `DB_MAX_CONNS`/`DB_MIN_CONNS`. `buildDBPoolConfig` is
preserved verbatim (including `QueryExecModeSimpleProtocol`) and its two unit
tests came across with it. `audit-gaps` is the one place this *tightens*
behaviour: the standalone `cmd/audit-gaps` used a bare `pgxpool.New` (extended
protocol, default pool size) against the same Supabase pooler, and now shares the
tuned config.

### `discovery` — env-only, browser image

No flags, before or after: `GCS_BUCKET_NAME` (default `shorted-data`) and
`DOWNLOAD_DIR` (default `/tmp/asx-downloads`). The one addition is a `FlagSet`
whose only job is to make `-h` print that contract and to **reject stray
arguments** — the standalone binary ignored `os.Args` entirely, so a typo'd
invocation still ran a full scrape and upload. Like market-data it declares no
dry-run, so a global `-dry-run` is refused rather than silently uploading.

### Deliberate divergences

| Area | Standalone | Here | Why |
|---|---|---|---|
| `log.Fatalf` (13 sites across both) | exits immediately | returns an error, texts preserved | deferred pool/GCS/OTel closes actually run; the runner logs `status=error` and main exits 1 |
| `api.Server` listener failure | `log.Fatalf` inside the listener goroutine | buffered `serveErr` chan → `AwaitShutdown` / `Err()` | a bind failure skipped every deferred close **and** the OTel flush |
| serve dependency-init retry | `time.Sleep(backoff)`, `log.Fatalf` on cancel/exhaustion | ctx-aware `select`, errors returned; abandons early if the listener already failed | SIGTERM during a 30s backoff now lands promptly |
| `sync` interrupted | `os.Exit(130)` | returns `sync interrupted: …` → exit 1 | the shared binary has one failure exit code; 130 is no longer distinguishable |
| `historical-backfill` interrupted | `return` → **exit 0** | returns a cancellation error → exit 1 | an interrupted backfill used to look like a clean run to any caller |
| `audit-gaps` gaps found | `os.Exit(1)` after printing | sentinel error → exit 1, same report | same exit code, but deferred cleanup runs |
| `audit-gaps` on an empty DB | divided by `len(stocks)` → `NaN%` | reports "no stocks to audit" and returns | guard, not a behaviour anyone relied on |
| `audit-gaps` stock-list scan | never checked `rows.Err()` | checked | a mid-iteration drop silently produced a SHORT list and a clean audit |
| `historical-backfill` gap query | `defer rows.Close()` **inside the per-stock loop** | closed per call | rows (and their pooled connections) stayed open for the whole multi-thousand-stock run |
| `historical-backfill` gap threshold | literal `4` inlined in SQL | `$2` parameter (`backfillMinGapDays`) | same value, parameterised |
| HTTP JSON responses | `json.NewEncoder(w).Encode(...)`, error dropped ×18 | `writeJSON` helper, encode failures logged | one call site to audit |
| `http.Server` | no `ReadHeaderTimeout` | 10s | unbounded header read is a slow-loris vector |
| scraper "settle" wait | `time.Sleep(3s)` | `select` on `ctx.Done()` | SIGTERM lands promptly |
| scraper `DownloadDirect` | `defer out.Close()` (error dropped) | `Close` checked | a failed final flush is exactly how a truncated CSV reaches GCS |
| discovery download-dir cleanup | `defer os.RemoveAll` registered only **after** a successful download | registered as soon as the dir may exist | a failed scrape left the scratch dir behind |
| `POST /api/sync/all` background goroutine | `context.Background()` | **unchanged** | deliberately outlives both the request and the shutdown drain; the sweep is checkpointed/resumable. Documented at the call site rather than "fixed". |
| OTel identity | service `shorted-market-data-sync`, metric attr `market-data-sync`; `asx-discovery` | unchanged | dashboard continuity — the two market-data identities differed in the original and are carried over as-is |

### Daily price sweep (`market-data sync`, job `shorted-price-sync`)

Until 2026-09 the daily sweep ran behind `serve`'s `POST /api/sync/all`: a
goroutine on a CPU-throttled service with a 600s request ceiling. It restarted
from the top of the list every day, spent ~8s a stock re-fetching holiday
closures as "gaps" (Easter and Christmas never close, so they never stopped
being gaps), and never reached the end: 37 of 51 sampled stocks had no price
after 2026-08-20. It is a Cloud Run Job now, and each stock costs at most one
request:

- **Stocks**: every company on the ASX listing (`asx-stocks/latest.csv`), the
  top shorted, and what the listing does not carry but is still trading: every
  code in the last 90 days of ASIC short reports and every code holding a
  session within 90 days of the newest stored one. The listing is companies
  only, so ETFs (GDX, VAS, IOZ, STW) had never been swept; the old service
  reached them through its gap repair, and they stopped with it on 2026-08-20.
  Recent, not ever: Yahoo holds nothing for a delisted ASX code (#591), and
  both windows run from the newest data, so an outage cannot age a code out.
- **Window**: from the day after the stock's latest stored session to the last
  closed ASX session (a weekday, from 17:00 Sydney time). A stock already there
  is not requested at all. No gap repair in the sweep; gaps are `audit-gaps`,
  `historical-backfill` and `/api/gaps`.
- **Order**: stalest first (ties keep the top-shorted-first order; stocks with
  nothing stored go last), so a run that stops early is resumed by the next.
- **Session dates** come from Sydney time. Yahoo stamps a bar with the session's
  open in UTC, which in daylight time is the previous UTC day; the UTC date
  filed every October-April session a day early (Monday under Sunday), and each
  Friday, then "missing", was filled from Alpha Vantage with the US security of
  the same name (BHP's Fridays in Oct-Nov 2025 hold $55-57, NYSE's price, against
~$43 on the ASX).
- **Yahoo** goes through `pkg/stealthhttp` (a plain client is answered 429).
  Null bars are skipped, not stored as $0.
- **Alpha Vantage** is asked only when Yahoo fails to answer, never when Yahoo
  says a window has no session, and a response for a different security is
  refused (#583's guard, which only ever reached the retired standalone
  service). Its requests time out at 30s (`http.DefaultClient` never did).
- **Failures**: "no data" over a window of more than three weekdays is a strike
  (three strikes block a code for 7 days); a 429, 5xx or timeout is not, and 25
  in a row stop the run. `RecordFailure` had never written a row in prod (its
  timestamp arithmetic failed under the simple protocol), so blocks start now.
- **Writes**: one statement per stock (an `unnest` upsert). Prices are
  `NUMERIC(12,4)` from migration 000131, which the prod deploy applies; before it,
  `DECIMAL(10,2)` rounded every price to the cent (ENL's $0.045 as 0.05) and
  stored a price under half a cent as $0.
  A `-from` comparison allows half a unit of the column's last decimal, read
  from the column, so it is right on either side of the migration.
- **Deadline**: each stock gets 6 minutes, whatever it is waiting on (a
  provider, the database), and a stock that runs out is a failure, not a
  strike. The catch-up's first attempt on 2026-09-27 reached its 6-hour task
  timeout after at most ~1,700 mostly one-request stocks; its retry did the
  remaining 127 ten-year fetches in 28 minutes. The cause is not in the report
  that survived, so the report now records where the time goes (below).

Flags: `-from DATE` re-fetches every stock (or `-codes A,B`) from `DATE`,
overwriting stored sessions and reporting where they differed and which stored
sessions the provider does not have (reported, never deleted); `-dry-run`
fetches and compares and writes nothing. Each run stores a report at
`gs://<GCS_BUCKET_NAME>/price-sync/<execution>.json`, which the **Price Sync**
workflow (`.github/workflows/price-sync.yml`) runs and prints; CI cannot read
Cloud Logging. The workflow starts the execution detached and waits at most
340 minutes; a run that outlasts that (a long `task_timeout`, a whole-market
`from`) is read later by dispatching it with `report_only` set to the
execution's name or `latest`, which starts nothing. A task that times out
still writes its report (SIGTERM ends the sweep, which then publishes), and the
workflow prints how the execution ended beside it: a timeout or a retry shows
there, not in the report. The report also says where the time went (each
provider's requests and seconds, the wait on rate limits, the ten slowest
stocks), is published every 100 stocks while the run goes (`in_progress`), and
each attempt keeps its own copy at `price-sync/<execution>/attempt-<n>.json`,
because a retry overwrites the execution's report.

`shorted market-data prune` (the workflow's `mode: prune`) deletes what the
sweep never does: stored rows dated on a weekend, and rows on an ASX holiday.
Most are the daylight-time dating defect, which filed each Monday's session
under the Sunday before it and a session after a holiday under the holiday
(62,026 weekend rows in 2024-10 to 2026-09 alone). Holidays are the weekdays on
which none of ten reference stocks (BHP, CBA, CSL, NAB, WBC, ANZ, RIO, WES, TLS,
WOW) holds a session at the primary provider; the fallback is never asked, and
a failed reference, or a year with more than 15 such weekdays, deletes nothing.
A weekday row on a trading day is kept even when the provider no longer has it:
Yahoo's histories for some codes (ASM, AII, C1X) start on 2026-07-17, so the
stored rows are the only record. Run it with `dry_run` first: the report lists
the rows per year and per holiday, so the dates can be checked against the
ASX's calendar. `from` bounds the holiday calendar; weekend rows are deleted
wherever they are.

### Not ported

- **`cmd/test-dmp-fetch`, `cmd/test-dmp-backfill`** — single-stock ("DMP")
  scratch probes with a hard-coded symbol; scratch tooling, not a job.
- **`cmd/fetch-single-stock`** — subsumed by
  `shorted market-data historical-backfill -symbol <CODE> -force -years N`,
  which does the same force-fetch-and-upsert over the same provider chain.
  (It is **not** the same as `POST /api/sync/stock/{symbol}`, which is
  incremental + gap-repair, not a forced full-history refetch.)
- **`market-data-sync/otel.go`** — a second, unreferenced OTel bootstrap
  (`initOTEL`) that nothing in that module ever called; `pkg/otel.InitProvider`
  is the live path and is what the port uses.
- **`//go:build integration` tests** in both modules (they need
  `testcontainers-go`, which this module does not depend on). All three
  scratch CLIs and the integration tests remain runnable from the old modules
  until the deletion PR.

### Dependency versions

New direct requirements in `jobs/go.mod`, and how they compare to the source
modules:

| Module | Source module pins | jobs pins | Note |
|---|---|---|---|
| `github.com/google/uuid` | `v1.6.0` | `v1.6.0` | same (was already an indirect here) |
| `github.com/piquette/finance-go` | `v1.1.0` | `v1.1.0` | same — see the caveat below |
| `github.com/mxschmitt/playwright-go` | — (see below) | `v0.6100.0` | same version the scraper compiles against today |
| `cloud.google.com/go/storage` | `v1.58.0` | **`v1.64.0`** | **forced upward** — the jobs module already pinned 1.64 for other jobs |
| `google.golang.org/api` | `v0.258.0` | **`v0.290.0`** | **forced upward**, same reason |
| `github.com/jackc/pgx/v5` | `v5.8.0` | **`v5.10.0`** | **forced upward**, same reason |
| `go.opentelemetry.io/otel*` | `v1.40.0` | **`v1.44.0`** | **forced upward**, same reason |

**`finance-go` is carried for an unused provider.** `providers/yahoo.go`
(`NewYahooFinanceProvider`, the finance-go implementation) has no caller in
either module — the live chain is `NewYahooFinanceDirectProvider` plus optional
Alpha Vantage. It was ported unchanged rather than pruned, because deleting a
provider implementation is a product decision, not a mechanical port. Dropping
`providers/yahoo.go` + `yahoo_test.go` would remove `github.com/piquette/finance-go`
(and its `shopspring/decimal` transitive) from the shared module entirely —
a good follow-up, deliberately not bundled into this slice.

The four forced convergences are all *upgrades* of the source modules' pins onto
what the consolidated module already used for the eight previously-ported jobs;
downgrading the shared module to match one source service was not an option. The
old modules keep their own pins (their `go.mod`s are untouched).

**CUTOVER STATUS (slice 3, shipped):** this risk is now LIVE — both surfaces
run from the shorted-jobs images, so prod is on pgx 5.10.0 / otel 1.44.0 /
storage 1.64.0 / google-api 0.290.0 for market-data + discovery. Rollback is a
Terraform variable flip (`market_data_sync_image_override` /
`asx_discovery_image_override` back to `""`) or, for the service,
`gcloud run services update-traffic market-data-sync --to-revisions=<prev>=100`.
See "Cutover slice 3" in `docs/jobs-consolidation-plan.md`.

**CUTOVER RISK — these upgrades are a REAL runtime change for the deployed
images.** Local/dev builds resolve through the full `services/go.work` union
(which includes `./jobs`, dragging versions up), but the DEPLOYED images build
a two-module workspace (`go work init . ./market-data-sync` and
`. ./asx-discovery` in their Dockerfiles), which resolves the LOWER versions:
storage v1.58.0, google-api v0.258.0, pgx v5.9.2, otel v1.40.0. Cutting these
two jobs over to the shorted-jobs image therefore upgrades all four in prod
(pgx 5.9.2→5.10.0, otel 1.40→1.44, storage 1.58→1.64, api 0.258→0.290). If
post-cutover behaviour differs, check these versions before suspecting the
port. (pgx 5.10 is already proven in prod by the eight other monolith jobs.)

### The playwright pin — a landmine found during the port

`services/asx-discovery/go.mod` requires
`github.com/playwright-community/playwright-go v0.5200.1`, but
`scraper/asx_scraper.go` imports **`github.com/mxschmitt/playwright-go`**, which
that module never requires. It compiles only because `services/go.work` unions
in the parent `services` module's `github.com/mxschmitt/playwright-go v0.6100.0`
— and the service's own Dockerfile does `go work init . ./asx-discovery`, so the
deployed image resolves the same way. The declared dependency is dead.

That makes the old image's Chromium pin wrong in two independent ways:

- `asx-discovery/Dockerfile` installs `playwright@1.57.0`, citing "playwright-go
  v0.5200.1 (driver 1.57.0)". v0.5200.1's `playwrightCliVersion` is **1.52.0**.
- The driver actually linked is v0.6100.0's, i.e. **1.61.1**.

So the pre-bundled Chromium has never matched the driver, and `discovery` has
been re-downloading ~165 MiB of Chromium from `cdn.playwright.dev` on every run
— the exact failure that pin was added to prevent.

`Dockerfile.browser` therefore pins **`playwright@1.61.1`**, matching
`playwrightCliVersion` in the `mxschmitt/playwright-go v0.6100.0` that
`jobs/go.mod` now requires directly (no workspace accident). It deliberately
does NOT copy asx-discovery's 1.57.0. Everything else in the browser stage —
Debian base, Node install, the Chromium shared-library list, the
`PLAYWRIGHT_BROWSERS_PATH` / `ms-playwright-go` / `/tmp/asx-downloads`
directories, `DOWNLOAD_DIR` — is copied verbatim. **Keep the npm pin in lockstep
with `playwrightCliVersion` on any playwright-go bump.**

Fixing the old module's dead requirement/pin is out of scope for this
code-only slice; it disappears when `services/asx-discovery` is deleted.

### Images

`Dockerfile` (distroless/static) stays lean and serves the other nine jobs.
`Dockerfile.browser` builds the **same binary** with the same build stage and
the same `services/` context, onto a Debian base carrying Chromium — only the
runtime differs, and only `discovery` needs it:

```bash
docker build -f services/jobs/Dockerfile.browser services
docker build -f services/jobs/Dockerfile.browser --secret id=github_token,env=GH_TOKEN services
```

Both images use `ENTRYPOINT ["/shorted"]`, so a Cloud Run Job passes the
subcommand as args (`args = ["discovery"]`).

## Phase 2d (house-prices) — retired

`services/house-price-collector` was ported here as `shorted house-prices`
(#358), code only: no Terraform, launchd or schedule change. The cutover never
happened. The Cloud Run job (`terraform/modules/house-price-collector`), the
residential-rig launchers (`services/house-price-collector/deploy/`, which exec
`$HOME/bin/house-price-collector`) and every Taskfile task kept running the
original service. Meanwhile the copy drifted: by 2026-09-23 it was 119 files
against the collector's 138, `store.go` differed by 110 lines, and fixes (NSW VG,
LGA, the MV refresh timeout) landed in one copy only. It was deleted on
2026-09-24 rather than kept in sync.

What it left behind is still live and still tested: the `runner.ExitCodeError`
/ `runner.ExitCodeOf` extension (see "Conventions for new jobs" §5) and
`TestExitCodeErrorSurvivesDispatch` in `internal/runner/runner_test.go`. If the
collector ever moves into this binary, port it fresh from
`services/house-price-collector` and cut the rig over in the same change; its
launchers branch on exit codes 3/4/5/6/7 (see that service's `deploy/README.md`).

## Phase 3 port notes (report-extract / director-trades)

The first Python→Go port that replaces **deployed** jobs:
`services/report-extractor` (3 scripts, ~1,650 LoC) →
`internal/jobs/reportextract` (1 package, 111 tests). **CODE ONLY** — no
Terraform, no schedule change, nothing deleted. `terraform/modules/report-extractor`
still points both Cloud Run Jobs at the Python image.

### Three scripts, two deployed jobs, one package

| Python | Deployed as | Go |
|---|---|---|
| `extract.py` (helper library + sequential CLI) | — (laptop only) | `shorted report-extract sequential` + the whole package's shared layer |
| `extract_reports_concurrent.py` | `financial-report-extractor` (daily 14:00 UTC, 120 reports) | `shorted report-extract concurrent` |
| `extract_director_trades.py` | `director-trade-extractor` (daily, 12:30 UTC) | `shorted director-trades` |

`report-extract` is a **`runner.Group`**, not one flat subcommand. The two report
scripts disagree on flag DEFAULTS (`--recent` 2 vs 0, `--workers` 8 vs a
sequential `--delay` loop, `--mode all` vs `top50`); folding them together would
have silently changed one caller's defaults, which is the exact failure this port
is supposed to avoid. `director-trades` is flat: one script, one job.
Python's `import extract` relationship is preserved by keeping all three in one
Go package, the way they share one module in Python.

Cutover args, for whenever the Terraform slice lands:

```hcl
# financial-report-extractor → shorted-report-extract
args = ["report-extract", "concurrent", "-recent", "2", "-limit", tostring(var.reports_limit),
        "-workers", "2", "-max-pages", "6", "-top-shorted-first"]
# director-trade-extractor → shorted-director-trades
args = ["director-trades", "-priority", "recent", "-limit", tostring(var.director_limit), "-workers", "2"]
```

(`--flag value` still parses — the stdlib `flag` package accepts double dashes —
so the existing arg lists work unchanged apart from the subcommand prefix.)

**The Python has since moved ahead of the port (2026-09-28,
`docs/plans/fundamentals-coverage.md` §6).** The deployed
`financial-report-extractor` now runs `--recent 2 --limit <reports_limit>
--workers 4 --max-pages 8 --budget-min 90` daily at 14:00 UTC (120 reports,
`GEMINI_MAX_RUN_WORKERS = 4`, 7200 s, no retries) and has dropped
`--top-shorted-first`. It selects ONE statutory results document per company
(filed within 45 days, newest first; then companies with no metric-bearing
extraction, by market cap; then the rest), drops an extraction whose value's
digits are not inside its aligned span, writes `document_meta`, stops starting
reports once `--budget-min` elapses, and runs Gemini with thinking off. The Go
port was brought to parity only on the synthetic few-shot example, dropping
unaligned extractions and stripping provenance keys before the digest prompt
(§6.3); it has none of the rest. The cut-over args above are therefore
historical: a cut-over would first need the targeting, the span-digit check,
`document_meta`, the budget and the thinking config ported, and the flag
tables below describe the port as it was made.

### Flag parity

`report-extract concurrent` ← `extract_reports_concurrent.py`

| Python | Go | Default | Same? |
|---|---|---|---|
| `--recent` | `-recent` | 2 | ✅ |
| `--limit` | `-limit` | 0 (=all, then capped by the run budget) | ✅ |
| `--workers` | `-workers` | 8 (capped to 2) | no since 2026-09-28: the Python default is 4 |
| `--model` | `-model` | `gemini-2.5-flash` | ✅ |
| `--max-pages` | `-max-pages` | 10 | no since 2026-09-28: the Python default is 8 |
| `--top-shorted-first` | `-top-shorted-first` | false | no since 2026-09-28: the Python dropped it |
| `--budget-min` | none | 90 (Python only) | no: not ported |
| `--backfill-digests` | `-backfill-digests` | false | ✅ |
| `--dry-run` | `-dry-run` | false (defaults from the global `-dry-run`) | ✅ + also gates GCS |

`report-extract sequential` ← `extract.py`

| Python | Go | Default | Same? |
|---|---|---|---|
| `--mode top50\|codes\|all` | `-mode` | `top50` | ✅ (invalid values now ERROR; argparse enforced choices, `flag` doesn't) |
| `--codes` | `-codes` | `""` | ✅ (non-empty still forces `mode=codes`) |
| `--limit` | `-limit` | 0 | ✅ |
| `--recent` | `-recent` | 0 | ✅ |
| `--model` | `-model` | `gemini-2.5-flash` | ✅ |
| `--delay` | `-delay` | 2.0s | ✅ (now a ctx-aware wait, not `time.sleep`) |
| `--max-pages` | `-max-pages` | 10 | no since 2026-09-28: the Python default is 8 |
| `--dry-run` | `-dry-run` | false | ✅ + also gates GCS |
| `--verbose` | `-verbose` | false | ✅ (per-metric dump; no global log-level change) |

`director-trades` ← `extract_director_trades.py`

| Python | Go | Default | Same? |
|---|---|---|---|
| `--limit` | `-limit` | 200 (capped to 20) | ✅ |
| `--priority recent\|unknown\|top-shorted` | `-priority` | `recent` | ✅ (invalid values now ERROR) |
| `--workers` | `-workers` | 6 (capped to 2) | ✅ |
| `--retry-after-days` | `-retry-after-days` | 30 | ✅ |
| `--dry-run` | `-dry-run` | false | ✅ |

Environment is unchanged: `DATABASE_URL`, `GEMINI_API_KEY`, `LANGEXTRACT_API_KEY`,
`GCS_REPORTS_BUCKET` (default `shorted-financial-reports`), `GEMINI_MAX_RUN_ITEMS`,
`GEMINI_MAX_RUN_WORKERS`. The per-script run-budget defaults (10/1, 10/2, 20/2)
and `_positive_int_env`'s fail-closed parsing came across exactly — a malformed
budget env still ERRORS rather than degrading to unlimited.

### DB / API interaction parity

| Interaction | Python | Go | Same? |
|---|---|---|---|
| report selection (`codes`) | `IN (%s,…)` on `"company-metadata"` | `= ANY($1)` — same predicate, 1 bind param | ✅ |
| report selection (`top50`) | `INNER JOIN (SELECT product_code FROM mv_top_shorts ORDER BY current_percent DESC LIMIT 50)` | verbatim | ✅ |
| report selection (`all`) | `financial_reports::text LIKE '%asx_announcements%' ORDER BY stock_code` | verbatim | no since 2026-09-28: the Python's `--mode all` now uses the scheduled run's statutory-first selection (`select_extraction_targets`) |
| type filter | 5 types, quarterlies excluded | verbatim | ✅ |
| §6.3(a) title noise filter | 24 noise + 6 keep-override regexes | verbatim (`(?i)` prefix instead of `re.IGNORECASE`) | ✅ |
| ordering | `sort(key=(code,date), reverse=True)` stable | `sort.SliceStable` with a `>` comparator | ✅ |
| per-company cap | `Counter` walk | same walk | ✅ |
| already-extracted skip | `report_url = ANY(%s)` | `= ANY($1)` | ✅ |
| top-shorted ordering | `rank.get(code, -1)`, stable reverse | same, stable | ✅ |
| digest backfill selection | `WHERE digest IS NULL` | verbatim | ✅ |
| extraction upsert | `ON CONFLICT (report_url) DO UPDATE` on 7 columns | verbatim; `""` → NULL for `report_date` (see below) | ⚠️ |
| `digest_confidence` NULL rule | only stored alongside a non-empty digest | verbatim | ✅ |
| `digest_model` | the CONSTANT `gemini-2.5-flash`, NOT `--model` | verbatim (latent bug, see below) | ✅ |
| `raw_text_length` | `len(text)` = CODE POINTS | `utf8.RuneCountInString` | ✅ |
| GCS object path | `digests/<code>/<sha1(url)>.txt`, `text/plain; charset=utf-8` | verbatim | ✅ |
| director selection | `DISTINCT ON (announcement_url)` + `~ '^https?://'` + `(director_name='Unknown Director' OR total_value IS NULL)`, outer re-sort by `trade_date DESC LIMIT` | verbatim | ✅ |
| §6.9 cool-off | `NOT EXISTS (… last_attempted_at > NOW() - make_interval(days => %s))`, appended only when `director_extract_attempts` exists | verbatim; params still (days, limit) and renumber to `$1` when the clause is absent | ✅ |
| attempt marker | `ON CONFLICT DO UPDATE attempts = attempts + 1` | verbatim | ✅ |
| director write-back | `UPDATE … trade_date = COALESCE(%s::date, trade_date) WHERE announcement_url = %s` | verbatim | ✅ |
| ASX PDF fetch | `requests.Session` + `ASX_HEADERS`, 15s resolve / 60s download, `%PDF-` magic, `name="pdfURL"` hidden field | verbatim; one shared `http.Client` (thread-safe) instead of one Session per thread, and the body is bounded at 64 MiB | ⚠️ |
| langextract call | `lx.extract(prompt, examples, model_id, passes=1, max_workers=1, max_char_buffer=2000)` | same options through `langextract.ExtractRaw` | ✅ |
| Gemini digest | system=`DIGEST_PROMPT`, temp 0.2, no response MIME, fence-strip + JSON parse | verbatim | ✅ |
| Gemini 3Y extract | system=`EXTRACT_PROMPT`, temp 0.0, `response_mime_type=application/json`, text[:6000] | verbatim | ✅ |
| API-key precedence | digest: `GEMINI_API_KEY` → `LANGEXTRACT_API_KEY`; langextract: the reverse | both preserved | ✅ |

### 🚨 LOUD CALLOUTS

**1. PDF text extraction is NOT byte-identical — the engine changed.**
Python used **pymupdf** (MuPDF). There is no pure-Go MuPDF, and a cgo binding
(`go-fitz`) cannot ship in the distroless/static image, so this uses
**`github.com/ledongthuc/pdf`** (a new direct dependency; it was already in
`go.sum` as a chromedp test transitive). Page selection (`max-pages`), the
`"\n\n"` page join and the `<100 chars → treat as no text` floor are unchanged,
but **layout, whitespace, column ordering and glyph/encoding coverage differ**.
Consequences to expect at cutover:
- `raw_text_length` values will not match Python's for the same PDF.
- Some PDFs pymupdf reads will yield **no** text here (ledongthuc has weaker
  CMap/embedded-font coverage) → more `no_pdf`/`no_text` outcomes.
- Metric extraction and digest quality are downstream of that text, so a
  side-by-side parity run on a sample of real announcements is **required**
  before the scheduler is repointed. This is the single highest-risk item in
  this port.
The reader also **panics** on malformed xref tables instead of erroring; every
call is wrapped in a `recover` so one corrupt filing can't kill the batch.

**2. langextract semantic gaps (Go port vs Python library).**
- **API key**: the Python library reads `LANGEXTRACT_API_KEY` from the
  environment implicitly. The Go port requires it in
  `ModelConfig.ProviderKwargs["api_key"]`, so the package reads the env itself
  (`LANGEXTRACT_API_KEY` → `GEMINI_API_KEY`). Same effective behaviour, one more
  explicit hop.
- **Missing key**: Python reached `lx.extract` with no key and its blanket
  `except` turned the provider error into "no extractions + a warning". The Go
  port short-circuits with the same warning and the same empty result, so the
  digest-from-raw-text path still runs.
- **Prompt-example validation** defaults to `PromptValidationWarning` in the Go
  port. The `revenue` few-shot example's `extraction_text` joins two source lines
  with a space where the example text has a newline, so it does not align
  exactly — this is true of the Python original too and produces a warning, not a
  failure. Pinned by `TestExtractionExamplesAlignToTheirSourceText`.
- **`fetch_urls` defaults to TRUE in both** libraries: if a PDF's extracted text
  ever began with a bare URL it would be fetched instead of extracted. Inherited
  hazard, deliberately not "fixed" so behaviour matches.
- **Attribute typing**: Python attributes are `dict[str, str]`; Go's are
  `map[string]any`. Where the model returns a JSON number both libraries keep the
  parsed type, so the stored JSON agrees.
- **JSON key order**: Go marshals map keys sorted, Python preserved insertion
  order. The column is `jsonb`, which does not preserve key order, so there is no
  observable difference in stored data.
- No other semantic gap was found between the two libraries for this call shape
  (single pass, 1 worker, 2000-char buffer, Gemini provider).

**3. `digest_model` mislabels rows when `--model` is overridden (Python bug,
carried over).** `extract.py` passes `--model` to `summarize_report` but persists
the CONSTANT `DIGEST_MODEL` in the `digest_model` column. Reproduced rather than
fixed — `digest_model` is stored data, and "fixing" it would make Go-written rows
disagree with every Python-written row for the same invocation. Fix it as a
deliberate data decision, not as part of a port.

**4. `-dry-run` now gates the GCS upload.** `extract.py` and
`extract_reports_concurrent.py` called `upload_raw_text_to_gcs` **before** the
dry-run check inside `store_extraction`, so `--dry-run` genuinely wrote objects
to `shorted-financial-reports`. The consolidated binary's rule is that a dry run
writes nothing, so the upload is stubbed out (the READ path stays live so the
digest backfill is still exercised).

**5. Empty `report_date` now writes NULL instead of failing.** Python passed the
financial_reports JSON's `date` straight through; an empty string against the
`DATE` column raised a psycopg2 `DataError` and lost the row. Non-empty dates are
unaffected. Same for `report_type` / `report_title` / `raw_text_gcs_url`.

**6. Cancellation is now an error.** Python's `ThreadPoolExecutor` swallowed
every worker exception into an `error` tally entry and always exited 0 — an
interrupted run looked clean. Here a per-item failure is still just a tally
entry, but a CANCELLED run (SIGTERM, Cloud Run task timeout) returns an error so
the job reports `status=error`. Selection is idempotent (already-extracted URLs
skip; the §6.9 cool-off skips), so the next run resumes.

**7. Missing Gemini key now fails `director-trades` up front.** Python called
`sys.exit(1)` from inside the first worker thread; the Go port checks before
opening a pool and returns the same message.

**8. Known regex gaps preserved.** `on-?market buy-?back` / `buy-?back` require a
hyphen-or-nothing between the words, so `"On market buyback"` is KEPT by both
implementations. Pinned by `TestKnownNoisePatternGapsMatchPython` so a future
"fix" is a deliberate decision.

**9. Selection targeting now DIVERGES from Python (2026-09-27, on purpose).**
`parseReportRows` applies `isExtractionTarget` after the Python noise filter:
presentations, webinars, briefings, "to present", results-date notices, any
"Notice of", AGM "Results of Meeting", dividend notices and every quarterly /
Appendix 4C / activities report are excluded (a statutory marker overrides
all but the quarterly rule), and `prioritiseForExtraction` orders statutory
Appendix 4D/4E filings FIRST, then other results documents, then the rest
(most-shorted, then newest, within a tier; `-top-shorted-first` is no longer
the primary key). Reason: the weekly run is the only path to half-year totals
for the stock picker (`shorted picks -mode filings`), and ~98% of what the
Python order extracted had no metrics. `isFinancialReportTitle` itself is
unchanged and still pinned against Python. This changes what the CUT-OVER
does: the Go job will extract a different (statutory) set than the Python job
it replaces. The cut-over itself is unchanged and not done: a
`modules/shorted-job` pair with the args above (`report-extract concurrent
-recent 2 -limit <reports_limit> -workers 2 -max-pages 6 -top-shorted-first`,
same `GEMINI_MAX_RUN_ITEMS` / `GEMINI_MAX_RUN_WORKERS` env and Gemini secret),
`scheduler_paused = true` on the old module, after the side-by-side PDF parity
run callout 1 requires.

Superseded on 2026-09-28: the PYTHON is now statutory-first itself, with a
different order (one document per company; recent filers, then companies with
no parsed filing by market cap, then the rest) and the statutory classifier of
`services/pkg/extractiontrust` (`IsResultsDocument`) ported to Python against a
shared title fixture. The statutory targeting therefore reached prod through
the Python, not through this cut-over, and the two now diverge the other way
(see the note under "Cutover args").

### Not ported

- **`compare_models.py`** — a scratch model-comparison harness (no infra, no
  schedule, no DB writes beyond reads); scratch tooling, not a job.
- **`test_extract.py`** — the Python unit tests; their coverage is replaced (and
  extended) by the 111 Go tests in this package.
- **`ensure_table()`** — already dead in `extract.py` (commented out at the call
  site; the schema is migration 000045).
- **`Dockerfile` / `requirements.txt`** — the standard `services/jobs/Dockerfile`
  serves both jobs; no browser and no Python runtime are needed.
- **Terraform** — `modules/report-extractor` is untouched. The cutover (a
  `modules/shorted-job` pair + `scheduler_paused = true` on the old module) is
  its own PR, per the plan's invariants.

### Tests

111 tests, all offline — no Gemini, no database, no GCS, no live ASX. The
collaborators (`pdfFetcher`, `blobStore`, `extractionStore`, `summarizer`,
`directorExtractor`, and langextract itself via an injected `extractFn`) are
interfaces precisely so the pipelines can be exercised end-to-end with fixtures.
The only network in the suite is a local `httptest` server proving the ASX
display-URL → PDF-URL resolution and the browser-header contract.

## Phase 3 port notes (short-data-sync)

`services/daily-sync/deprecated/comprehensive_daily_sync.py` (the DEPLOYED
script — `services/short-data-sync/main.py` was a never-deployed sibling) →
`internal/jobs/shortdatasync`. Both Python trees have since been **deleted**:
the port landed first (code only), then cutover slice 4 swapped the
`shorts-data-sync` job's image in place, and the cleanup slice removed the
Python sources, the `short_data_sync_image` variable and the `short-data-sync`
CI image build. Full detail, env table, divergences and the shadow-run
procedure: `internal/jobs/shortdatasync/README.md`.

- **Scope split.** The Python bundled THREE pipelines. Only the ASIC shorts tier
  is ported here (download → parse → upsert → health report → MV refresh →
  revalidate → Algolia → `sync_status`). The `stock_prices` sweep is ALREADY
  `shorted market-data serve|sync` (Phase 2c) and is deliberately not ported a
  second time. The `key_metrics` refresh of `"company-metadata"` is already owned
  by the shorts API's `SyncKeyMetrics` RPC + daily `key-metrics-scheduler`
  (enabled in prod); the Python job was a duplicate writer, so the cutover PR
  only needs to confirm that scheduler is healthy.
- **Exit code 2 retires with the stock loop.** It existed so Cloud Run would
  retry a run that had finished only part of its 500-stock batch. Shorts-only
  runs have no partial state: exit 0 / exit 1 like every other job. The Cloud
  Run Job's `max_retries = 5` and `timeout = 28800s` are sized for the ~5h price
  sweep and want right-sizing at cutover.
- **Both of the same-day fixes to the Python are carried over**: the MV refresh
  sends `SET statement_timeout = 0; SELECT refresh_all_materialized_views()` as
  ONE simple-protocol command (two Execs can land on different backends through
  the transaction pooler), and `trigger_frontend_revalidation` fires only when
  rows changed, through `platform.PingRevalidate` (header-only secret, redacted
  error logs).
- **Resume still keys on `CLOUD_RUN_EXECUTION`** (PR #231), never a calendar
  date, with a 20-hour rolling window off Cloud Run.
- **Legacy ASIC files now parse.** Encoding detection (UTF-8/UTF-16 BOM →
  UTF-8 validity → CP1252, hand-rolled, no `x/text` dependency) plus TAB/comma
  delimiter sniffing. Pre-2023 files are UTF-16LE + TAB and the Python silently
  ingested zero rows from them; the daily window contains none, so a scheduled
  run is unaffected and only a deep backfill diverges (in our favour).
- **`-shadow`** runs the whole read path, writes nothing and prints a JSON
  parity summary (per-date counts, would-insert/would-update, a
  sorted-tuple checksum) on stdout for diffing against the Python's actual
  writes. 46 offline tests, including golden fixtures cut from real ASIC files.

## picks

`shorted picks` is the data layer of the stock picker
(`docs/plans/stock-picker.md` §2, extended by
`docs/plans/fundamentals-coverage.md` §2-4). It is a new job, not a port.

| Mode | What it does |
|---|---|
| `-mode fundamentals` | The full statements into `stock_fundamentals` (migration 000129, widened by 000132), every attempt recorded in `stock_fundamentals_sync`. ONE Yahoo fundamentals-timeseries GET per code through `pkg/stealthhttp` (a plain client is 429'd; no cookie or crumb needed), 4s between requests like the price sweep: the annual and trailing income statement and cash flow, the annual and quarterly balance sheet, the share count. Sanity gates null bad values; Markit key statistics (plain HTTPS, 1/s) is the per-field fallback. Budget-driven, in priority order (below). |
| `-mode filings` | Revenue / net profit / EPS from `financial_report_extractions.metrics` (the report-extractor's reading of statutory results documents) into typed `'half'` and `'annual'` rows, source `asx-filing-extraction`, through the `services/pkg/extractiontrust` funnel and nine gates. The only source of half-year totals (Yahoo has none for the ASX). A fail-closed deterministic rebuild in ONE transaction. DB-only: no network, no LLM. |
| `-mode refresh` | `BEGIN; SET LOCAL statement_timeout = 0; SELECT refresh_strategy_views(); COMMIT` as one simple-protocol command (000132's body: `mv_market_regime`, `mv_fundamentals_growth`, `mv_fundamentals_quality`, `mv_price_features`). Fails if the function reports any `Skipping <view>` warning, because the function itself returns normally when a view is skipped. After a successful refresh it waits 16 minutes (the API's 15-minute strategy cache, plus one), then pings `/api/revalidate` best-effort with tag `strategy-picks`, plus `fundamentals` when this execution's fundamentals or filings step changed rows. |
| `-mode all` (default) | fundamentals, then filings, then refresh. The refresh runs even after a degraded pull; the worst step decides the exit code. |

**Schedule** (`module "shorted_job_picks"` in `terraform/environments/prod/main.tf`):
`-mode refresh` weekdays 13:30 UTC, after the 10:00 UTC price sweep; `-mode
all` daily 15:00 UTC. `timeout_seconds = 12600`, `max_retries = 1`, env
`PICKS_FUNDAMENTALS_BUDGET_MIN = "170"` and `REVALIDATION_URL`, secrets
`DATABASE_URL` and `REVALIDATION_SECRET`. `PICKS_FUNDAMENTALS_MAX_CODES` is
deliberately not set.

**Run lease.** `-mode fundamentals`, `filings` and `all` claim the one
`picks_run_lease` row (`name = 'picks'`, 4 hours, extended every 100 codes,
deleted on exit; the holder is the Cloud Run execution, so a task retry takes
back the lease its dead attempt left). A run that finds it held by another
execution logs the holder and exits 0. `-mode refresh` and dry runs take no
lease, and `-mode all` releases it before the refresh, so the 16-minute wait
holds nothing. Without the table (000132 absent) the job runs without it.

**Selection** (fundamentals). The universe is every code with a `stock_prices`
row in the last 90 days plus every `mv_screener_data` code (the MV is optional:
42P01 is tolerated). There is no count cap: the run takes codes in this order
until `PICKS_FUNDAMENTALS_BUDGET_MIN` (170 minutes; the ~2,300-code universe is
~155 minutes at 4s) elapses, and what is left carries to the next night, lowest
priority first:

1. **due filers**: an Appendix 4D/4E or period-results headline in
   `asx_announcements` in the last 14 days that the code has not had a
   successful pull since, plus one follow-up pull once the filing is 7 days old
   (Yahoo lags small caps). An "Annual Report" headline does not count: it
   lands weeks after the 4E that moved the numbers. Never-succeeded first;
2. **never attempted**, by market cap descending, then 20-day dollar volume,
   then code;
3. **last outcome `failed`**, oldest attempt first (failures are never skipped);
4. **stale**: successes and single empties older than 14 days, and repeat
   empties (`consecutive_empty >= 2`) older than 45 days, oldest attempt first.

Headlines are classified by the regexes ported from
`scripts/take-writer/src/results-watch.ts` (`filings.go`; keep the two in
step), never by `announcement_type`. The log line `queued: due_filers=N
never_attempted=N failed=N stale=N skipped=N` shows the split.

**Breakers.** A run stops taking codes after 25 consecutive failed codes (the
price sweep's rule), or when more than 30 of the last 100 Yahoo requests failed
(`stopped_early=error_rate`: a partly blocking Yahoo never trips the
consecutive breaker). Markit is disabled for the rest of the run after 10
consecutive Markit failures (`fallback_disabled`). On a Cloud Run task retry
(`CLOUD_RUN_TASK_ATTEMPT > 0`) the budget is 20 minutes: the retry exists to
finish filings and the refresh, not to run a second full pass.

**What is stored** (vendor). `annual`, `ttm` and `quarter` rows, `period_end`
exactly as the source dates it, values in the REPORTING currency (BHP is USD)
with the row's `currency`; outflows (capex, dividends paid, buybacks) are
negative, Yahoo's convention. A `quarter` row is a balance-sheet snapshot:
balance lines and shares only, from Yahoo's `quarterly*` series; one dated at a
fiscal year end also fills the annual row's NULL balance fields. Operating cash
flow is the reported series, else the direct-method series, else free cash flow
minus capex on the same period (`derived:fcf-minus-capex`, never over a reported
value). A TTM row dated at the fiscal year end fills every flow field the
annual row for that date lacks (`derived:ttm-at-fye`). `fiscal_year` is derived
from the company's own balance date (its latest annual row; June when there is
none). Non-finite values and values outside `1e-12 <= |v| <= 1e18` are set to
NULL before the write; the table has the same CHECKs as a backstop.

`field_sources` (JSONB) records ONLY the fields whose value did not come from
the row's own `source`: `markit-key-statistics`, `asx-filing-extraction`,
`derived:fcf-minus-capex`, `derived:ttm-at-fye`. The vendor upsert (`store.go`,
per field, same currency):

1. the vendor supplies the value: take it;
2. a sanity gate rejected it: write NULL (never keep an earlier run's copy of
   a value that now fails);
3. otherwise keep the stored value on `ttm` rows and `quarter` snapshots
   (Yahoo keeps TTM revenue only at the latest point or two, so the history is
   ours to keep), or when `field_sources` names a filing or Markit;
4. otherwise, on `annual` rows, NULL;
5. a stored FILING row is taken over only when the vendor supplies revenue or
   net income for that period, and every value kept from it is then marked
   `asx-filing-extraction`;
6. a currency change replaces the row and its `field_sources` wholesale.

A Markit row never takes over a Yahoo row.

**Markit** is asked when Yahoo failed or published nothing, has no annual row,
is visibly behind (a TTM point a year past the latest annual, or the latest
annual older than ~15 months), when the latest annual lacks revenue or net
income (the EPS-only Yahoo year: MAQ, LOV), when a gate refused an annual
revenue or net income, and for an FX-converted code (for its native currency).
Per annual period, Markit's revenue / net income fill a Yahoo row's NULLs in the
same currency, and years Yahoo lacks are added as Markit rows.

**Sanity gates.** Each rejection is counted in the run summary, logged per code
and written as NULL:

| Gate | Rejects |
|---|---|
| `currency_conflict` | one monetary field whose point is in another currency than its row (shares and EPS ignore `currencyCode`) |
| `fx_converted` | every monetary field of a code with a fractional raw value on a normally integral line: Yahoo converted its statements, EPS included, so every monetary and per-share Yahoo field is rejected (shares kept) and filings supply the native EPS (XRO's FY25 EPS 1.3541 is AUD-converted; the NZD figure is ~1.49). Sets `stock_fundamentals_sync.fx_converted`, and `native_currency` from Markit's `curCode` |
| `identity_outlier` | a period's monetary fields (EPS and shares kept) when k = net income / (basic EPS x shares) is more than 3x off the code's median k, with at least 3 periods. The median, not 1, is the reference: a CDI such as RMD has k near 10. It is stored as `median_k` for valuation |
| `scale_break` | every monetary field of a period where revenue, gross profit, total or current assets or liabilities is below 1/20 of BOTH neighbours in its series (IAG FY25 revenue 5.35m against ~14bn) |
| `non_positive_assets` | a period's balance fields when total assets <= 0 |
| `eps_sign_mismatch` | basic and diluted EPS of opposite signs (both) |
| `sign_violation` | capex, dividends paid or buybacks > 0 |
| `stray_ttm` | a TTM point older than the latest annual end minus 18 months |

`stock_fundamentals_sync` records `last_outcome` (`loaded` | `empty` |
`failed`; `empty` only when every source asked answered without error and
without rows), `consecutive_empty`, and, only on a loaded attempt that Yahoo
answered without error, `median_k`, `fx_converted` and `native_currency` (any
other attempt keeps the stored values).

**Filings (`-mode filings`)**. What is read, and what keeps an LLM mistake out
of the table (`filings_ingest.go`, `filings_period.go`, `filings_values.go`,
`filings_vendor.go`). The permissive first version published the prompt's own
few-shot example (revenue $5,142m, NPAT $1,823m, EPS 94.2c) as BHP's, CBA's,
DRO's, EDV's and MSB's results, comparatives as current (CBA), channel and
segment sales as revenue (EDV, GYG, DMP, FLT), another company's report (LFT),
"Profit from operations" as NPAT (BHP) and December filers dated June (DRO).
Every value now passes nine gates in order, each counted in the run summary
(`gates={...}`):

1. **Document**: `digest_confidence >= 0.3` (NULL passes); a statutory results
   document (`extractiontrust.IsResultsDocument` over the title and
   `document_meta.report_kind`: 4D/4E, half-year and annual reports,
   preliminary final, results announcements; never Pillar 3, Form 20-F,
   presentations, webcasts, transcripts); `document_meta.entity`, when present,
   names the code's company; `report_kind` is not `other`.
2. **Grounding** and 3. **few-shot denylist**: `extractiontrust.GroundedEntry`
   (the extractor aligned the quote to the document, and the quote is not
   either few-shot example's text; the denylist is by text, never by value:
   CBA's real 1H25 NPAT is also $5,142m).
4. **Own period**: the metric's period is the document's own period
   (`document_meta.period_end`, else the latest half or annual end on or
   before the report date on the company's balance date, within 5 months), and
   the quote does not name only another period.
5. **Statutory**: the quote names no underlying, normalised, adjusted, pro
   forma, EBITDA / EBIT, segment, division, "profit from operations",
   operating profit, profit before tax, cash NPAT, total comprehensive income,
   network / online / channel sales or TTV figure (`nonStatutoryRe`).
6. **Vendor context**: the code has a vendor annual row and a trustworthy
   vendor currency; balance month and currency come from the vendor (there is
   no June or AUD default any more). An FX-converted or mixed-currency code
   uses Markit's native currency when a Markit row exists, else gets no filing
   rows (`skipped_no_vendor`, `currency_unknown`).
7. **Currency**: an explicit marker in the quote, and `document_meta.currency`,
   must equal the vendor currency.
8. **Magnitude**, against same-currency vendor references: half revenue in
   [0.25, 0.75] of vendor TTM revenue at the same end, else of the containing
   FY, else [0.15, 1.5] of the prior FY; annual revenue in [0.7, 1.4] of the
   same FY, else [0.5, 2.5] of the prior FY; net income <= 1.5x revenue (not
   for property / investment entities); EPS within [0.5, 2] of net income /
   vendor shares, written only when that check can run.
9. **TTM-EPS identity** for first halves, when all four inputs exist:
   `|(H1 - H1 prior) - (TTM at the half end - prior FY)| <= max(10% x |TTM -
   FY|, 2% x |FY EPS|, 0.01)`.

Reading a value out of its quote (`filings_values.go`) is unchanged in spirit:
a value is taken only when its number is FOUND in its own `source_text` in a
unit the quote makes unambiguous ("$45.2 million", "$1.2bn", "$45,213,000", a
`$m` / `$'000` heading). A bare table figure is scaled by
`document_meta.units` (the 4D/4E summary tables' "US$ Million" header) or
skipped. EPS is stored in currency units per share: the unit is read next to
the value's own number (`c` / `cents` / `cps` / `¢` is cents, divided by 100;
`$0.94` is dollars); "loss per share" or a parenthesised number is negative;
basic vs diluted from the nearest qualifier before the number. One document
giving two values for one period is skipped. Several documents for one period:
per column, the Appendix 4D/4E beats another results document, then the
document filed closest after the period end, then the URL.

**Period parser** (`parsePeriod`), in order:

1. The headline gates the report: scheduling notices, webinars, "to present",
   any "Notice of", AGM "Results of Meeting", dividend admin (the
   `notAFiling` list, with the `strongFiling` override) and every quarterly /
   Appendix 4C / activities report are rejected before any metric is read.
2. A period naming a quarter, nine months, YTD, guidance, a forecast (`FY27E`)
   or a comparative (`pcp`, "prior") is rejected.
3. Type: half words (H1, 1H, HY, 2H, half-year, interim, six months) win over
   annual words (FY, full year, annual, twelve months, year). Neither: the
   headline decides (4D / half-year -> half; 4E / annual report / full year /
   preliminary final -> annual), else rejected.
4. End: an explicit date wins ("30 June 2025", "31/12/2024", "December 2024").
   Otherwise the FY label (FY25, FY2025, 1H26, H1 FY2025, 1HFY26, 2025/26,
   CY2025) goes on the company's balance date: FY Y ends in the balance month
   of Y; H1 ends six months earlier (June year: H1 FY26 = 31 Dec 2025;
   December year, e.g. DroneShield: H1 FY26 = 30 Jun 2026). No year at all
   ("H1"): the latest such end on or before the report date. No year and no
   report date: rejected.
5. Balance month: the period's own date, else the vendor's annual rows, else a
   dated headline. There is NO default; in practice the vendor decides (gate 6
   runs first).
6. With a report date: the period must end no later than 7 days after it (a
   later end is guidance) and no more than 15 months before it (a comparative).
7. Every end is folded to a month end (a 52/53-week year to 2 July 2023 is
   June 2023), and an annual end within 10 days of a vendor annual row takes
   the vendor's date, so one period is one key.

**The rebuild** (`filings_store.go`, `RebuildFilings`): every run re-reads every
extraction and writes the complete picture in ONE transaction, every predicate
evaluated at write time:

1. delete every filing row whose key this run does not produce (never a vendor
   row);
2. per column, NULL each vendor field marked `field_sources =
   'asx-filing-extraction'` that this run does not reproduce, and drop the
   marker;
3. clear the document columns of vendor rows left with no filing value;
4. upsert: no stored row (every half; an annual the vendor has not published
   yet) is inserted whole; a stored FILING row is replaced; on a stored VENDOR
   row, per column and only in the same currency, the filing FILLS a NULL or
   REPLACES a value already marked `asx-filing-extraction`, recording the
   marker and `source_document_url` / `_date`. A vendor's own value is never
   touched.

Filing rows are rebuildable from `financial_report_extractions`, so a large
purge (the first run after a gate change, codes that lost vendor context) is
allowed and logged per key, not refused. Without 000132 the legacy path runs
(no markers, no per-field purge, no document columns). Nothing is written to
`stock_fundamentals_sync`. Postgres coverage, when `PICKS_TEST_DATABASE_URL`
names a local database: `TestFilingRebuildAgainstPostgres`,
`TestFilingRebuildRollsBackAgainstPostgres`,
`TestFilingPre132FallbackAgainstPostgres`, `TestRunFilingsAgainstPostgres` and
`migration132_pg_test.go`.

Exit (filings): 0; **10 = REFUSED** (a read of extractions, vendor rows or
company profiles errored, or zero extractions were read, which includes a
database without the table): nothing deleted or upserted, per-gate counts and
the would-purge list logged; **1** when the rebuild transaction failed (rolled
back, nothing written).

**Flags / env**

| Flag / env | Default | |
|---|---|---|
| `-mode` | `all` | `fundamentals` \| `filings` \| `refresh` \| `all` |
| `-dry-run` (or global `-dry-run`) | false | fetch/read + parse + log. No upsert, no attempt row, no lease, no refresh (`-mode filings` logs every row it would write and the would-purge list). With `-codes` (fundamentals only) it needs no database. |
| `-codes A,B` | none | fetch these codes instead of the selection (ignores the skips and any cap) |
| `-no-fallback` | false | never ask Markit |
| `-verbose` | false | log every Postgres notice |
| `-max-codes` / `PICKS_FUNDAMENTALS_MAX_CODES` | 0 (no cap) | optional count cap per fundamentals run; zero, negative or garbage keeps the default |
| `PICKS_FUNDAMENTALS_BUDGET_MIN` | 170 | stop taking new codes after this many minutes; the rest carries to the next run. Not a failure. 20 on a task retry |
| `REVALIDATION_URL` / `REVALIDATION_SECRET` | unset | the post-refresh cache bust; unset skips it (pages self-heal on their ISR TTL) |
| `DATABASE_URL` | required | except for `-dry-run -mode fundamentals -codes ...` |

**Exit codes**

| Code | Meaning |
|---|---|
| 0 | at least half of the attempted codes loaded rows or answered empty (an ETF with no statements is an answer, not an outage), nothing was due, or another execution holds the lease |
| 10 | DEGRADED: under half answered, or Yahoo failed for more than half of them even if Markit covered the gaps; or `-mode filings` REFUSED to write |
| 1 | nothing answered, the DB failed, the filings rebuild rolled back, the refresh failed or skipped a view, or the run was cancelled |

In `-mode all` each step runs even when an earlier one degraded, and the worst
verdict wins (a plain failure beats DEGRADED); the other steps' errors ride
along in the message.

**First run in an environment**

1. Migrations 000129, 000130 and 000132 must be in the database. On prod the
   terraform-deploy allowlist applies all three (000132 on the session pooler,
   two transactions under `lock_timeout = '15s'`, before the jobs image swaps);
   do not merge while `financial-report-extractor` or a picks run is executing.
   If the deploy step fails, hand-apply in a quiet window with
   `task db:prod:apply FILE=services/migrations/000132_extend_fundamentals.up.sql CONFIRM=prod`
   and re-run the deploy; never remove the allowlist line (this image writes
   the new columns). The job and the API tolerate 000132 being absent.
2. Check the upstream without writing:
   `shorted -dry-run picks -mode fundamentals -codes BHP,XRO,RMD`.
3. Straight after the deploy, `filings` then `refresh` (seconds, no Yahoo)
   removes the rows the old ingest wrote from echoes, comparatives and
   segments: from an agent through the admin MCP connector
   (`docs/mcp-admin.md`: `run_picks_job {mode: "filings"}`, then `{mode:
   "refresh"}`, polling `picks_job_status`) or by hand with
   `gcloud run jobs execute shorted-picks --region australia-southeast2 --args="picks,-mode,filings"`
   (read the `gates={...}` and would-purge lines first with
   `--args="picks,-mode,filings,-dry-run"`; the dry run is gcloud-only), then
   `--args="picks,-mode,refresh"`.
4. The daily 15:00 UTC `-mode all` covers the universe when it fits the
   170-minute budget; any remainder carries to the next night. A manual full
   run should start before 12:20 UTC or after the scheduled run has finished:
   one still holding the lease at 15:00 makes the scheduled run exit 0 without
   its filings and refresh.
5. Coverage is built when `GetStrategyPicks.fundamentals_rows_count` is near
   the codes the vendors publish statements for (about three quarters of
   `universe_count`). Pages revalidate on their own 16 minutes after each
   successful refresh.

**Enablement state (2026-09-28).** Scheduled: weekdays 13:30 UTC `-mode
refresh`; daily 15:00 UTC `-mode all`. The half-year rows depend on the
report-extractor (`module "report_extractor"`), which in prod is the PYTHON
image, now statutory-first: 120 reports a day at 14:00 UTC, one results document
per company (filed within 45 days newest first, then companies with no parsed
filing by market cap, then the rest), grounded, with `document_meta`
(`services/report-extractor`, fundamentals-coverage §6.1). The Go port in
`reportextract` is not deployed and is parity-only on the few-shot example and
grounding (see "Phase 3 port notes").

## Conventions for new jobs

1. Add `internal/jobs/<name>/` with a `Job() runner.Job` constructor.
2. Parse flags with a `flag.FlagSet` inside `Run(ctx, args)` — never
   package-level `flag.X` vars (they'd leak across subcommands). Default
   `-dry-run`/`-verbose` from `runner.FromContext(ctx)` so the global flags work.
   If the job honours a dry run, ALSO set `DryRun: true` on its `runner.Func` —
   the runner refuses a global `-dry-run` against a job that doesn't declare it,
   rather than letting it silently write.
3. Get the DB from `platform.ConnectFromEnv` (SimpleProtocol + pooler-safe) and
   the cache bust from `platform.PingRevalidate` — do not hand-roll either.
4. Return errors; don't `log.Fatal` and never `panic` for expected failures.
   The runner logs `[job] done … status=error` and main exits non-zero, and your
   deferred cleanup actually runs. Long per-item loops must check `ctx.Err()`
   each iteration and wait on `select { case <-ctx.Done(): … }`, not
   `time.Sleep`, so SIGTERM lands promptly.
5. Every failure is exit 1. If an EXTERNAL caller (a shell launcher, a
   scheduler) branches on specific codes, return a `*runner.ExitCodeError`
   instead of calling `os.Exit` — `main` maps it through `runner.ExitCodeOf`.
   Document the codes at the job, and keep the job's own helpers returning
   whatever they returned before (convert once, at the dispatch). `economy`
   and `picks` return 10 (DEGRADED); 3-7 stay reserved for the retired
   `house-prices` port, whose residential-rig launchers branch on them.
6. Register it in `cmd/shorted/main.go`.

## Building the image

Context is `services/` (the module has a `replace … => ../` for `pkg/*`):

```bash
docker build -f services/jobs/Dockerfile services
# or, with access to the private stealth module:
docker build -f services/jobs/Dockerfile --secret id=github_token,env=GH_TOKEN services
```

`pkg/enrichment` (used by `reports coverage|link`) pulls `pkg/stealthhttp` →
`github.com/skunkworq/stealth`, so the `FROM scratch AS stealth` stage from the
other service Dockerfiles carries over unchanged.

Note that **neither `go.mod` carries a stealth `replace`** — local builds get it
from `services/go.work`, the bind-mount branch of the Dockerfile adds one
pointing at `/stealth`, and the GitHub-token branch needs none (a committed
`replace … => ../../../stealth` resolves to a non-existent `/stealth` in the
image and breaks the token path before the token is read).

### Phase 2b review notes (documented divergences)

- **news**: the old binary set `log.SetOutput(os.Stdout)`; the monolith logs to
  stderr like every other job. If any log-based metric filters on the stdout
  stream for news-aggregator, update it at cutover.
- **signals**: brandbrain responses are decoded strictly (typed floats/strings);
  Python coerced loosely. Upstream schema drift (e.g. confidence as a JSON
  string) fails the decode — surfaced as a retried, then logged+counted error.

**Phase 3 review addenda (report-extractor):** cookie jar added to the ASX
fetcher (requests.Session parity — the terms page may set cookies the PDF host
checks); digest confidence coercion now matches Python float() exactly
(null/missing/non-numeric drops the whole digest; numeric strings coerce);
worker bodies are panic-shielded into the "error" tally outcome (Python's
as_completed except Exception equivalence); empty director date_of_change now
writes NULL (Python raised a cast error and lost the row — a deliberate,
disclosed improvement).
