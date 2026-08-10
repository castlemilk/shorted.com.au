# Residential housing collector deploy (macOS, launchd)

This directory contains the macOS launchd paths for sources that require
residential egress.

For the real-estate crawl, the supported deployment is the queue-backed daily
delta plus fortnightly full scheduler. It runs on residential Macs because the
crawl needs a residential IP and the host's dedicated warm Chrome. The older
static-shard and whole-catalog agent launchd jobs remain documented only as
deprecated compatibility paths.

NSW Valuer-General PSI uses a separate, non-browser collector mode because its
public yearly ZIPs do not clear the Cloudflare challenge from Cloud Run.

## NSW Valuer-General PSI (`-mode vg-nsw`)

The normal Cloud Run `official`/`all` schedule deliberately skips `vg_nsw` so it
does not repeatedly challenge the NSW site from datacenter egress. It still runs
the persisted-period freshness assertion: a missing `vg_nsw` source or a period
older than the configured 550-day horizon writes an error to
`house_price_ingest_runs` and exits non-zero. The dedicated `vg-nsw` mode fetches
only NSW PSI from an approved residential Mac, writes regions/facts/run status,
asserts NSW freshness, refreshes housing views after a successful ingest, and
propagates exit `1` on failure.

No Chrome or Playwright setup is needed for this source. Build the same collector
binary used by the crawl:

```bash
cd services
go build -o "$HOME/bin/house-price-collector" ./house-price-collector/
```

Create a dedicated machine-local env file (never commit it):

```bash
cat > "$HOME/.shorted-housing-vg.env" <<'ENV'
DATABASE_URL=postgresql://...  # prod Supabase transaction pooler, port 6543
# VG_NSW_TIMEOUT_MIN=240
# HOUSING_VG_BIN=/absolute/path/to/house-price-collector
# HOUSING_VG_LOG=/absolute/path/to/shorted-housing-vg-nsw.log
ENV
chmod 600 "$HOME/.shorted-housing-vg.env"
```

Run it manually first and check the propagated status/log:

```bash
cd services/house-price-collector/deploy
bash run-housing-vg-nsw.sh
echo "$?"  # 0 = ingested and fresh; 1 = fetch/persist/freshness failure
tail -100 "$HOME/Library/Logs/shorted-housing-vg-nsw.log"
```

Install the monthly launchd job (8th at 04:30 local):

```bash
cd services/house-price-collector/deploy
REPO="$(cd ../../.. && pwd)"
sed -e "s#__REPO__#$REPO#g" -e "s#__HOME__#$HOME#g" \
  com.shorted.housing-vg-nsw.plist.template \
  > "$HOME/Library/LaunchAgents/com.shorted.housing-vg-nsw.plist"
plutil -lint "$HOME/Library/LaunchAgents/com.shorted.housing-vg-nsw.plist"
launchctl unload "$HOME/Library/LaunchAgents/com.shorted.housing-vg-nsw.plist" 2>/dev/null
launchctl load "$HOME/Library/LaunchAgents/com.shorted.housing-vg-nsw.plist"
launchctl start com.shorted.housing-vg-nsw
```

After the first real run, verify persistence rather than relying only on the
process log:

```sql
SELECT count(*) AS rows, MAX(period) AS max_period, MAX(fetched_at) AS fetched_at
FROM house_prices WHERE source = 'vg_nsw';

SELECT source, last_period, last_fetched_at, rows_upserted, status, detail
FROM house_price_ingest_runs WHERE source = 'vg_nsw';
```

Do not schedule this mode on Cloud Run and do not add a challenge-bypass or
user-agent-only workaround. If the residential run is challenged, leave the
non-zero status/error row intact and investigate the official source manually.

## Real-estate crawl — supported deployment (delta + full)

- `com.shorted.housing-delta`: daily at **10:00 local**, selecting only
  never-crawled, stale, or churny suburbs.
- `com.shorted.housing-full`: on the **1st and 15th at 08:00 local**, rechecking
  the full catalog.

These daytime hours are intentional. Observed REA/Kasada clearance and block
reliability degrades late at night; do not restore the retired overnight schedule.
Both wrappers drain the queue to empty, share a single-drainer lock, and run the
freshness alarm afterward.

### One-time setup per Mac

1. Build the collector for this Mac's architecture:
   ```bash
   cd services && go build -o "$HOME/bin/house-price-collector" ./house-price-collector/
   ```
2. Install the Playwright driver the CDP client needs (this pulls chromium for the
   driver bootstrap; the crawl still renders on the *host* Chrome, not this one):
   ```bash
   cd services && go run github.com/playwright-community/playwright-go/cmd/playwright install chromium
   ```
3. Optionally do a first warm-up. The collector now self-warms, but this is a
   useful ready-check. Launch the DEDICATED profile (never the personal profile)
   with a REA URL as Chrome's startup page:
   Chrome's own (non-automated) startup navigation clears REA's Kasada challenge
   and sets a session cookie. A Playwright-driven warm, or warming Domain, does
   not clear Kasada; REA then returns an ~870-byte KPSDK stub and the sweep is
   marked `blocked`. No manual clicking:
   ```bash
   /Applications/Google\ Chrome.app/Contents/MacOS/Google\ Chrome \
     --remote-debugging-port=9222 \
     --user-data-dir="$HOME/.shorted-housing-crawl-chrome" \
     "https://www.realestate.com.au/"
   ```
4. Create `~/.shorted-housing-crawl.env` (`chmod 600`; never commit it):
   ```bash
   DATABASE_URL=postgresql://...            # prod Supabase (transaction pooler)
   CRAWL_CDP_URL=http://localhost:9222
   BRANDBRAIN_AGENT_URL=https://api.brandbrain.dev
   CRAWL_LISTINGS_MIN_PER_PAGE=1            # avoids thin-suburb false blocks
   # CRAWL_DRY_RUN defaults to false in the wrapper; set true to rehearse.
   # --- Event-driven cache busting (optional; see "Cache revalidation" below) ---
   REVALIDATION_URL=https://shorted-com-au-document-analyser.vercel.app/api/revalidate
   REVALIDATION_SECRET=...                   # same value as the Vercel frontend env
   ```
5. Retire both older jobs, then install the supported delta/full pair. This is
   the only launchd install procedure in this runbook:
   ```bash
   cd services/house-price-collector/deploy
   REPO="$(cd ../../.. && pwd)"   # repo root

   launchctl unload "$HOME/Library/LaunchAgents/com.shorted.housing-crawl.plist" 2>/dev/null
   launchctl unload "$HOME/Library/LaunchAgents/com.shorted.housing-agent.plist" 2>/dev/null
   rm -f "$HOME/Library/LaunchAgents/com.shorted.housing-crawl.plist" \
         "$HOME/Library/LaunchAgents/com.shorted.housing-agent.plist"

   for job in housing-delta housing-full; do
     sed -e "s#__REPO__#$REPO#g" -e "s#__HOME__#$HOME#g" \
       "com.shorted.$job.plist.template" \
       > "$HOME/Library/LaunchAgents/com.shorted.$job.plist"
     launchctl unload "$HOME/Library/LaunchAgents/com.shorted.$job.plist" 2>/dev/null
     launchctl load "$HOME/Library/LaunchAgents/com.shorted.$job.plist"
   done
   ```

### Rehearse and operate

```bash
# Rehearse the supported delta wrapper without writes:
CRAWL_DRY_RUN=true bash run-housing-delta.sh

# Kick the supported daily job now:
launchctl start com.shorted.housing-delta

# Read-only freshness check:
~/bin/house-price-collector -mode freshness; echo $?
```

Exit codes: `0` ok · `3` re-warm signalled · `4` Chrome unreachable · `5` REA
warmcheck failed · `6` freshness alarm.

## Deprecated compatibility paths

Do not install `com.shorted.housing-crawl.plist.template` (static shards) or
`com.shorted.housing-agent.plist.template` (whole-catalog drainer). The former is
manual-only and has no schedule; the latter is superseded by both the delta/full
pair and BrandBrain 1.8.0+'s in-app auto-crawl. Their scripts remain for manual
compatibility and troubleshooting, not as supported scheduled deployment.

### Legacy standalone launcher reliability

`run-housing-crawl.sh` no longer depends on an operator remembering to launch
Chrome with a REA startup URL by hand. Before every run it: (1) auto-launches
the dedicated Chrome if the CDP port isn't reachable, (2) runs the collector's
`-mode warmcheck` preflight to PROVE the REA session actually cleared Kasada
(a reachable CDP port is not the same thing as a warm REA session), relaunching
Chrome + re-checking up to twice if it's cold, and (3) only then runs the real
crawl. The manual launch command in step 3 above is still useful for a first
warm-up / manual rehearsal, but the scheduled launchd run does it itself.

### Queue mode (`-mode agent`) — auth via the co-located BrandBrain agent

The launcher above runs the STANDALONE path (`-mode listings` / `-mode crawl`,
each Mac crawling its own shard directly). To instead drain the shared
**brandbrain crawl-jobs queue** (`api.brandbrain.dev`) so multiple Macs fan
suburbs out via SKIP-LOCKED, run `-mode agent` / `-mode enqueue`.

**No token to mint or manage.** On any rig where the BrandBrain **macOS agent is
signed in**, the collector authenticates by re-reading the agent's *current*
access token from its loopback control API — and re-fetches a fresh one
automatically on a `401`. So an unattended batch never expires mid-run, and there
is no long-lived credential to mint, store, or rotate.

```bash
# ~/.shorted-housing-crawl.env
BRANDBRAIN_AGENT_URL=https://api.brandbrain.dev
CRAWL_AGENT_ID=housing-<host>          # optional; names this rig in the queue
CRAWL_AGENT_MAX_JOBS=8                  # safety cap per run
# BRANDBRAIN_AGENT_TOKEN is OPTIONAL — the collector reads the running agent's
# token from ~/.brandbrain/{diag-port,control_secret} and refreshes it on 401.
# Override the endpoint with BRANDBRAIN_CONTROL_PORT / BRANDBRAIN_CONTROL_SECRET.
# Optional — event-driven cache busting after the run's MV refresh (see below):
REVALIDATION_URL=https://shorted-com-au-document-analyser.vercel.app/api/revalidate
REVALIDATION_SECRET=...                 # same value as the Vercel frontend env
```

Enqueue the suburb catalog once (`-mode enqueue`), then each rig runs `-mode
agent` (claim → warm-Chrome crawl → submit counts back). A suburb an agent
reports `failed` **auto-re-pends up to `max_attempts` (3) across warm runs** once
the brandbrain-side `Submit` re-pend fix lands (branch `fix/crawl-submit-repend`),
so a transient block no longer needs a manual re-enqueue.

Why this works: the agent's session access token has a **15-min TTL** (rotated
~every minute off a **30-day** refresh token). The old approach snapshotted it
once (`get-bb-token.sh`), so an unattended batch `401`'d after ~11–16 min and only
cleared ~3–6 suburbs. The collector now re-reads the always-fresh token from the
running agent on demand — the agent is the durable auth, no minting required.

**Fallback — a rig with no local BrandBrain agent** (e.g. a headless box): supply
a long-lived scoped token in `BRANDBRAIN_AGENT_TOKEN`. brandbrain natively
supports these (`api_tokens`); a token with **both** `agent:crawl` + `agent:upload`
scopes is a drop-in. Mint via `POST /api/v1/ml/auth/tokens`
(`{scopes:["agent:crawl","agent:upload"],expires_in_hours:8760}`, needs
`ML_TOKEN_MINT_SECRET` on the brandbrain env), or bridge with the 24h
`POST /api/v1/agent/refresh`.

### Deprecated whole-catalog auto-drainer

The queue steps above (`-mode enqueue` then `-mode agent`) are wrapped into ONE
self-healing, scheduled job so nobody has to run anything per-crawl:

- `run-housing-agent.sh` — reuses the standalone runner's self-healing Chrome warm
  (auto-launch dedicated Chrome + prove REA's Kasada clearance via `-mode
  warmcheck`), then runs `-mode enqueue` (post the catalog — idempotent) and
  `-mode agent` (claim → warm-Chrome crawl → write listings to prod → submit
  counts). `CRAWL_SKIP_ENQUEUE=true` drains leftover work only.
- `com.shorted.housing-agent.plist.template` — launchd schedule (twice daily by
  default; adjust freely, every run is idempotent).

Do not install this plist on a current rig. Use the supported delta/full setup
above. `run-housing-agent.sh` may still be invoked manually for compatibility.

**One-time credential**: `run-housing-agent.sh` requires `DATABASE_URL` (prod
Supabase, transaction pooler 6543) in `~/.shorted-housing-crawl.env` so the
drainer can write listings. This is the ONLY per-machine secret; provision it
once and the corpus grows on the schedule. (The brandbrain token auto-refreshes
off the co-located macOS agent — no token to mint.) Rig ready-check:
`~/bin/house-price-collector -mode warmcheck` should exit 0.

## Optional: trigger a crawl from a shorted admin endpoint (design)

The launchd drainer above already grows the corpus hands-off on its schedule.
An admin UI **trigger** (so an operator can kick an immediate/targeted crawl from
shorted.com.au rather than waiting for the next scheduled run) is a thin layer on
top — deferred, not yet built. The seam is the queue, so the endpoint's only job
is to ENQUEUE; the scheduled Mac drainer picks the work up on its next tick (or
immediately if you also `launchctl start`).

Sketch (needs sign-off on auth + where the catalog lives before building):
- `POST /api/admin/housing/crawl` — Next.js admin route, gated by the existing
  shorted admin auth. Body: `{ suburbs?: [...], all?: true }`.
- It POSTs enqueue requests to `${BRANDBRAIN_AGENT_URL}/api/v1/agent/crawl-jobs`
  with `Authorization: Bearer ${BRANDBRAIN_AGENT_TOKEN}`. **shorted has no
  brandbrain integration today**, so this adds a new server-side dependency +
  secret (a brandbrain `agent:crawl`-scoped token in shorted's env).
- Catalog source: either (a) accept the suburb list in the request body (a UI
  sends the picked suburbs), or (b) share `crawl_targets.go` → a committed JSON
  both the collector and the endpoint read, to avoid duplicating the 115-suburb
  list. Prefer (b).

Until then, trigger the supported queue-backed crawl with
`launchctl start com.shorted.housing-delta` on the rig (or wait for the schedule).

## Demand-right-sizing scheduler — daily delta + fortnightly full + freshness alarm

The `run-housing-agent.sh` drainer above re-enqueues the **whole catalog** every
run. As the catalog grew (25 → 115 → 500 suburbs) that became wasteful and slow on
a single residential IP with no proxies. The scheduler here **right-sizes demand**
instead of spending: re-crawl only the suburbs that need it daily, do a full
catalog pass occasionally, and **alarm** if the board silently goes stale. It also
closes two gaps: each `-mode agent` run only claims up to `CRAWL_AGENT_MAX_JOBS`
(default 20), so one drain left the queue partly full; and nothing noticed when the
board stopped updating for days.

Three pieces:

- **Daily delta** (`run-housing-delta.sh` → `CRAWL_ENQUEUE_SELECTION=delta -mode
  enqueue`). Reads each catalog suburb's freshness + churn read-only from prod and
  enqueues **only** suburbs that are: never crawled, **stale** (last crawl older
  than `CRAWL_DELTA_TTL_HOURS`, default **24h**), or **churny** (`>=
  CRAWL_DELTA_CHURN_MIN` price events, default **1**, over `CRAWL_DELTA_CHURN_DAYS`,
  default **7d**). Ranked never-first → churniest → oldest, capped at
  `CRAWL_DELTA_MAX_SUBURBS` (default **60**). The capped-off tail is logged (never
  silently dropped).
- **Fortnightly full** (`run-housing-full.sh` → `CRAWL_ENQUEUE_SELECTION=all -mode
  enqueue`). The whole catalog — re-reaches quiet suburbs the delta never selects
  and re-confirms delists catalog-wide.
- **Drain-until-empty.** Both wrappers loop `-mode agent` (via
  `hc_drain_until_empty` in `housing-crawl-common.sh`) until the queue reports empty
  — parsing the collector's stable `[agent] no more jobs` / `[agent] done: processed
  N job(s)` lines — bounded by `CRAWL_DRAIN_MAX_ROUNDS` (default **30**) and honoring
  the exit-3 re-warm / exit-4 Chrome breaks. So one scheduled run clears the whole
  enqueue instead of leaving ~20 jobs behind.
- **Freshness alarm** (`-mode freshness`, READ-ONLY). After draining, both wrappers
  run the freshness guard: it logs freshest / median / oldest covered-suburb age +
  the never-crawled coverage gap, and if the **oldest covered suburb** exceeds
  `CRAWL_FRESHNESS_ALARM_HOURS` (default **72h**) it **exits 6** and best-effort
  POSTs `CRAWL_FRESHNESS_WEBHOOK` (Slack/Discord-shaped `{text,...}`). Never-crawled
  suburbs are a coverage gap, not an alarm (a partially-seeded catalog would
  otherwise alarm forever); a fresh/never-run env (no coverage) never alarms.

**Single-drainer lock (important).** A full pass is NOT a ~1-hour job: **500
suburbs × 2 portals at ~14 suburbs/hr ≈ 30+ HOURS (~1.5 days)**, so it is still
running when the next daily 10:00 delta fires — and rescheduling can't fix a
>1-day job. All three wrappers (delta, full, **and** the legacy
`run-housing-agent.sh`) share ONE host Chrome (`localhost:9222`) + ONE residential
IP, so two concurrent `-mode agent` drainers just halve the pacing and raise the
block risk the no-proxy design avoids. `hc_acquire_lock`
(`housing-crawl-common.sh`) serializes them with a **portable atomic `mkdir` lock**
(macOS has no `flock(1)`) + a PID stale-guard + an EXIT-trap release: while a full
pass holds the lock, each daily delta logs `another housing crawl holds the lock —
skipping this run` and **exits 0** (the full already re-crawls everything). Override
the lock path with `HOUSING_CRAWL_LOCKDIR`.

Env knobs (all optional; put them in `~/.shorted-housing-crawl.env`):

| Var | Default | Meaning |
|-----|---------|---------|
| `CRAWL_ENQUEUE_SELECTION` | `all` | `all` (whole catalog) or `delta` (stale/churny only) |
| `CRAWL_DELTA_TTL_HOURS` | `24` | re-crawl if last crawl older than this |
| `CRAWL_DELTA_CHURN_MIN` | `1` | re-crawl if recent price events `>=` this (`0` disables the churn signal) |
| `CRAWL_DELTA_CHURN_DAYS` | `7` | churn look-back window (days) |
| `CRAWL_DELTA_MAX_SUBURBS` | `60` | per-run delta cap |
| `CRAWL_DRAIN_MAX_ROUNDS` | `30` | drain-loop bound |
| `CRAWL_FRESHNESS_ALARM_HOURS` | `72` | oldest-covered-suburb horizon that alarms |
| `CRAWL_FRESHNESS_WEBHOOK` | _unset_ | optional POST target for the freshness alarm |

Install the jobs with the single canonical one-time procedure at the top of this
runbook: daily delta at **10:00**, and full on the 1st/15th at **08:00**.

Multiple residential Macs can install both jobs — they fan the queue out via SKIP
LOCKED, and every mode is idempotent. Prefer running the **delta** on every rig and
the **full** on one (or stagger the full across rigs) to avoid a fortnightly
thundering herd. Exit `6` from a wrapper = the freshness alarm tripped. Exit
`7` = agent infrastructure or finalization failed; the drain wrappers notify and
preserve that status after still running freshness. Delta
and full wrappers always attempt enqueue, drain, and freshness; final failure
precedence is enqueue, then drain, then freshness.

## Silent-outage diagnosis and recovery

`-mode warmcheck` passing proves only the browser session; it does not prove the
crawl is healthy. Use this **fastest diagnosis order**:

1. `lsof -nP -iTCP:$(cat ~/.brandbrain/diag-port) -sTCP:LISTEN` — is the
   BrandBrain agent control API alive? Never hardcode this re-minted port.
2. `ps -o pid,etime,stat -p $(pgrep -f "house-price-collector -mode agent")` —
   has a collector round exceeded about one hour?
3. `tail ~/Library/Logs/shorted-housing-scheduler.log` — distinguish `401` auth
   failures from `blocked=1`; round output should now stream live.
4. Run `SELECT max(created_at) FROM property_price_events;` on prod — this is the
   true database freshness check, regardless of queue terminal status.
5. Inspect queue state with
   `GET https://api.brandbrain.dev/api/v1/agent/crawl-jobs?status=pending|failed`
   (query each status separately), then inspect `status=in_progress` as below.

The five silent outage modes are:

1. **BrandBrainAgent.app auth death.** The collector borrows auth from the running
   macOS agent; the token snapshot in the env file quickly goes stale. Read the
   current port from `~/.brandbrain/diag-port` and the secret from
   `~/.brandbrain/control_secret`. If the port is not listening, run
   `open -a /Applications/BrandBrainAgent.app`, wait for startup, repeat the
   `lsof` check, and confirm `GET /control/v1/auth/session/export` returns 200
   using that control secret. The refresh token normally survives, so a new login
   should not be necessary.

2. **Thin-suburb queue wedge.** A real low-inventory page can look blocked at the
   default minimum and two consecutive blocked jobs stop a drain. Set
   `CRAWL_LISTINGS_MIN_PER_PAGE=1` in the scheduled env; a genuine block still
   extracts zero. Do not try to purge one suburb: purge filters are coarse and do
   not select by suburb.

3. **Hung drain round.** `CRAWL_TIMEOUT_MIN` cannot interrupt a CDP driver call
   stuck on its pipe. Use the `ps -o pid,etime,stat ...` command above; elapsed
   time beyond about one hour is a hang. `kill <collector-pid>` to release the
   host lock. The wrapper will continue on its next pass, and a hung round with no
   writes has no completed in-flight work to preserve.

4. **Orphaned `in_progress` leases.** Query the exact status
   `GET /api/v1/agent/crawl-jobs?status=in_progress` (`running` and `claimed` are
   wrong). Sort by `updated_at`; anything older than ~2h is orphaned. First run a
   purge dry-run:

   ```bash
   PURGE_STATUSES=in_progress PURGE_TIER=listings \
     "$HOME/bin/house-price-collector" -mode purge
   ```

   Review it carefully: purge is a coarse DELETE and may include a legitimately
   active job. Only then repeat with `PURGE_DRY_RUN=false`, followed immediately
   by `"$HOME/bin/house-price-collector" -mode enqueue` to re-enqueue the deleted
   suburbs. Purging without re-enqueue creates a coverage gap.

5. **Never-attempted jobs reported as false success.** When every owned source was
   skipped by an open circuit, older collectors banked the job as succeeded even
   though no DB write occurred. The deployed compatibility contract is the
   `deferred` outcome: it re-pends the job, refunds the claimed attempt, and sets
   `not_before` for the remaining circuit cooldown. Deploy BrandBrain's deferred /
   `not_before` / refund support before a collector that emits it; against an older
   queue the collector intentionally falls back to `failed`. Diagnose this mode by
   comparing queue successes with the real DB freshness query above.

Direct `-mode agent` invocations default to **`CRAWL_DRY_RUN=true`**. They write
nothing unless `CRAWL_DRY_RUN=false` is explicitly exported; verify the startup
log's `dryRun=` value before trusting a hand-run recovery. Configure
`CRAWL_FRESHNESS_WEBHOOK` so `freshness rc=6` reaches Slack/Discord instead of
remaining only in the scheduler log.

### Tracked as a scheduled job in the admin dashboard

Installing these launchd jobs makes the crawl a **first-class tracked scheduled job**
in the shorted **admin jobs dashboard** (`/admin` → `GET /api/admin/jobs`), alongside
the GCP Cloud Run jobs. The dashboard's job monitor is GCP-only (Cloud Run + Cloud
Scheduler) and can't see a Mac-based job, so each run **self-reports** a health record
to the `crawl_run_status` table (migration `000089`):

- The `run-housing-delta.sh` / `run-housing-full.sh` wrappers export `CRAWL_RUN_TYPE`
  (`delta`/`full`) + a stable `CRAWL_RUN_ID`, so the collector tags the record and the
  several drain rounds of one run **accumulate** their counts (suburbs / listings /
  events / blocked) into a single dashboard row. `-mode freshness` annotates it with
  the oldest-covered-suburb age.
- Health follows the run: a blocked/failed run shows **critical**, a re-warm/partial
  run **warning**, a clean run **ok**. Crucially, a **DEAD RIG** (crashed launchd,
  machine off, Chrome permanently wedged) stops writing, so the row's `finished_at`
  goes stale and the dashboard flips it to warning → critical **automatically** — no
  heartbeat needed. Scheduling stays on launchd (Kasada requires it); only the
  *tracking* now matches the GCP jobs. No extra setup: it works the moment the
  wrappers run against a DB that has migration `000089`.

## Smart pagination

The per-suburb sweep (`sweepSuburbSource`) sizes and stops itself instead of
blindly walking a fixed page cap:

- **Result-count sizing.** `extractPageMeta` reads the portal's own counts from the
  same SRP blob the listings come from. REA also exposes the exact **on-target**
  count (`listings_total`, e.g. 63) separately from the broadened
  `totalResultsCount` (which includes surrounding suburbs, e.g. 969) — the sweep
  sizes REA to the on-target count, so a small suburb stops after ~1 page and a
  dense one is sized to its real inventory (bounded by the `maxPages` ceiling).
  Domain exposes only a broadened total, so it keeps the broadening-detection stop.
  A clean walk that reaches the on-target page count is now `sweepComplete`
  (delist-safe), where before it was always `sweepPartial` at the cap.
- **Yield-decay stop** — ends a sweep when a page adds no new on-target listings
  (catches reordered/overlapping tail pages the duplicate-signature check misses).
- **Cross-page dedup** — a listing seen thin on page 1 is upgraded by a richer copy
  on a later page (fieldScore-max merge), not first-wins.
- **Adaptive page cap** — a per-suburb soft cap seeded from ABS size (`Dwellings`).
- **Adaptive pacing** — page-delay jitter widens after a blocked/high-mismatch page,
  tightens after clean pages.
- **Checkpoint / resume** — set `CRAWL_LISTINGS_RESUME_WINDOW_H=20` to skip a (source,suburb)
  swept within the window (default `0` = disabled) so an interrupted run resumes
  mid-catalog and repeat runs spread over time.

## Circuit breaking (per-source exponential backoff)

`-mode agent` builds a fresh `listingsCrawler` per suburb, so the in-sweep block
counter resets every job and can't see a portal that's blocking across suburbs.
A **per-source circuit breaker** (`crawl_circuit.go`) holds that state at the
agent-loop level instead: after `CRAWL_CIRCUIT_TRIP` (default **2**) consecutive
blocked sweeps of a source (Akamai `errors.edgesuite.net`, Kasada stubs), that
source's circuit **opens** and it is **skipped** for an exponentially-growing,
jittered cooldown — `CRAWL_CIRCUIT_BASE_S` (default **300s**), doubling on each
re-open up to `CRAWL_CIRCUIT_MAX_S` (default **3600s**). The **healthy portal
keeps crawling** the whole time (e.g. Domain blocking never stops REA). After the
cooldown one probe is allowed (half-open): a clean sweep closes the circuit and
resets the backoff; another block widens it. If **every** source is circuit-open
the run stops (leaving those suburbs pending for the next warm run) rather than
burning the queue on a fully-blocked session.

This is what stops a portal that starts rate-limiting from being hammered on
every suburb, which is what escalates the residential-IP flag onto the other
portal too.

## Cache revalidation (`REVALIDATION_URL` / `REVALIDATION_SECRET`)

After a run refreshes the housing materialized views (`-mode agent`, `-mode
listings`, and the official `-mode all`/`crawl`/`refresh` paths), the collector
pings the web tier so it busts its long-TTL SSR caches the instant the data
changes — `/price-drops` and `/housing` re-render fresh instead of waiting out
their ISR ceiling. The ping POSTs to
`<REVALIDATION_URL>?secret=<REVALIDATION_SECRET>&path=/price-drops,/housing&flush=housing`.

It is **best-effort and optional**: a failure only WARN-logs and never fails a
run, and when either env var is unset the collector logs a skip and moves on
(pages self-heal on the ISR TTL). The `-mode agent`/`-mode listings` paths only
ping when the run actually wrote data.

- **`REVALIDATION_URL`** — default the **Vercel origin**
  (`https://shorted-com-au-document-analyser.vercel.app/api/revalidate`), NOT the
  canonical `shorted.com.au` host: Cloudflare's managed challenge can block
  non-browser POSTs to the canonical host (same reason `scripts/take-writer`
  defaults to the Vercel origin). Note that `terraform/modules/cloudflare-edge`
  DOES carry a skip rule for `/api/revalidate`, so the canonical host works too
  — which is why the Cloud Run job (`terraform/modules/house-price-collector`)
  defaults to `https://shorted.com.au/api/revalidate`. Either works from the
  Macs; the Vercel origin is the safe default here.
- **`REVALIDATION_SECRET`** — the same value set in the Vercel frontend env
  (prod Secret Manager `REVALIDATION_SECRET`, project `rosy-clover-477102-t5`).

## Debug tracing (`CRAWL_TRACE`)

To debug/tune collection against live REA/Domain, set `CRAWL_TRACE=1`. With no
`CRAWL_TRACE_DIR`, the collector allocates a unique private directory under the
absolute OS temp directory, keeping raw portal artifacts outside the checkout.
Set `CRAWL_TRACE_DIR` to an explicit path to retain traces in a known local
location; optional `CRAWL_TRACE_SUBURB=<Display>` traces one suburb. Off by
default = zero overhead. Per swept `(suburb,source)` it writes to
`<trace-root>/<runId>/<suburb>-<source>/`:

- `p{N}.png` — a screenshot of each rendered SRP (via the CDP fetcher),
- `p{N}.html` — the raw fetched blob (offline re-parse),
- `trace.jsonl` — one record per page with the exact pagination signals
  (`page,url,ms,bytes,extracted,matched,mismatch,total_results,on_target_results,want_pages,new_ids,outcome,status,decision`),
- `summary.json` — the final sweep status + counts.

Trace artifacts contain portal listing data + screenshots → they stay **local to the
rig** (outside the checkout by default, never uploaded to brandbrain).

## Live telemetry (`CRAWL_TELEMETRY`) — extraction in-flight

Off by default. Set `CRAWL_TELEMETRY=1` (or `CRAWL_TELEMETRY_PATH=/path`) and the
`-mode agent` collector appends one NDJSON event per line to
`~/.shorted-housing-crawl/telemetry.ndjson` **as it crawls** — `run_start`,
`suburb_start`, one `listing` per extracted property (address, price, status,
beds/baths, agency + agents, and the detail `url`), `suburb_done`, and `error`
(a blocked/poison sweep, with debug). A co-located UI (the BrandBrain macOS
agent's Real-estate tab) tails the file to show extraction in-flight and WHY a
sweep failed. LOCAL only — unlike the counts-only summary posted to brandbrain,
the per-listing data here never leaves the machine. Distinct from `CRAWL_TRACE`
(per-page screenshots/HTML written after a sweep, for offline debugging).
