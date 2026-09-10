# Handover — housing hazard overlays, CI reliability, the 15-day crawl outage

Session of 2026-09-08/10. Everything below is **merged and live** unless marked
otherwise. Written so a fresh session can continue without re-deriving anything.

## 1. What shipped

### Housing hazard overlays (#608, live)

The suburb map gained a second, independently toggled layer above the "Colour
by" choropleth: **flood planning area** (NSW/VIC), **observed surface water**
(national), **bushfire prone land** (NSW/VIC). The suburb page gained a
**Terrain & hazard exposure** card, which is also the first surfacing of the
elevation pipeline built in #504 and never rendered.

- Table `suburb_hazard_exposure` (migration **000122**, hand-applied to prod and
  recorded in `PROD_APPLIED.md`, also on the deploy allowlist as replay-safe).
- Collector `-mode hazards` loads `web/public/geo/insights/suburb-hazards.json`
  (15,329 suburbs; water 15,316, flood + bushfire 7,486 across NSW and VIC).
- Offline build: `web/scripts/geo/hazards/` — see its README. It reuses the DEM
  zonal-stats rig on `/Volumes/gamma-systems-2/`.
- Twelve overlay TopoJSONs in `web/public/geo/hazards/`.

**The wording rules are not decoration** — see
`docs/feature/housing/data-sources.md` § "Hazard layers — what the words mean".
Observed water is *observed*, never "flood risk". Statutory layers are
planning-control boundaries, not flood extents. **NULL is "no source", never 0.**

Verified on prod: ACT returns all 138 flood values NULL (no statutory layer);
Windsor NSW returns flood **0%** — a measured zero — beside 1.9% observed water
and 19% bushfire.

**Known data limitation, already documented:** the Sydney CBD reads ~23%
"observed under water" even after DEA's confidence mask, because the classifier
reads tower shadow as water. DEA's own filtered product agrees (~21%). Stated in
the layer caveat. Do not "fix" it.

### Map performance + layer panel (in #608)

Measured on NSW (4,558 suburbs), p95 frame / frames over 50ms:

| | before | after |
|---|---|---|
| hover | 233ms, 41 of 116 | 33ms, 0 |
| wheel zoom | 150ms, 46 of 231 | 17ms, 0 |
| drag pan | 100ms, 111 of 467 | 17ms, 0 |

Three independent causes: every pointer move re-rendered every path (now a
memoised `SuburbPath`); every zoom frame re-rasterised the SVG (now a composited
CSS transform during the gesture, committed on end — `lib/housing/map-gesture.ts`);
and **the big one** — the no-data hatch was a `fill="url(#pattern)"` instantiated
4,500× per repaint, now one clipped `<rect>`. Also: the suburb list no longer
`scrollIntoView`s on hover.

### CI reliability (#609)

**Root cause: PR #600 (2026-09-08) moved every job to the self-hosted Cuttlefish
runner** on the premise that a real Linux host behaves exactly as GitHub-hosted.
True for services/container/apt/setup-caches; **false for the preinstalled
toolchain** — GitHub images ship `psql` and `gh`, a bare `actions/runner`
container ships neither.

- housing-freshness broke outright (exit 127 in 9ms, never ran a query). Now
  runner-independent: psql in a `postgres:15-alpine` container, issue filed via
  `actions/github-script`.
- economy-freshness, edge-error-sentinel, rate-limit-sentinel and
  shorts-data-freshness only touch `gh` on the **alarm path**, so they stayed
  green while healthy and would fail exactly when they had something to report.
  Moved back to `ubuntu-latest` with the reason inline.
- `timeout-minutes` added to every job (there were none; a lost runner burned up
  to the 6h default on a box also serving four prod services). Values are ~2× the
  observed maximum successful duration.
- Concurrency groups on the three PR-triggered workflows that lacked them,
  cancelling only for `pull_request`.
- `terraform-deploy-workflow.test` switched from `existsSync` to git-tracked
  content — it failed only locally, which is what teaches `--no-verify`.

**Do NOT enable the setup-go cache.** `housing-lifecycle.test.mjs` documents that
its cache *save* hangs on these runners; `cache: false` is load-bearing.

### Crawl 401 diagnosis (#610)

The rig had captured nothing since 2026-08-25. A 401 that cannot be refreshed now
names the missing capability and what to do, and carries the refresh failure's own
reason, flattened to one line so it survives into `crawl_run_status.detail` —
which is what the freshness sentinel quotes.

## 2. The crawl outage — resolved, and the cause was NOT a sign-out

`/control/v1/status` reported `authenticated: true` while
`/control/v1/auth/session/export` returned 404 "no active session to export".
**Those two disagreeing IS the fault.** `POST /control/v1/auth/refresh`
reconciled them; export then returned a live token with a 30-day refresh window.
No browser sign-in, no minted credential, no env change.

**Recovery sequence, in order:**
1. `open -a BrandBrainAgent`
2. Check `/control/v1/status` — if authenticated but export 404s, it is this.
3. `POST /control/v1/auth/refresh`
4. Verify `GET /control/v1/auth/session/export` returns 200.
5. `launchctl kickstart -k gui/$(id -u)/com.shorted.housing-delta`

**Never** hand-run `go run . -mode agent` to recover: it claims jobs and orphans
leases, and it is dry-run by default so it writes nothing anyway.

Result within the hour: 18/20 suburbs, 1,314 listings, 667 events; event silence
360h → 0.1h.

## 3. Still open

1. **PR #614 — edge sentinel MCP fix. Open, not merged.** Checks were running at
   handover. This is the only unmerged work.
2. **Crawl backlog.** The kickstarted run ended in `rewarm` at 21/38 jobs (the
   designed Kasada exit, not a fault). **468 suburbs remain stale >132h.** The
   delta job is `StartCalendarInterval` **10:00 daily**, not hourly, and
   `CRAWL_DELTA_MAX_SUBURBS` is 120 — roughly four days to catch up. Issue **#595**
   stays open until the sentinel goes green, then closes itself.
3. **Rig runs a stale binary.** `deploy/stage-rig.sh` is needed to pick up #610's
   better 401 message. Not needed for recovery.
4. **Revoked seed token** still in `~/.shorted-housing-crawl.env`; harmless, but
   costs a wasted 401 on the first request of every run before it refreshes.
5. **MCP streams die every 5 minutes** at Cloud Run's 300s request timeout, each
   holding a request slot until then. Clients reconnect, so probably invisible to
   users. The clean fix is for the MCP handler to close idle streams gracefully
   before the platform timeout. Deliberately out of scope of #614, which only
   stops the false alarm.

## 4. Traps worth knowing

- **Prod does not run `migrate up`.** Hand-apply on the session pooler (5432) with
  `statement_timeout=0`, then record in `PROD_APPLIED.md`.
- **A red sentinel is not a broken sentinel.** A failure conclusion is its
  *designed* output when data is stale. Distinguish by **step duration**: a broken
  run dies in ~0s, a working one takes 9–15s. I got this wrong first and claimed
  a 12-day outage that had not happened.
- `crawl_run_status` is written only at the **end** of a run, so mid-run the only
  live signal is `property_price_events`. The wrapper's logs in
  `~/Library/Logs/shorted-housing-delta.*` are buffered and usually empty.
- The repo-root `.env` scoped `CLOUDFLARE_API_TOKEN` **cannot read analytics**;
  use `TF_VAR_cloudflare_email` + `TF_VAR_cloudflare_global_api_key`.
- Visual baselines must be Bookworm-generated. **Do not run the skill's
  `docker … npm ci` against the bind-mounted repo — it deletes the Mac
  `node_modules` (it happened twice).** Build Storybook on the Mac, then run only
  Playwright in the container with `--output /tmp/pw-results`.
- CI on this repo has a real flake rate. Signature: job marked failed, a step with
  a `null` conclusion, log unretrievable, all tests already printed `ok`. Verify
  locally, then `gh run rerun <id> --failed`.
