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
  internal/jobs/houseprices/  `shorted house-prices -mode …` (21 modes)
                              (was services/house-price-collector)
  internal/jobs/influence/    `shorted influence`  (was services/influence-collector)
  internal/jobs/marketdata/   `shorted market-data serve|sync|audit-gaps|historical-backfill`
                              (was services/market-data-sync)
  internal/jobs/news/         `shorted news`       (was services/news-aggregator)
  internal/jobs/reports/      `shorted reports coverage|link|sync`
                              (was services/report-coverage / -linker / -sync)
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
| `house-prices` | `services/house-price-collector` | **not yet** — ported (Phase 2d), no Terraform change, no rig cutover; see below |
| `influence` | `services/influence-collector` | no — laptop-only tool |
| `market-data serve` | `services/market-data-sync` (default mode) | yes — the EXISTING `market-data-sync` Cloud Run SERVICE now runs the `shorted-jobs` image with args `["market-data","serve"]` (cutover 3, in-place revision swap; same URI/SA/scheduler) |
| `market-data sync` | `services/market-data-sync -cli` | n/a — CLI mode; the deployed surface is `serve` (cutover 3) |
| `market-data audit-gaps` | `services/market-data-sync/cmd/audit-gaps` | no — laptop-only tool |
| `market-data historical-backfill` | `services/market-data-sync/cmd/historical-backfill` | no — laptop-only tool |
| `news` | `services/news-aggregator` | yes — `shorted-news`, 1 job + 5 schedules (cutover 2; all 5 old schedulers paused) |
| `reports coverage` | `services/report-coverage` | no — laptop-only tool |
| `reports link` | `services/report-linker` | no — laptop-only tool |
| `reports sync` | `services/report-sync` | no — laptop-only tool |
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
subcommand as args (`args = ["discovery"]`). `house-prices`' Cloud Run mode
(`-mode official`) needs no browser and rides the standard image; its CDP crawl
modes drive a host Chrome on the residential Macs and need no browser in the
image at all (that is what the source service's `Dockerfile.crawl` encodes).

## Phase 2d port notes (house-prices)

The biggest single port: `services/house-price-collector` (~23.4k LoC across 105
Go files, 21 `-mode` values) → `shorted house-prices -mode <mode>`. **CODE ONLY**
— no Terraform, no launchd/plist change, no schedule change, no deletion. The
old service is untouched, still builds and still runs everywhere it runs today.

### Three deployment surfaces, one binary

This service is unusual: it is deployed three different ways, and this slice
changes NONE of them.

| Surface | What it runs | Status after this PR |
|---|---|---|
| **Cloud Run Job** (`terraform/modules/house-price-collector`) | monthly `-mode official` | unchanged — still the old image/module |
| **Residential Mac rigs** (`services/house-price-collector/deploy/*.sh` + `*.plist.template`) | `-mode agent\|enqueue\|listings\|crawl\|details\|property\|warmcheck\|freshness` against a **host** Chrome over CDP | unchanged — the launchers still exec `$HOME/bin/house-price-collector` |
| **Local operator runs** | `-mode census\|electorates\|banners\|amenities\|lga\|connectivity\|funding\|council-financials\|crime\|backfill-address\|purge\|refresh` | unchanged |

**The rig cutover is deliberately NOT in this PR.** Flipping
`HOUSING_CRAWL_BIN` on a residential Mac has to be tested on a real rig against
live REA/Domain (warm Chrome, Kasada clearance, launchd env, the exit-code
branches) — that is its own step with its own verification, not something to
bundle into a mechanical port. What this PR guarantees is that
`shorted house-prices -mode X` is an **argument-wise drop-in**: same flag
(`-mode`), same 21 values (+ the undocumented `abs` alias for `official`), same
environment contract, same exit codes. The eventual cutover is one line per
launcher (`BIN=…/shorted` + a leading `house-prices` argument), or simply
`HOUSING_CRAWL_BIN='…/shorted house-prices'` if the launchers' quoting is
adjusted to allow it.

### The exit-code contract (the thing that shapes this port)

Every other job in this binary has ONE failure code. house-prices has five, and
the rig launchers branch on them:

| Code | Meaning | Who branches on it |
|---|---|---|
| 0 | ok | all |
| 3 | re-warm the crawl Chrome (Kasada/Akamai clearance expired) | `run-housing-crawl.sh` (notify + exit 3), `run-housing-delta.sh` / `run-housing-full.sh` (`case … in 3\|4)`), `run-housing-agent.sh` |
| 4 | fetcher init failed — Chrome/CDP unusable (wedged tab / stale `SingletonLock`) | `run-housing-crawl.sh` hard-recovers (SIGKILL + clear lock + relaunch) — a plain relaunch loop would spin forever |
| 5 | warmcheck says the REA session is cold (Kasada stub) | `run-housing-crawl.sh` re-warms, retries twice, then exits 5 |
| 6 | crawl-freshness ALARM | `run-housing-delta.sh` / `run-housing-full.sh` propagate it |

The runner maps *every* error to exit 1, so this needed an explicit mechanism.
Three options were considered:

1. `os.Exit(n)` inside the job — **rejected**: it skips `defer pool.Close()`,
   skips the runner's `[job] done … status=error` line, and puts a hard exit
   inside a shared binary where any future job could inherit it.
2. A house-prices-only wrapper in `cmd/shorted/main.go` — **rejected**: main
   would have to know about one job's internals.
3. **Chosen:** a small, documented runner extension.
   `runner.ExitCodeError{Code, Err}` is an ordinary error that carries a code;
   `runner.ExitCodeOf(err)` is the single error→status mapping (`nil`→0, plain
   error→1, `ExitCodeError`→`Code`, and a zero `Code` degrades to 1 so a
   "successful error" is not expressible). `main` calls
   `os.Exit(runner.ExitCodeOf(err))`.

Inside the job, the mode helpers (`runWarmCheck`, `runAgent`, `runDetails`,
`runProperty`, `runFreshness`, and `runCrawl`/`runListings`' rewarm bools) still
return their original `int`/`bool` — **byte-identical to the standalone
code** — and only the dispatch converts, via `exitFor(mode, code)`. So the
crawl stack's own circuit-breakers and codes were not touched at all.

Cleanup, logging and the code all survive together:

```
$ DATABASE_URL=… CRAWL_CDP_URL=http://127.0.0.1:9 shorted house-prices -mode warmcheck
[job] start name=shorted house-prices at=2026-07-26T06:00:32Z
[warmcheck] fetcher init failed (connect over CDP to http://127.0.0.1:9: …) — Chrome unreachable
[job] done name=shorted house-prices duration=499ms status=error error=-mode warmcheck: crawl fetcher init failed — Chrome/CDP unusable (exit 4)
error: -mode warmcheck: crawl fetcher init failed — Chrome/CDP unusable (exit 4)
$ echo $?
4
```

Covered by `internal/runner/runner_test.go`
(`TestExitCodeErrorSurvivesDispatch` — asserts the code survives dispatch, the
deferred cleanup ran, and the `status=error` line was still emitted) and
`internal/jobs/houseprices/job_test.go` (`TestExitForPreservesRigContract` —
pins 3/4/5/6 to the modes the launchers branch on).

### The crawl stack came across byte-faithful

`crawl_*.go` (CDP fetcher, Kasada warmcheck, smart pagination, sweep-poison /
broadening gates, the circuit breaker, brandbrain token auto-refresh,
`CRAWL_TRACE`) is battle-hardened against live anti-bot systems. **Every copied
file differs from its original in the `package` line and nothing else** — no
timing, header, retry, jitter or cancellation change. (Verified mechanically:
`diff <(tail -n +2 old) <(tail -n +2 new)` is empty for all 103 files;
`job.go`/`revalidate.go` are the two intentional exceptions.) That includes
leaving three files gofmt-unclean exactly as they are upstream
(`crawl_cdp.go`, `crawl_details_extract_test.go`, `crawl_details_test.go`) — a
reformat would have been a non-mechanical change to this code.

`store.go` also came across verbatim, so the tuned pool posture is preserved:
`QueryExecModeSimpleProtocol` + `MaxConns = 4` for the Supabase transaction
pooler (6543). It deliberately does **not** go through `platform.Connect`, for
the same reason `market-data` doesn't.

### `revalidate.go` — this service originated `platform.PingRevalidate`

The shared helper was lifted from this file, and it still covers the housing
contract exactly: POST `?secret=…&path=/price-drops,/housing&flush=housing`, no
`tag`, `Content-Type: application/json`, non-2xx tolerated, 45s deadline on a
**detached** context (so a run's `CRAWL_TIMEOUT_MIN` expiring between the write
and the ping can't kill the cache bust for already-committed data). So the local
copy became a thin adapter that fills a `platform.RevalidateRequest` — the ~10
crawl-side `pingRevalidate("agent")` call sites stay byte-identical, and the
ported `revalidate_test.go` still asserts the query contract end-to-end through
an `httptest` server. The only observable change is the log text
(`cache bust ok` instead of `housing cache bust ok`) and that transport errors
are now URL-redacted before logging (the local copy logged the raw `*url.Error`,
which embeds `?secret=`).

### Deliberate divergences

| Area | Standalone | Here | Why |
|---|---|---|---|
| entry point | `main()` → `os.Exit(run())`, `run() int` | `Run(ctx, args) error` + `runner.ExitCodeError` | see the exit-code section; deferred cleanup + the runner's end line now always run |
| `log.Fatal` ×3 (missing `DATABASE_URL`, `db connect`, unknown `-mode`) | exits immediately | returned errors, message texts preserved | `defer pool.Close()` runs; the runner logs `status=error`; still exit 1 |
| root context | `context.Background()` + `CRAWL_TIMEOUT_MIN` | the runner's **signal** context + the same `CRAWL_TIMEOUT_MIN` | SIGTERM now cancels a run (launchd/Cloud Run stop). The timeout value, the per-mode defaults (240 min for agent/listings/crawl/details/property/crime, 15 otherwise) and every crawl-internal deadline are unchanged; the detached finalizers (`refresh`, the queue submit, `pingRevalidate`) still ignore it by design |
| positional args | `flag.Parse()` left them in `flag.Args()`, ignored — `house-price-collector official` silently ran the DEFAULT `-mode all` | rejected with `unexpected argument "official"` | `all` runs a full ABS/RBA ingest; a typo'd invocation should not do that |
| `-dry-run` | no such flag | not declared → a global `shorted -dry-run house-prices …` is refused | the per-mode dry-runs are env-driven (`CRAWL_DRY_RUN`, `PURGE_DRY_RUN`, `CRIME_DRY_RUN`, …, most defaulting ON) and unchanged; the runner must not imply a dry run it can't deliver |
| `pingRevalidate` | local implementation | `platform.PingRevalidate` adapter | same wire contract; adds secret redaction, changes one log string |
| log flags | package default (`LstdFlags`) | `LstdFlags\|Lmsgprefix` (set by `cmd/shorted/main.go`) | shared with every other job; no prefix is set, so line output is unchanged in practice |
| `-mode` help text | inline string | `modeList` const, asserted against the dispatch switch by `TestModeListCoversEveryDispatchCase` | a mode added without updating the help (or dropped from the switch) now fails a test rather than a rig |

Everything else — all 21 modes, the mode→helper mapping, the per-mode timeout
table, `refresh`'s detached `finalizeTimeout` + `linkSuburbSalCodes` +
`refreshHousingMV` order, the `official` job list and its per-source
`updateRun` error handling, the `abs` alias — is unchanged.

### Not ported

- **`Dockerfile` / `Dockerfile.crawl`** from the source service. The Cloud Run
  Job's `-mode official` needs no browser and would ride the standard
  `services/jobs/Dockerfile`; `Dockerfile.crawl` exists precisely because the
  crawl modes ship **without** Chromium and drive a host Chrome over CDP, which
  is a rig concern, not an image concern. Both are decisions for the cutover PR.
- **`deploy/`** (6 shell launchers + 5 launchd plist templates + a 22 KB
  runbook). Untouched on purpose — see "the rig cutover is not in this PR".

### Tests

All 316 tests came across (every one of them env-gated where it needs a DB,
a live CDP Chrome or real ABS/BOCSAR files, so `go test ./...` stays offline),
plus 9 new dispatch/exit-code tests here and 3 in `internal/runner`.

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
   whatever they returned before (convert once, at the dispatch). Today only
   `house-prices` needs this (3/4/5/6 for the residential-rig launchers).
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
