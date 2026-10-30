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

**One collector.** `services/house-price-collector` is the only copy: the Cloud
Run job, the rig launchers and every Taskfile task run it. The
`services/jobs` port (`shorted house-prices`) was never scheduled, drifted, and
was deleted on 2026-09-24; do not resurrect it without cutting the rig over in
the same change (`services/jobs/README.md`). Its tests run on pull requests in
`terraform-deploy.yml`'s `housing-contract-tests` job
(`go test ./house-price-collector` in `services`). `run-tests` still runs only
`cd services/jobs && go test ./...` plus the integration suite, and is
`if: github.event_name != 'pull_request'`: it gates the deploy, not the PR.

## Prod

### The deploy does NOT run `migrate up`

`terraform-deploy.yml` applies a hardcoded allowlist —
`000070/71/74/75/81/82/83/85`. **No housing file is in it.** (That `000083` is
`add_state_exposure`, the economy migration; housing's rollups were authored as
000083 and renumbered to `000086` — don't read it as coverage.)

Apply housing DDL **by hand, before the merge**, with
`task db:prod:apply FILE=services/migrations/<file>.up.sql CONFIRM=prod`. It uses
the **session pooler (5432)** — never the txn pooler 6543 — and runs the file in
one transaction after `SET LOCAL statement_timeout = 0`, so a
`REFRESH MATERIALIZED VIEW CONCURRENTLY` inside the migration can finish; an error
rolls the whole file back. **Do not use `PGOPTIONS="-c statement_timeout=0"`**:
Supavisor drops startup options, so that ran every migration under the role's
2-minute default (measured 2026-09-23). A file Postgres cannot run in a
transaction (`CREATE INDEX CONCURRENTLY`, `VACUUM`) falls back to a session-level
SET with a WARNING and an explicit `RESET ALL` (`scripts/prod-psql.sh`).
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

### The daily drop-index schedule (and how to catch up a gap)

Scheduler `house-price-collector-drop-index` (`australia-southeast1`, daily
18:00 UTC) re-invokes the same Cloud Run job with a `:run` overrides body
setting `-mode drop-index`. It writes `housing_drop_index_daily` — the
discounting index that leads `/price-drops`.

**It computes `[yesterday, today]` only.** `main.go` defaults `from` to
`now-1d`, so a run does *not* self-heal a gap: if the schedule is broken or
paused for N days, the missing days stay missing forever until someone asks for
them. The catch-up knob is `DROP_INDEX_FROM=YYYY-MM-DD` (clamped forward to
`indexBackfillStart` = 2026-08-03, before which the crawl catalog was still
growing 115 → 500 suburbs and the panel is not stable). Backfill is idempotent —
`writeIndexPoint` upserts on `(snapshot_date, grain, grain_key)` — so re-running
an already-covered range is safe.

Find the gap, then close it:

```bash
psql "$SESSION_POOLER_URL" -c \
  "SELECT max(snapshot_date) FROM housing_drop_index_daily WHERE grain='national';"

gcloud run jobs execute house-price-collector \
  --region australia-southeast2 --project rosy-clover-477102-t5 \
  --args="-mode,drop-index" \
  --update-env-vars=DROP_INDEX_FROM=<max_snapshot_date + 1 day> \
  --task-timeout=4h --wait
```

A backfill writes a row per suburb per day (~500 suburbs/day), which is why the
schedule overrides the job's 1800s task timeout up to 4h. Note that the
per-day numbers are recomputed from *current* listing state, so a late backfill
of an old day reflects what we can still see of it, not a frozen snapshot —
another reason not to let the gap run long.

**Landmine — the override body is v1-shaped.** The scheduler posts to the Cloud
Run Admin API **v1** namespaces endpoint, whose `Overrides` message spells the
task deadline `timeoutSeconds` (integer). The v2 `timeout: "14400s"` duration
string shipped in #436 and made every single attempt fail with
`Unknown name "timeout" at 'overrides'` — surfaced by Cloud Scheduler only as
status code 3 / INVALID_ARGUMENT, so the schedule never ran once between
2026-08-17 and the fix while nothing alerted. Guard:
`scripts/tests/scheduler-override-body.test.mjs`.

### MV refresh

`refresh_housing_materialized_views()` is decoupled from the shorts
`refresh_all_materialized_views()`; the collector calls it after every run over
the **txn pooler** (6543, `QueryExecModeSimpleProtocol`, `MaxConns=4`), prefixed
with `SET LOCAL statement_timeout = 0` in the same implicit transaction
(`refreshHousingMV`, `store.go`). By hand:

```bash
task db:prod:refresh WHICH=housing CONFIRM=prod
```

That runs on the session pooler, in one transaction, after
`SET LOCAL statement_timeout = 0`. The function (000107) catches a failed view,
RAISEs `WARNING 'Skipping mv_…'` and returns normally, so psql alone exits 0 with
a view left stale; the task exits 1 on any `Skipping` line. The old recipe,
`PGOPTIONS="-c statement_timeout=0" psql …`, ran under the 2-minute role default
because Supavisor drops startup options, and a view that hit it was skipped
silently. The freshness sentinel's `MV_REFRESH_AGE` check (72h, from
`housing_mv_refresh`) is the backstop.

Since 000127 the function also refreshes `mv_council_price_drops` (last, in
its own guarded block), so the council hub's and council index's price-drop
share is as fresh as the last refresh, and its `as_of` is that refresh. A
council page showing no drops block while `/price-drops` has data: check
`SELECT * FROM housing_mv_refresh WHERE mv_name = 'mv_council_price_drops'`
(no row = nothing published, by design), then refresh.

**The suburb reference views (000139) are a second refresh.**
`refresh_suburb_reference_views()` refreshes `mv_suburb_latest_price`,
`mv_housing_state_baselines` and `mv_suburb_similarity_features`: each
suburb's latest public median and YoY, the state baselines and the
similar-suburbs features that the suburb list, profile, similar suburbs, map
price column and council suburb table read instead of computing them per
request. Before 000139 those values were computed per request, so they could
not go stale; now they move only when this function runs. The collector calls
it from `refresh()` (after the housing views) and after a successful
`-mode census` or `-mode amenities`. The function turns a view it cannot
refresh into a `Skipping` WARNING and returns the skipped views; the collector
fails its run on any, and logs `refreshed the suburb reference views` on
success. The views are not in `housing_mv_refresh`, so `MV_REFRESH_AGE` never
sees them. The sentinel's `SUBURB_VIEW_STALENESS` check watches them instead:
it reports a public suburb median loaded after
`mv_housing_state_baselines.computed_at` once that load is 6 hours old.
The Housing Freshness workflow is `disabled_manually` on GitHub (last run
2026-10-01), so until it is re-enabled nothing runs that check. By hand,
read-only; `t` means the views were refreshed after the newest public suburb
median load:

```bash
task db:prod:psql -- -At -c "SELECT (SELECT max(computed_at) FROM mv_housing_state_baselines) > (SELECT max(hp.fetched_at) FROM house_prices hp JOIN house_price_regions sr ON sr.region_code = hp.region_code WHERE sr.region_type = 'suburb' AND hp.measure = 'median_price' AND hp.dwelling_type = 'house' AND hp.source_licence <> 'proprietary-tos-restricted') AS views_current"
```

Only a collector built with 000139's change calls the function, and nothing
else does, so apply 000139 only after the Cloud Run job and the rig binary
both run such a commit (the exact check is the 000139 row in
`services/migrations/PROD_APPLIED.md`). An older collector would leave the
suburb pages on the apply date's prices while every run reports success.

After a hand fix to `house_prices`, `suburb_demographics` or
`suburb_amenities`, or a load by a collector built before 000139:

```bash
task db:prod:refresh WHICH=suburbs CONFIRM=prod
```

Like `WHICH=housing`, it exits 1 on any `Skipping` line.

For a read-only look at prod, use `task db:prod:psql -- -At -c "SQL"`: one
`BEGIN READ ONLY; SET LOCAL statement_timeout = '60s'; …; ROLLBACK`.

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

### Port conflict: another process holds the CDP port (exit 8)

Symptom: the cycle summary carries `env.chrome="port_conflict"` and the process
exits **8**. The log names the holder:

```
[agent] CDP port 9333 is held by another process (pid 83542: /Applications/Google Chrome.app/...) — not launching; free the port or set CRAWL_CDP_URL to a free loopback port
```

The collector drives its **dedicated-profile** Chrome on the port in
`CRAWL_CDP_URL`. When any other process listens on that port (typically the
operator's everyday Chrome with remote debugging on), the collector neither
launches over it nor kills it: the holder is not ours to stop. Before this check
the same state read as "unreachable" or "unusable", and the collector relaunched
or sent people to the re-warm runbook, which cannot clear a foreign holder.

Fix, in order:

1. Identify the holder: `lsof -nP -iTCP:<port> -sTCP:LISTEN` (the log gives the pid).
2. Either stop that process yourself, if it is not the crawl's Chrome, or move
   the rig to a free loopback port by setting `CRAWL_CDP_URL=http://127.0.0.1:<port>`
   for the agent. The check matches the address family: `127.0.0.1` counts only
   listeners on `127.0.0.1` and the wildcard, `[::1]` only `[::1]` and the wildcard,
   and `localhost` every listener. A holder on the other family does not block it.
3. Clear the drain's hold and run it again. Under BrandBrain the drain is held
   after exit 8, so clear it with the fleet `housing_crawl_repair` command, or
   `housing_crawl_run {job: drain}`. The dedicated Chrome auto-launches on the free port.

A dedicated-profile Chrome left running on the **old** port is not a conflict.
The collector re-probes the configured port after about 2 s, so a busy warm
Chrome that missed one probe keeps its Kasada clearance. Only a Chrome that is
still silent is killed (matched on its `--user-data-dir`, never the personal
profile), and then relaunched on the configured port. A second launch with the
same profile would hand off to the running instance and never bind.

The stale-instance kill runs only for a loopback CDP URL with a valid port. The
recovery path (`recoverWedgedChrome`, the rc 4 repair) also kills the local
dedicated-profile Chrome for a non-loopback URL. Its ownership check covers only
loopback URLs, and that predates this change. A kill is confirmed only when
`ps -axww` can be read. If it cannot, the collector refuses, clears no profile
locks and launches nothing. Never `pkill` Chrome by pattern to clear a conflict.

Each listener is classified by its own command line. `lsof` exits 1 both when
nothing listens and on some usage errors, so the collector reads exit 1 as no
listeners and lets `ps -axww` decide: a reachable port with no dedicated Chrome in
`ps` is treated as a conflict. If `ps` or `lsof` fails or times out (5 s each), the
collector does not report a conflict from the guess. With `CRAWL_AUTO_WARM=false`
the collector does not police the port at all.
One known limit: the profile match runs on `ps` output, which loses argv quoting,
so a profile path that contains a space can match a sibling profile whose path is
a prefix of it.

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

**The eight state indexes, `/housing/[state]/[suburb]` and
`/housing/[state]/council/[slug]` are in `isr-pages.json` (2026-09-25), alongside
the eight council index pages**, so the post-promote sweep covers them; a `path`
containing `[` revalidates the whole dynamic route. They are still not in the
re-prime set, and all of them are `revalidate = 86400`, so if the sweep step
fails (it is `continue-on-error`) they self-heal only on that 24h TTL. Manual
fallback: get the secret with `gcloud secrets versions access latest
--secret=REVALIDATION_SECRET --project rosy-clover-477102-t5`, then send the
full route list from [Takedown](#takedown) step 3. `flush=housing` busts the
whole `cache:housing:` prefix. The collector's own call after a run that wrote
data sends only `path=/price-drops,/housing&flush=housing`
([pipeline.md](pipeline.md)), so it does not reach the 24h routes.

## Takedown

Three actions, **all required** — miss one and the content the kill switch
exists to pull keeps serving for up to 24h:

1. **Flip the switch** on the shorts service and roll a revision:
   `HOUSING_DROP_LISTINGS_ENABLED=false` (EVERYTHING derived from the REA/Domain
   crawl: agency names, per-address and per-listing drops, AND the suburb/state
   aggregates, the discounting index and the profile's listing estimate — one
   policy, [architecture.md §10.2](architecture.md)) and/or `HOUSING_VALUATIONS_ENABLED=false` (property.com.au
   AVM). Both default ON; falsey values are `false|0|off|no`.
2. **Flush KV** with `/api/revalidate?…&flush=housing`. Do **not** use
   `/api/admin/flush-cache` with `target=housing` — it clears only
   `cache:housing:overview:`, not the `cache:housing:drops:*` keys the board
   serves from (`PRICE_DROPS_TTL` = 86400s).
3. **Revalidate ISR** — every route that renders a crawl-derived figure:
   `/price-drops` (static, 1h), `/housing` (1h), and the four 24h dynamic
   routes `/housing/[state]`, `/housing/[state]/[suburb]`,
   `/housing/[state]/council` and `/housing/[state]/council/[slug]`. The
   council index and hub render the council `price_drop_share` and the hub's
   price-drops block. List each route: the endpoint's `revalidatePath(path)`
   does not cascade, so `/housing` alone leaves every page under it cached, and
   a `[`-pattern revalidates only that one route (as type `page`). In one call:

   ```bash
   curl -g -X POST -H "X-Revalidate-Secret: $REVALIDATION_SECRET" \
     "$REVALIDATION_URL?flush=housing&path=/price-drops,/housing,/housing/[state],/housing/[state]/[suburb],/housing/[state]/council,/housing/[state]/council/[slug]"
   ```

   `-g` (`--globoff`) is required, because curl otherwise reads `[state]` as a
   URL glob range and refuses the request. The call covers step 2 as well.

Re-enabling is the same three steps with the switch flipped back. `/price-drops`
caches its "not available" render (the overview reports `withheld`, which is
stable, unlike a cold fetch), so without step 3 it keeps saying so for up to an
hour.

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

## Server-side crawl jobs (fleet-managed)

The fleet-managed crawl moves the database work off the rigs. A rig fetches listings and
pushes them to the **housing-ingest** service; it holds no database credential. The
server runs the rest as schedules on the collector Cloud Run job. Design:
`docs/superpowers/specs/2026-10-27-fleet-managed-housing-crawl-design.md`.

**Everything here ships paused.** Every schedule is created with `paused = var.server_schedules_paused`,
which defaults to `true` and is set `true` in `terraform/environments/prod/main.tf`. A
deploy changes no schedule's state. Cutover is a reviewed change to that one value.

### The schedules

All run this job with the args shown, in Australia/Sydney time, and each has the same retry
policy as the monthly schedule. Names are prefixed `house-price-collector-`.

| Schedule | Args | When | What it does |
|---|---|---|---|
| `enqueue-delta` | `-mode server-enqueue -selection delta` | daily 10:00 | Posts demand-sized suburbs to BrandBrain's queue, with a Google ID token from this job's SA. Writes one `crawl_dispatch` row per target BrandBrain returns, created or already pending. |
| `enqueue-full` | `-mode server-enqueue -selection full` | 1st and 15th, 08:00 | As above, for the whole catalog. |
| `crawl-finalize` | `-mode crawl-finalize` | every 30 min | Sal links, the housing MV refresh and one cache bust, **only** when the ingest has written since the cursor. A lease row keeps overlapping runs single-flight: a held lease exits 0. The MV refresh fails if any view is reported `Skipping`, which holds the cursor and skips the bust. The cursor sits 10 minutes behind the run start, so a slow push that commits late is still picked up. On a finalizing run it also prunes ingest receipts and terminal dispatch rows older than 14 days. |
| `freshness` | `-mode freshness` | daily 18:00 | The read-only freshness check. Exit 6 is the alarm, as before. Cloud Run retries a non-zero exit twice. See "Alerting" for the gap this leaves. |
| `property-resolve` | `-mode server-property-resolve`, `CRAWL_DRY_RUN=false`, `CRAWL_PROPERTY_RESOLVE_MAX=700` | daily 21:20 | Banks profile URLs from REA's public autocomplete. No browser. A blocked run (exit 3) is logged as a WARN and exits 0, as the rig wrapper treats it. The chunk is 700 so the run fits the job's 1800 s timeout (about 1300 s at the default pacing). |

A failed enqueue exits 7. A refused batch writes nothing, and an earlier accepted batch is
kept (its ledger rows are already committed). Re-running is safe: BrandBrain deduplicates
onto the pending job, and the ledger row is upserted.

### The ingest service

`housing-ingest` is a Cloud Run service built from the shorts API image, run with
`SHORTS_SERVE_MODE=ingest`. It has its own pool (`HOUSING_INGEST_DB_MAX_CONNS=4`), at most two
instances, and probes on `/health`. Its URL is the Terraform output `housing_ingest_url`
(`terraform output housing_ingest_url`). Rigs use that `run.app` URL. It is not on
`api.shorted.com.au`, so the public edge rate limits never see a rig.

**It ships inert.** `ingest_org` and `ingest_allow_subjects` default to empty, and prod does
not set them. With an empty org or allowlist the service answers every call `Unavailable`, so
no rig is accepted and no sweep is applied.

Connection budget: 2 instances × 4 = 8 connections at most, out of Supabase's 60. The
collector job holds 4 per task. The public API's own ceiling is 25 × 3 = 75, above 60 at full
scale, so the shared budget is already a known limit. This service adds at most 8 to it.

### Before cutover

1. **Migrations 000150 and 000151 are applied.** Both are on the deploy allowlist and replay
   safe. They run before the image swap. Check `crawl_dispatch` and `crawl_finalize_state`
   exist in prod.
2. **The job SA is on BrandBrain's allowlist.** BrandBrain pins `email=uniqueId`
   (`BRANDBRAIN_GOOGLE_IDTOKEN_ALLOWED_SAS`). Read the uniqueId with:
   ```bash
   gcloud iam service-accounts describe \
     house-price-collector@rosy-clover-477102-t5.iam.gserviceaccount.com \
     --format='value(uniqueId)'
   ```
   Add `house-price-collector@rosy-clover-477102-t5.iam.gserviceaccount.com=<uniqueId>` to
   BrandBrain's allowlist. A recreated SA gets a new uniqueId and every enqueue then 401s.
   A 401 names the cause in the job log ("the Google ID token was refused").
3. **Confirm the job's `DATABASE_URL` is the transaction pooler (port 6543). Do not change it.**
   The server jobs run on the same URL as the monthly collector job, which is the transaction
   pooler. The housing MV refresh (`refresh_housing_materialized_views`) is safe there because
   `RefreshHousingMV` prefixes `SET LOCAL statement_timeout = 0` in the same implicit
   transaction, the same as the collector and the rigs already do. The session pooler (5432) is
   derived from this URL by `terraform-deploy.yml`, for the migration steps only. Do not point the
   shared `DATABASE_URL` secret at 5432: every other job reads that secret, so the change would
   affect all of them. Check the port without echoing the URL:
   ```bash
   gcloud secrets versions access latest --secret=DATABASE_URL --project=rosy-clover-477102-t5 \
     | sed -E 's#.*:([0-9]+)/[^/]*$#port \1#'
   ```
4. **Prove the first run safely, in this order, before any schedule is unpaused.** Each command
   runs as the job's own service account, so it proves that identity:
   ```bash
   # a. The ID token is accepted by BrandBrain (audience and allowlist). Reads one summary row,
   #    creates no job, writes nothing.
   gcloud run jobs execute house-price-collector --region=australia-southeast2 --wait \
     --args=-mode,server-enqueue,-auth-check
   # b. The delta selection and the job build, with the counts logged. Sends nothing, writes nothing.
   gcloud run jobs execute house-price-collector --region=australia-southeast2 --wait \
     --args=-mode,server-enqueue,-selection,delta,-dry-run
   ```
   Read the log of each execution. `-auth-check` must say `auth-check OK`. A 401 or a 403 means
   the allowlist (step 2) is wrong. `-dry-run` must say `DRY RUN run delta-…` with the counts you
   expect. Then, still before unpausing, run one bounded real enqueue, because it creates real
   queue jobs that a legacy rig can claim: `--args=-mode,server-enqueue,-selection,delta,-limit,2`.
   Check its `run …` line and the `crawl_dispatch` rows for that `run_id`. Run it inside the
   cutover window (see "Cutover order").

### Cutover order

This follows the Gamma-64 cutover in the design spec. Do the steps in this order, because
the rig and the server must never both enqueue or drain.

1. Confirm the 1.33.10 app timer is off, and that the rig's collector passes `ProbeAuth`.
2. Run the "Before cutover" checks, including `-auth-check` and `-dry-run` (step 4 above).
3. Run shadow parity for three days, with the legacy plists still loaded.
4. After a delta drain finishes, `launchctl bootout` the three legacy plists
   (`com.shorted.housing-{delta,full,property-resolve}`) and move them aside. The rig then has
   no scheduler of its own.
5. **Unpause the server schedules.** Set `server_schedules_paused = false` in prod through the
   reviewed change, and deploy. Or resume each schedule with
   `gcloud scheduler jobs resume house-price-collector-<name> --location=australia-southeast1`.
   Create the alerting monitors (next section) first.
6. Send `configure active` to the rig, then `housing_crawl_run {job: drain}`.
7. Watch for 72 hours with no exit 13, 14 or 15 from the rig and the sentinel green.

The rollback is the reverse: pause the schedules, then re-bootstrap the plists.

### Alerting after unpause

The Telesis cronjob reporter matches runs by their exact args, so each server schedule needs
its own monitor before it is unpaused. Create one per row, with the args exactly as shown:

| Monitor | Exact args |
|---|---|
| `house-price-collector-enqueue-delta` | `-mode server-enqueue -selection delta` |
| `house-price-collector-enqueue-full` | `-mode server-enqueue -selection full` |
| `house-price-collector-crawl-finalize` | `-mode crawl-finalize` |
| `house-price-collector-freshness` | `-mode freshness` |
| `house-price-collector-property-resolve` | `-mode server-property-resolve` (with `CRAWL_DRY_RUN=false`) |

**The freshness gap, stated plainly.** Server `freshness` exits 6 when the oldest covered suburb
is past `CRAWL_FRESHNESS_ALARM_HOURS`. It has no `CRAWL_FRESHNESS_WEBHOOK`, and it writes no
`crawl_run_status` row. So its exit 6 shows only as a failed Cloud Run execution, and no monitor
pages on it until the `house-price-collector-freshness` monitor exists. The GitHub sentinel's
per-suburb `CATALOG_STALENESS` check is the backstop. Do not treat the sentinel as covering the
freshness job until you have confirmed it. The fix for the gap is to set the webhook on the
schedule (a new secret) or to write a `crawl_run_status` row from the freshness mode. Neither is
in v1.

### Enable a rig

Authorize and cut off rigs with the admin connector's `housing_crawl_authorize` tool
(scope `crawl:authorize`, see `docs/mcp-admin.md` "Housing crawl authorization"). Do not
write the allowlist by SQL. The tool changes both switches a push needs: shorted's
allowlist row, and BrandBrain's `housing_crawl_v1` grant.

1. The rig passes `ProbeAuth` on the collector revision that the ingest accepts.
2. Authorize it: `housing_crawl_authorize` with `rig_id`, `enabled: true` and `confirm: true`.
   The result reports `shorted`, `brandbrain` and `ingest_admits`.
3. `ingest_admits` is the deployed ingest's own answer. It is `true` only when the deployed
   revision lists `rig:<id>` in `HOUSING_INGEST_ALLOW_SUBJECTS` and sets `HOUSING_INGEST_ORG`.
   When it is `false`, the rig is authorized but not admitted yet. Make the reviewed deploy
   change: add `rig:<id>` to `ingest_allow_subjects` and set `ingest_org` in
   `terraform/environments/prod` (`module "housing_ingest"`), then deploy. Run the tool
   again and confirm `true`.

The env list the deployed revision carries is the deploy-time ceiling. The allowlist row can
only narrow it: a rig absent from the list is refused whatever its row says.

`ingest_admits: unknown` right after a deploy, or at any time, means the admin tools could not
read the deployed ingest config. Check the shorts-api service's permissions first. The
`roles/run.viewer` binding is on the `housing-ingest` service, and it is meant to cover
`services.get` and `revisions.get`. The service-level role may not cover `revisions.get` on
every project setup. If `unknown` persists after the deploy, confirm that the shorts-api
service account can read the latest ready revision of `housing-ingest`, and, if it cannot, add the narrowest
binding that does (a reviewed Terraform change, not an ad-hoc grant). `HOUSING_INGEST_RUN_SERVICE` must also be
set on shorts-api, which Terraform does from `module.housing_ingest.service_name`.

### Cut a rig off

Disable it with `housing_crawl_authorize` and `enabled: false`. Shorted's side takes effect
within about a minute, because the ingest caches its allowlist for 60 seconds. With
BrandBrain unavailable, disable by `subject` (from `housing_crawl_rigs`). That changes only
shorted's row and never calls BrandBrain (`brandbrain: not_attempted`). Revoke the BrandBrain
grant later, when it is reachable, with `rig_id`.

Removing the rig from `ingest_allow_subjects` is the permanent form. It is a reviewed deploy,
not a database write.


### Quarantine

A sweep the guard holds back is recorded in `crawl_ingest_quarantine` with its reason and
counts, never its listing rows. Inspect the newest holds:

```sql
SELECT id, rig_subject, job_id, reason, stats, created_at
FROM crawl_ingest_quarantine ORDER BY created_at DESC LIMIT 20;
```

When a hold is reviewed and found to be real market movement, release that suburb for a short
window. The bypass is keyed by the catalog slug, the state in capitals and the source:

```sql
INSERT INTO crawl_ingest_quarantine_bypass (suburb, state, source, expires_at, note)
VALUES ('st-kilda', 'VIC', 'rea', now() + interval '2 hours', '<ticket>: reviewed <reason>');
```

The service never deletes a bypass row, so each release stays in the audit trail. Keep
`expires_at` short. The service does not replay a held sweep. The next push for that suburb
and source is evaluated with the bypass in place.

### Dispatch ledger, at a glance

`crawl_dispatch` holds one row per job a rig may push for. `closed_at` is set by the first
applied COMPLETE or PARTIAL receipt. A re-enqueue refreshes `expires_at` on open jobs only and
never reopens a closed one. `crawl-finalize` deletes terminal rows (closed, or expired while
open) older than 14 days, in batches. Look at the latest runs:

```sql
SELECT run_id, count(*) AS jobs, count(closed_at) AS closed, max(created_at) AS made
FROM crawl_dispatch GROUP BY run_id ORDER BY made DESC LIMIT 5;
```

### Pause everything

Set `server_schedules_paused = true` in the prod module and deploy (the reviewed route). In an
emergency, `gcloud scheduler jobs pause house-price-collector-<name> --location=australia-southeast1`
for each schedule, then reconcile Terraform. The ingest's allowlist is the kill switch for
rigs; see "Enable a rig".

### Known limits (v1)

- The finalize watermark follows `crawl_ingest_receipts.created_at` only. `property_price_events`
  has no index on `created_at`, so a `max()` there would scan the table every 30 minutes.
  The legacy rig path still does its own MV refresh until its cutover.
- The watermark assumes no push runs longer than 10 minutes (`crawlWatermarkMargin`). A push
  that does can still be missed. Raise the margin if a sweep's push ever takes that long.
- Server `freshness` has the alerting gap described under "Alerting after unpause".
- The server jobs connect over the transaction pooler (6543), like the monthly job. A failed
  finalize step holds the cursor, so the next run retries the same data.
- The ingest has no custom domain. Rigs use the `run.app` URL.
