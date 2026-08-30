# Pipeline

Every mode is `house-price-collector -mode <name>`, implemented in
`services/house-price-collector/`. **22 modes** (`main.go:25`; the switch also
accepts an undocumented `abs` alias for `official`). The monolith's "7 modes"
and CLAUDE.md's "11" are both stale — this table is regenerated from the switch.

**The default mode is `all`, and `all` runs ONLY official ingest + MV refresh.**
Every crawl, census, insights and crime mode is excluded from `all` by design:
`all` fires on the monthly Cloud Run schedule, and an adversarial portal crawl
or a 436MB BOCSAR download must never launch from a deploy or a timer.

**Dry-run split.** The ToS-restricted and destructive modes default to dry-run:
the crawl family (`crawl`/`listings`/`details`/`property`/`agent`) writes only
when `CRAWL_DRY_RUN=false`; likewise `CRIME_DRY_RUN` and `PURGE_DRY_RUN`. The
official + suburb-dimension modes have **no dry-run** — they write every run.

## Where each mode runs

| Where | Modes | Trigger |
|---|---|---|
| Cloud Run job (monthly) | `all` (= `official` + `refresh`) | Scheduler `0 16 5 * *` — 5th, 16:00 UTC (~2–3 AM AEST). Wired into CI + both envs since PR #211; a merge to main deploys it |
| Residential Mac rigs (launchd) | `enqueue`, `agent`, `freshness`, `property`, `warmcheck`, `listings`/`crawl` (legacy) | See wrapper table below. Headed host-Chrome over CDP — **never Cloud Run** |
| Operator, by hand | `census`, `electorates`, `banners`, `amenities`, `lga`, `connectivity`, `funding`, `council-financials`, `crime`, `purge`, `backfill-address` | Manual ingest of precomputed/offline artifacts, or one-time passes |

## Order

```
census ─→ electorates / banners / amenities / lga / connectivity / funding / council-financials
  (creates suburb_demographics rows; the others UPDATE onto them — census first or they no-op)

official ─→ refresh          (all = both; refresh also auto-links house_price_regions.sal_code)

warmcheck ─→ enqueue ─→ agent (drain until empty) ─→ freshness
  (never fetch REA cold; freshness is the read-only sentinel that catches a stale board)
```

`refresh` runs `linkSuburbSalCodes` before the MV refresh, so newly-ingested
suburb regions bridge to ABS `sal_code` automatically — the manual "re-apply
migration 000056 after census" step in older docs is superseded.

## Modes

| Mode | Writes | Notes |
|---|---|---|
| `official` (alias `abs`) | `house_price_regions`, `house_prices`, run cursors | 16 jobs (below) + `refresh` |
| `refresh` | sal_code links, 6 housing MVs, revalidate ping | Detached context — a crawl deadline firing must not kill the refresh of committed data |
| `census` | `suburb_demographics` | Needs `CENSUS_DATAPACK_PATH` + `CENSUS_GEO_DIR` (ABS GCP SAL zip + boundary TopoJSON) |
| `electorates` | `suburb_demographics` federal columns | Needs `ELECTORATES_DIR` (precomputed `web/public/geo/electorates/*.json`) |
| `banners` | `suburb_demographics.banner_*` | From committed `suburb-archetypes.json` (`ARCHETYPES_FILE`) — no crawl |
| `amenities` / `lga` / `connectivity` / `funding` / `council-financials` | `suburb_amenities` / `lga`+`suburb_lga` / `suburb_connectivity` / `lga` grants / `lga` VIC financials | Local-insights family; offline joins loaded via `AMENITIES_FILE` / `LGA_DIR` / `CONNECTIVITY_FILE` |
| `crime` | `suburb_crime_stats` + MV refresh | Yearly, operator-run, `CRIME_DRY_RUN` default true; BOCSAR 436MB + ABS CVS/ERP |
| `enqueue` | brandbrain `crawl_jobs` queue | `CRAWL_ENQUEUE_SELECTION=all\|delta` (default all), `_SOURCE` default `split` (separate REA/Domain jobs), `_BATCH` 40 |
| `agent` | `property_listings`, `property_price_events`, counts-only summary → brandbrain | Queue drainer. `BRANDBRAIN_AGENT_URL` required; token auto-refreshes on 401 |
| `listings` | Same tables, catalog-driven (no queue) | Legacy whole-catalog sweep; self-refreshes MVs internally |
| `details` | `property_listing_details`, delist events | Per-listing detail pages; closes the per-portal SRP gap. Its `house_price_ingest_runs` cursor is named `listing_details` — that is the cursor, not the table |
| `property` | `property_valuations` | property.com.au per-address AVM enrichment of the existing address corpus. **Known-open:** serving these per-address values contradicts migration 000088's research-only posture — fix in flight |
| `crawl` | `house_prices` (crawled medians) | Oldest tier, suburb-median sweep; exit 3 on re-warm |
| `freshness` | — (read-only) | Exit 6 + `CRAWL_FRESHNESS_WEBHOOK` POST when the oldest covered suburb crosses `CRAWL_FRESHNESS_ALARM_HOURS` |
| `warmcheck` | — (read-only) | Fetches one REA page via the real fetcher; `ArgonautExchange` present = warm (0), Kasada stub = 5 |
| `install-driver` | — (driver files only) | Installs/repairs the Playwright driver into `CRAWL_PW_DRIVER_DIR`. Needs no DB, no Chrome — dispatched before the `DATABASE_URL` check so a rig with a broken environment can repair itself with only the binary. This is the fix rc=8 names |
| `purge` | brandbrain queue deletions | Post-refactor cleanup; `PURGE_SOURCE/KIND/TIER/STATUSES`, dry-run default |
| `backfill-address` | `address_key` on listings + events | One-time, idempotent |

## Official ingest (the 16 jobs)

`runOfficial` runs, in order: `abs_res_dwell_st`, `abs_res_dwell`, `abs_rppi`,
`abs_lend_housing`, `abs_derived_index`, `rba` (E2 debt-to-income),
`rba_f6_rates`, `rba_cash_rate`, `rba_housing_credit`, `rba_balance_sheet`,
`abs_wpi`, `abs_cpi_rents`, `abs_price_to_income`, then the Valuer-General
suburb tiers `vg_sa`, `vg_vic`, `vg_nsw`. Each records a `house_price_ingest_runs`
cursor (`ok`/`error`).

**Known-open (fix in flight on feat/housing-\* branches):** a failed official
job logs, writes an `error` cursor and **continues — the process still exits 0**,
and no freshness sentinel covers the official tier (`-mode freshness` watches
only the listings crawl). This is how the VG gaps went unnoticed: as at
2026-08-09, NSW VG suburb medians have never landed in prod and VIC is frozen at
Dec-2024 (the upstream fetch currently 403s), despite all three jobs existing in
the code.

## Crawl queue lifecycle (overview)

The catalog is **500 suburbs** (`crawl_targets.go`, dwelling-count hints
included — not the "115" in older docs).

1. **`enqueue`** posts per-source (REA and Domain separately) suburb jobs to
   the brandbrain queue — counts-only job shapes, no listing PII. `delta`
   selection right-sizes to never-crawled/stale/churny suburbs.
2. **`agent`** claims up to `CRAWL_AGENT_MAX_JOBS` (default 20), sweeps SRPs
   through the warm host-Chrome CDP session, and writes listings + price events
   **directly to shorted prod**.
3. **Submit**: a counts-only summary goes back to brandbrain. Terminal status
   is computed from **events written, not raw `seen`** (`agentJobTerminal`) —
   a persist/diff error forces `failed` even when the sweep saw listings,
   because 0 events is otherwise indistinguishable from a clean no-change run.
4. **Terminal status**: since brandbrain #168 (merged 2026-07-16) a submitted
   `failed` auto-re-pends while `attempts < max_attempts` — no manual
   re-enqueue. Two consecutive blocked sweeps trip the circuit breaker → exit 3.
5. **`freshness`** closes the loop as the staleness alarm.

Anti-poisoning detail (validation gates, sweep-poison vs broadening, Kasada
warm mechanics) lives in [architecture.md](architecture.md); day-to-day rig
recovery in [operations.md](operations.md).

## Timeouts and exit codes

`CRAWL_TIMEOUT_MIN` sets the whole-process deadline. Default **15 min**;
`agent`/`listings`/`crawl`/`details`/`property`/`crime` default **240 min** — a
caller that exports its own low value self-aborts a healthy multi-suburb batch
mid-write (this bit the bundled macOS agent).

| Exit | Meaning |
|---|---|
| 0 | OK (also: freshness fresh, warmcheck warm) |
| 1 | The freshness query itself failed, **or an operator-ingest mode failed** (see below) |
| 3 | Re-warm needed — Kasada/Akamai clearance expired (crawl family; launchd wrappers self-heal on it) |
| 4 | Fetcher init failed — wedged/cold Chrome (`agent`); wrapper Chrome relaunch failed (`run-housing-crawl.sh`) |
| 5 | `warmcheck`: REA returned the Kasada stub — Chrome must relaunch with an REA startup URL |
| 6 | `freshness` ALARM — the board is silently going stale |

### Operator-ingest modes propagate failure (2026-08-27)

`census`, `electorates`, `banners`, `amenities`, `elevation`, `lga`,
`connectivity`, `funding`, `council-financials`, `crime` and `backfill-address`
used to log their error, write an `error` cursor and **return normally**, so the
process exited 0 and every wrapper, scheduler and alert read a failed run as a
healthy one. They now return `error` and dispatch through `ingestExit` in
`main.go`, so a failed ingest is exit 1.

This is how `-mode census` ran its entire life without ever succeeding in a
container: `censusGeoDir()` resolves to a repo-relative
`../web/public/geo/suburbs` that is absent from the image, `readSuburbRegistry`
failed on every run, and nothing said so. (It is operator-run only — the
Terraform module schedules just `-mode all` and `-mode drop-index` — so no Cloud
Run scheduler was sitting green on it, but launchd/shell wrappers were.)

Three modes deliberately stay out of this: `seifa`/`vg-nsw`/`vg-vic` already had
their own `return 1`; `purge` bails out early by design when no BrandBrain
credentials are set, which is a legitimate no-op; `mcp` is a long-lived server.

The guard is `TestOperatorIngestModesPropagateFailure`, which parses `main.go`
and asserts each mode's case clause ends in `return ingestExit(...)`. It is a
source-level assertion on purpose — a mode that drops its error still logs, still
records `"error"` in `sync_status` and still exits 0, so the dispatch shape is
the only observable difference.

## Revalidation ping

`pingRevalidate` POSTs `REVALIDATION_URL?secret=…&path=/price-drops,/housing&flush=housing`
after data lands — callers: `refresh` (official/crawl), `agent` (end-of-run,
gated on events actually committed), `listings`. Best-effort: it runs on a
**detached 45s context** (a `CRAWL_TIMEOUT_MIN` deadline firing between the
write and the ping must not kill the cache bust) and **no-ops silently** when
`REVALIDATION_URL`/`REVALIDATION_SECRET` are unset — pages then self-heal on
the ISR TTL. Rigs read both from `~/.shorted-housing-crawl.env`; the Cloud Run
job from Terraform (`manage_revalidation_secret`).

## Rig wrappers (launchd)

All drainers share one host Chrome + one residential IP, so
`housing-crawl-common.sh` holds a **single-drainer lock** — the daily delta
skips cleanly while a full pass holds it.

Exactly **three** LaunchAgents are installed on the rig. The other wrappers
exist in the repo but are **not scheduled** — do not read them as running work.

| Wrapper | Schedule | Runs |
|---|---|---|
| `run-housing-delta.sh` | **10:00 local, daily** | `CRAWL_ENQUEUE_SELECTION=delta` enqueue → drain → `freshness` |
| `run-housing-full.sh` | **1st + 15th, 08:00** | `CRAWL_ENQUEUE_SELECTION=all` enqueue → drain → `freshness` |
| `run-housing-property-resolve.sh` | **21:20 daily** | `property-resolve` |
| `run-housing-rescan.sh` | manual (`nohup`) | Supervised loop re-invoking the full pass past re-warm stops until the queue drains |
| `run-housing-agent.sh` | **not currently installed** | `enqueue` → drain `agent` until empty |
| `run-housing-property.sh` | **not currently installed** | `property` |
| `run-housing-crawl.sh` | **not currently installed** (legacy) | Chrome relaunch/warm + `warmcheck` preflight + `listings` + `crawl` |

Both scheduled drainers open by logging the running binary's `vcs.revision`
(`hc_log_binary_provenance`) and then wait — bounded, non-fatal — for the
BrandBrain agent's loopback control port before enqueueing
(`hc_wait_for_agent`), so a run cannot race the agent's auth mint after a
restart.

### Knobs that set the crawl's throughput and its alarms

These two move **together**. The cap is what the crawl can actually deliver;
the horizon is what we agree to be alarmed about. Setting a horizon the cap
cannot meet produces an alarm that is always on, which is how the catalog
reached a 305h-oldest suburb without anyone treating it as an incident.

| Variable | Default | Why |
|---|---|---|
| `CRAWL_DELTA_MAX_SUBURBS` | **120** | Per-run selection cap = the whole crawl's ceiling. 500 suburbs ÷ 120/day ≈ **4.2-day rotation** (~9.6h crawl/day). Was 60, which implied ~8.3 days. Walk it back if `crawl_run_status` blocked-rate climbs — and walk the horizon back with it |
| `CRAWL_FRESHNESS_ALARM_HOURS` | **120** | Oldest-covered-suburb horizon that trips exit 6. Matches the rotation above with margin. Was 72, which needs ~167 suburbs/day ≈ 13.4h crawl/day — never configured, never reachable |
| `CRAWL_PW_DRIVER_DIR` | `~/.shorted-housing-crawl/pw-driver` | Keeps the Playwright driver out of `~/Library/Caches`, where a disk sweep deleted it and took the crawl down for two days (2026-08-13). Repair with `-mode install-driver` |
| `CRAWL_ALERT_WEBHOOK` | unset | The rig's push channel (`hc_alert`); falls back to `CRAWL_FRESHNESS_WEBHOOK` so one secret serves both. Unset = notification-only, i.e. miss-able |
| `CRAWL_AGENT_WAIT_S` | 120 | Budget for `hc_wait_for_agent` to see the BrandBrain agent's control port before enqueueing. Expiry alerts and **proceeds** — never blocks the schedule |

## Landmines

- **MV refresh has no guard.** `refresh_housing_materialized_views()` (last
  redefined in migration 000092, refreshing `mv_housing_headline`,
  `mv_suburb_price_drops`, `mv_suburb_listing_stats`, `mv_state_price_drops`,
  `mv_agency_stats`, `mv_suburb_crime_latest`) lacks the 000095
  `refresh_all_materialized_views` hardening — known-open, fix in flight.
- **Prod migrations are hand-applied.** The deploy allowlist contains no
  housing files; ship DDL by hand (session pooler 5432, `statement_timeout=0`)
  *before* merging code that reads new columns. See
  [operations.md](operations.md).
- **Committed testdata carries real portal markup** (`testdata/rea-pagemeta.html`,
  `domain-pagemeta.html`, among files flagged by the 2026-08-09 audit) —
  known-open, fix in flight.
- **`CRAWL_TRACE` artifacts hold portal content** — local-only, gitignored,
  never uploaded.
