# Operations

## Local

```bash
make dev-db                                    # postgres on :5438
cd services && make migrate-up
cd services/house-price-collector && DATABASE_URL=… go run . -mode=refresh
```

DB: `postgresql://admin:password@localhost:5438/shorts`.

**There are no housing `make` targets** — every mode is a direct `-mode`
invocation; rigs run a prebuilt `~/bin/house-price-collector`. Offline-ingest
modes no-op without their input path (`CENSUS_DATAPACK_PATH` + `CENSUS_GEO_DIR`,
`ELECTORATES_DIR`, `ARCHETYPES_FILE`, `AMENITIES_FILE`/`LGA_DIR`/
`CONNECTIVITY_FILE`). Big corpora go on `/Volumes/gamma-systems-2`, never `/tmp`.

**A hand-run crawl writes nothing.** `CRAWL_DRY_RUN` defaults true in code
(`crawl.go`: `os.Getenv("CRAWL_DRY_RUN") != "false"`); only the launchd wrappers
export `false`. Same for `CRIME_DRY_RUN`/`PURGE_DRY_RUN`. Check `dryRun=` in the
startup log before believing a run persisted. Official + suburb modes have no
dry-run and write every run. Crawl modes need a warm host Chrome on
`CRAWL_CDP_URL` and a residential IP — they do not work off a rig.

**Two copies of the collector, and CI tests the wrong one.**
`services/house-price-collector` (110 `.go` files) ships;
`services/jobs/internal/jobs/houseprices` (108) is the consolidation fork behind
`shorted house-prices`, in no Terraform environment, and already drifted.
`run-tests` runs `cd services/jobs && go test ./...` plus the integration suite —
**nothing runs `go test ./...` in the `services` module**, so the deployed
collector's tests are local-only. It is also `if: github.event_name !=
'pull_request'`: it gates the deploy, not the PR.

## Prod

### The deploy does NOT run `migrate up`

`terraform-deploy.yml` applies a hardcoded allowlist —
`000070/71/74/75/81/82/83/85`. **No housing file is in it.** (That `000083` is
`add_state_exposure`, the economy migration; housing's rollups were authored as
000083 and renumbered to `000086` — don't read it as coverage.)

Apply housing DDL **by hand, before the merge**, via the **session pooler
(5432)** — not the txn pooler 6543 — with `PGOPTIONS="-c statement_timeout=0"`,
so a `REFRESH MATERIALIZED VIEW CONCURRENTLY` inside the migration can finish.
URL in `services/.env`. **Prod `schema_migrations` lies**: the same step
force-writes one row, version 75, while prod carries objects from
000086/000090/000092. Never `make migrate-up` against prod.

### Release order

1. Migrations by hand
2. **API before web** — a new RPC 404s until the API ships
3. Any operator ingest the release depends on (`census`/`electorates`/`banners`
   are hand-run; nothing schedules them)
4. Revalidate (automated post-promote — verify it)
5. Verify the *page*, not just the RPC

### The scheduled job

Cloud Run job `house-price-collector` (`australia-southeast2`, entrypoint
`-mode all`, task timeout **1800s**, `max_retries = 2`) + scheduler
`house-price-collector-monthly` (`australia-southeast1`, 5th at 16:00 UTC).
Wired into CI + both envs since PR #211 — a merge to `main` deploys it (the
monolith's "not yet wired" is stale). Run one now with `gcloud run jobs execute
house-price-collector --region australia-southeast2 --project
rosy-clover-477102-t5`. Prod sets `manage_revalidation_secret = true`; **dev
does not**, so a dev run's revalidate ping silently no-ops.

### MV refresh

`refresh_housing_materialized_views()` is decoupled from the shorts
`refresh_all_materialized_views()`; the collector calls it after every run over
the **txn pooler** (6543, `QueryExecModeSimpleProtocol`, `MaxConns=4`) with no
session `statement_timeout` override. By hand, use the session pooler:

```bash
PGOPTIONS="-c statement_timeout=0" psql "$SESSION_POOLER_URL" \
  -c "SELECT refresh_housing_materialized_views();"
```

That is also the workaround for the known-open guard gap — 000092's
`EXCEPTION WHEN OTHERS` does not catch the `query_canceled` a `statement_timeout`
raises, so one timed-out MV starves every MV after it
([data-model.md](data-model.md)). Fix in flight.

## Restarting the crawl after a silence

**`-mode warmcheck` passing does not mean the crawl is healthy.** Distrust the
queue's terminal statuses first — ask whether a "success" corresponds to rows
actually written.

| Silent stopper | Tell | Clear |
|---|---|---|
| BrandBrainAgent.app died (strict parent coupling, no relaunch) | `token refresh failed: dial tcp 127.0.0.1:…`, then 401s | `open -a /Applications/BrandBrainAgent.app`; the control port is re-minted per launch — read `~/.brandbrain/diag-port`, never hardcode |
| Thin-suburb false block wedges the queue head | a small suburb reads `blocked` on both portals; the drain dies after 2 jobs with hundreds pending | `CRAWL_LISTINGS_MIN_PER_PAGE=1` (default 5); the `consecBlocked >= 2` stop is hardcoded, no env knob |
| A drain round hangs forever | `ps -o etime` past ~1h with no log output; `CRAWL_TIMEOUT_MIN` does **not** fire on the CDP path | `kill` it — a hung round holds the crawl lock and writes nothing; the supervisor starts the next pass |
| Orphaned `in_progress` leases | `crawl-jobs?status=in_progress` (not `running`/`claimed`, which always return 0) | `PURGE_STATUSES=in_progress PURGE_TIER=listings PURGE_DRY_RUN=false … -mode purge`, then re-enqueue; purge is coarse, dry-run first |
| A never-attempted job banked "succeeded" | coverage decays with no errors; `last_crawled` never advances | the `deferred` outcome (brandbrain #192 + shorted #408) — deploy brandbrain first or the collector falls back to `failed` |
| **The Playwright driver is gone** | `please install the driver (v1.61.1) first` in the scheduler log; wrapper exits **8**; `find "$CRAWL_PW_DRIVER_DIR" -type f` is empty | `~/bin/house-price-collector -mode install-driver` — **do not re-warm Chrome, it is not the fault** |

### The driver stopper, in full (2026-08-13 → 15)

The driver **used to live** under `~/Library/Caches`, so any disk-space sweep of
that directory disabled the crawl without touching a line of code. That is what
happened on 2026-08-13: the whole dev-cache family (Homebrew, golangci-lint,
node-gyp, the Go module cache) was recreated in one window late that night, and
the driver went with it.

It no longer lives there. `CRAWL_PW_DRIVER_DIR` (defaulted by `hc_load_env` to
`~/.shorted-housing-crawl/pw-driver`) puts the driver on a path this crawl owns
and no cache tooling sweeps, and `-mode install-driver` installs to that same
path through the same options the fetchers read — so the repair command and the
runtime cannot disagree about the directory. Read the rest of this section as
the incident record it is.

It was expensive because the symptom lied. `playwright.Run()` fails *before* any
Chrome contact, but `runWarmCheck` used to report every fetcher-init failure as
`rc=4 … Chrome unreachable` — so the agent SIGKILLed and relaunched the dedicated
Chrome twice per run, then exited 4, and the log sent whoever read it to the
re-warm procedure above, which cannot install a driver. Both scheduled crawls did
this every run for two days; 500/500 suburbs went stale.

`rc=8` now exists precisely to separate *the environment is broken* from *the
browser is broken* (`crawl_env.go`). If you see 8: reinstall the driver, then
prove the rig is warm.

```bash
~/bin/house-price-collector -mode install-driver  # installs into CRAWL_PW_DRIVER_DIR
~/bin/house-price-collector -mode warmcheck      # want "[warmcheck] REA warm (…ArgonautExchange present)"
```

`install-driver` needs no database, no Chrome and no wrapper env beyond
`CRAWL_PW_DRIVER_DIR` — it is dispatched before the `DATABASE_URL` check
specifically so a rig with a broken environment can repair itself.

Nothing else on the rig needs touching — Chrome keeps its Kasada clearance
across the whole failure.

Diagnosis order: agent alive → hung round → wrapper log (it buffers a whole
drain round, so a quiet log is not evidence of a stall) → `SELECT max(created_at)
FROM property_price_events` → queue state.

The warm cannot be automated away: **Chrome's own startup navigation to
`https://www.realestate.com.au/` is what clears Kasada.** A Playwright-driven
warm, or warming Domain, does not. The wrappers auto-launch the
dedicated-profile Chrome and prove warmth with `-mode warmcheck` (exit 5 =
Kasada stub → relaunch). The brandbrain token needs no minting — the collector
re-reads the running macOS agent's token on 401; `BRANDBRAIN_AGENT_TOKEN` is an
optional fallback and, as a ~15-min snapshot, rescues nothing once stale.

## Deploying the rig

The rig binary (`~/bin/house-price-collector`) and the staged wrappers
(`~/.shorted-housing-crawl-deploy/`) are a **hand deploy, invisible to CI** —
merging does not ship them. On 2026-08-15 the binary was found built 4h17m
before the fix it was assumed to carry.

```bash
bash services/house-price-collector/deploy/stage-rig.sh --check  # read-only: is the rig current?
bash services/house-price-collector/deploy/stage-rig.sh          # build + stage + install driver
~/bin/house-price-collector -mode warmcheck
```

`--check` writes nothing and reports the deployed `vcs.revision` against
`origin/main` plus per-wrapper drift. **Run it first during any incident** —
"the rig is running old code" is a one-second hypothesis to eliminate.

The install path refuses a dirty tree or a HEAD that is not `origin/main`
(`STAGE_ALLOW_DIRTY=1` overrides for a deliberate branch build). This
supersedes the manual `go build` in `deploy/README.md`, which remains as the
fallback. Independently, both scheduled wrappers now log the running
`vcs.revision` in their opening lines, so drift is visible in the log you are
already reading.

## Freshness: what you can actually check today

```sql
SELECT source, last_period, last_fetched_at, rows_upserted, status
  FROM house_price_ingest_runs ORDER BY last_fetched_at DESC;    -- official
SELECT max(created_at) FROM property_price_events;               -- crawl
SELECT run_type, host, status, finished_at FROM crawl_run_status; -- rig health
```

`house_price_ingest_runs` is **write-only in this codebase** — one `INSERT` in
`store.go`, zero `SELECT`s in `services/` or `web/src`. A failed official job
writes an `error` cursor and still exits 0. That is how NSW Valuer-General
medians reached 2026-08-09 having never landed a row while VIC sat frozen at
Dec-2024.

Nothing *in the application* reads it — but since #417/#429 a sentinel does.
`.github/workflows/housing-freshness.yml` runs daily at 22:11 UTC against prod
under a read-only transaction and files (and auto-closes) **one GitHub issue**,
which is the notification channel: it needs no secret and emails the repo
watchers. It is the only alarm that survives a dead rig, because it observes
prod from GitHub's side — it works when the laptop is off.

It now runs four checks:

| Check | Threshold | Catches |
|---|---|---|
| `INGEST_ERROR` | any | an official job that wrote an `error` cursor and exited 0 |
| `PERIOD_REGRESSION` | any | a preserved cursor ahead of the facts it claims to have loaded |
| `EVENT_SILENCE` | 72h | global `max(observed_at)` — a *fully* dead crawl |
| `CATALOG_STALENESS` | **132h** | the oldest **covered suburb** — a *limping* crawl |
| `RIG_STATUS` | error/blocked, or a `delta` unfinished for **30h** | a run that failed, or never started |

The last two exist because the first three cannot see a crawl that is merely
too slow. `EVENT_SILENCE` ran **green throughout the 2026-08-13 → 15 driver
outage** (34h and 58h silence at those runs, both under 72h) and green again on
2026-08-18 with the catalog median at 117h and the oldest suburb at 305h. A
crawl limping at any rate keeps a global maximum fresh forever;
`CATALOG_STALENESS` asks the per-suburb question instead, mirroring
`classifyFreshness`. Its 132h sits above the rig's own 120h alarm so the rig
alerts first and the sentinel stays the backstop.

Rig-side, `-mode freshness` exit 6 and every terminal wrapper failure now push
through `hc_alert` (macOS notification **plus** `CRAWL_ALERT_WEBHOOK`, falling
back to `CRAWL_FRESHNESS_WEBHOOK`). Set that webhook on the rig and as a GitHub
secret — unset, alerting degrades to a notification nobody is guaranteed to see.

`crawl_run_status` (000089) is the honest signal: a dead rig stops writing,
`finished_at` ages, and `/admin` flips the row warning → critical unaided.

## Revalidation and the post-deploy sweep

A promote resets every ISR page to its build-time placeholder. The sweep is
automated (`terraform-deploy.yml`, post-promote, `continue-on-error`): it POSTs
`web/src/config/isr-pages.json` as the `path` list with `flush=shorts,housing`
and a **browser UA** (a curl UA is edge-blocked). `post-deploy-smoke.yml` then
re-primes via `/api/static-pages/warm-cache` — the first five entries,
`/market`, `/housing`, `/economy`, `/compare`, `/price-drops`.

**`/housing/[state]` and `/housing/[state]/[suburb]` are in neither list.** Both
are `revalidate = 86400`, so after a promote they self-heal only on that 24h TTL
unless revalidated explicitly (a `path` containing `[` revalidates the whole
dynamic route). Manual fallback — `gcloud secrets versions access latest
--secret=REVALIDATION_SECRET --project rosy-clover-477102-t5`, then POST
`/api/revalidate?secret=…&path=/price-drops,/housing&flush=housing`.
`flush=housing` busts the whole `cache:housing:` prefix; the collector fires the
same call after a run that wrote data ([pipeline.md](pipeline.md)).

## Takedown

Three actions, **all required** — miss one and the content the kill switch
exists to pull keeps serving for up to 24h:

1. **Flip the switch** on the shorts service and roll a revision:
   `HOUSING_DROP_LISTINGS_ENABLED=false` (agency/agent names, per-address and
   per-listing drops) and/or `HOUSING_VALUATIONS_ENABLED=false` (property.com.au
   AVM). Both default ON; falsey values are `false|0|off|no`.
2. **Flush KV** with `/api/revalidate?…&flush=housing`. Do **not** use
   `/api/admin/flush-cache` with `target=housing` — it clears only
   `cache:housing:overview:`, not the `cache:housing:drops:*` keys the board
   serves from (`PRICE_DROPS_TTL` = 86400s).
3. **Revalidate ISR**: `/price-drops` (static, 1h) plus the suburb routes.

Known-open: the flag is checked before the *backend* cache while the web layer
caches flag-on responses independently and no target bundles the three steps;
`REVALIDATION_SECRET` travels as a query param compared non-constant-time; and
per-address AVM estimates + sales history are served publicly, contradicting
migration 000088's own posture. Fixes in flight.

## Credentials and env

| What | Where |
|---|---|
| Rig secrets | `~/.shorted-housing-crawl.env` (chmod 600, uncommitted): `DATABASE_URL` (prod, 6543), `CRAWL_CDP_URL`, `BRANDBRAIN_AGENT_URL`, `REVALIDATION_URL` + `_SECRET` |
| brandbrain auth | nothing stored — read live from `~/.brandbrain/{diag-port,control_secret}` (`BRANDBRAIN_CONTROL_PORT`/`_SECRET` override) |
| Cloud Run job | `DATABASE_URL` + `REVALIDATION_SECRET` from Secret Manager, mounted by Terraform |
| Operator | prod DB URL in `services/.env`; revalidation secret in GCP SM, project `rosy-clover-477102-t5`, mirrored in the Vercel env |

Rig `REVALIDATION_URL` defaults to the **Vercel origin**, not `shorted.com.au`
(Cloudflare's managed challenge can block non-browser POSTs); the Cloud Run job
defaults to the canonical host, which works because `cloudflare-edge` carries a
skip rule for `/api/revalidate`.

## Landmines that have actually bitten

- **A large `pgx.Batch` hangs on the txn pooler** — 527k crime rows in one batch
  stalled at 0 rows / 0% CPU for 12 min. Chunk large upserts (2000 rows).
- **A low `CRAWL_TIMEOUT_MIN` self-aborts a healthy batch mid-write.** The crawl
  family defaults to 240 min for a reason; the bundled macOS agent inherited the
  15-min default and killed multi-suburb runs a few suburbs in.
- **Reading `searchParams` in a server page silently forces dynamic rendering**
  even with `revalidate` exported, killing the ISR that serves `/price-drops` in
  40–58ms. Read `?state=` client-side via `useSearchParams` under a real
  `<Suspense>` boundary — the `next/dynamic` fallback does not satisfy it.
- **Committed testdata carries real portal content** (`rea-pagemeta.html`,
  `domain-pagemeta.html`, in both collector copies): real addresses, prices and
  listing ids in a public repo — known-open, fix in flight. `CRAWL_TRACE`
  artifacts are the same and stay local + gitignored.
