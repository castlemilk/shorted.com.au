# Housing — tracker, suburb explorer, listings crawl, price-drops

Five products sharing one fact/dimension data model, one chart system and one
Connect-RPC service (`HousingService`, `housing.proto`): the **Widow-Maker
editorial feature** (`/features/the-widow-maker`, baked research arrays), the
**House Prices Tracker** (`/housing`, live ABS/RBA/Valuer-General ingest), the
**suburb explorer** (national → state → suburb choropleth drilldown over ABS
boundaries, Census + electoral + gated crime overlays), the **residential
listings crawl** (REA/Domain via warm host-Chrome CDP on residential Macs,
plus a property.com.au AVM enrichment tier), and the **price-drops board**
(`/price-drops`). **All live on prod.**

Prod, as at 2026-08-09 (24-agent audit measurements): **88,689 crawl listings
across 500 suburbs · 500-suburb crawl catalog · 22 collector modes · 16
official-ingest jobs · 11 `HousingService` RPCs.** VG suburb medians cover VIC
739/3,076 and SA 426/1,764 suburbs; **NSW/QLD/WA sit at zero** (see
known-open). If an older doc disagrees with these numbers — "115 suburbs",
"~12k/22k listings", "7 modes", "Terraform not yet wired" — this line wins;
the monolith drifted (`.claude/housing-program/docs-staleness.md`).

**Added since, as at 2026-08-28:** the expanded Census layer is live —
**8,952** suburbs carry tenure, labour-force, education, dwelling-structure,
household-composition and personal-income shares (it read the wrong DataPack
tables until 2026-08-27, so anything describing these as "reserved" or "NULL"
predates the fix) — and per-suburb terrain is live, **15,307** suburbs with
min/median/max elevation and land-share-below-1m/2m/5m from the GA 1 Second
DEM-S. Both are read straight off `suburb_demographics`; no MV covers them.
See [handover-2026-08-27.md](handover-2026-08-27.md) for how each was verified.

## Read these in this order

| Doc | What it answers |
|---|---|
| **[data-sources.md](data-sources.md)** | Every source, its licence, the mandatory fetch posture (ABS WAF UA, warm Chrome), and which sources are ruled OUT and why |
| **[data-model.md](data-model.md)** | Tables, MVs, the migration map (000053–000092), and the guards enforced in the database rather than by review |
| **[pipeline.md](pipeline.md)** | The collector's 22 modes, what each writes, order dependencies, timeouts and the exit-code contract |
| **[operations.md](operations.md)** | Runbook: prod DDL regime, the residential-rig crawl, revalidation, and the landmines that have actually bitten |
| [architecture.md](architecture.md) | The decision-and-incident record (the old 75KB monolith, moved here; its actively-wrong claims corrected inline, the rest assume residual drift) plus the extension recipes. Read it before touching crawl classification or caching |
| [crawl-roadmap.md](crawl-roadmap.md) | Handover for the next crawl work: measured coverage/throughput/completeness numbers, what blocks per-property reporting and stock-over-time, and the coverage arithmetic for "all suburbs" |

The old `docs/housing-architecture.md` path is now a redirect stub: the file was
moved to [architecture.md](architecture.md), and **these six docs take
precedence over it** on any factual disagreement.

## The rules that shape everything

**1. The licence column decides what may be published.** ABS, RBA and AEC data
is CC-BY-4.0 and publishable with attribution. The crawl tiers (REA, Domain,
property.com.au) write `source_licence = 'proprietary-tos-restricted'` and are
**never republished raw** — migration `000054` excludes that licence from the
public MV at the SQL level, and `000088` repeats the posture for AVM rows:
only *derived aggregates* are a publishable surface. `CRAWL_TRACE` artifacts
(portal screenshots + HTML) are local-only and gitignored, never uploaded.

**2. Crawl-derived prices ship as aggregates with anonymity floors.** The
price-drops rollups (`000086`) cap `drop_pct` at 40% (listing typos), dedup
addresses across portals (a dual-listed cut counts once), and suppress agency
drop depth until an agency has ≥3 dropped addresses. The agency RPC carries a
kill switch (`HOUSING_DROP_LISTINGS_ENABLED`, ON by default). Known-open: the
suburb-level floor is incomplete — see below.

**3. Counts-only crosses to brandbrain; listing rows never do.** The
distributed crawl queue at `api.brandbrain.dev` sees suburb names and
counts-only job summaries (`crawlJobSummary`, `crawl_agent.go`). Listings,
prices and addresses are written only to the shorted DB. No amount of queue
convenience justifies widening that contract.

**4. Never store an unvalidated crawl value, and distrust terminal statuses
first.** Sweeps pass anti-poisoning gates (on-target counts, broadening-aware
poison verdicts, events-written — not raw `seen` — gating terminal status)
before anything persists. When the crawl "looks fine", check what was actually
written: never-attempted jobs have banked "succeeded" before
(`housing-crawl-outage-modes` memory; [operations.md](operations.md)).

**5. Prod DDL is manual and DB-before-code.** The prod deploy applies a
hardcoded migration allowlist that contains **no housing files** — every
housing migration is hand-applied (session pooler 5432,
`statement_timeout=0`) *before* merging code that reads the new columns, or
the read path 500s. Same regime as politicians.

## Surfaces

| Route | What it is |
|---|---|
| `/housing` | Live tracker: BigStat tiles + capital-city medians + national states choropleth. ISR |
| `/housing/[state]` | Suburb choropleth + list with the "Colour by" metric toggle (price, Census, electoral, crime) |
| `/housing/[state]/[suburb]` | Suburb profile: banner, demographics, electoral, crime ranks, listings-derived stats |
| `/housing/property/[addressKey]` | Per-address property history (AVM-fed — posture contested, see known-open) |
| `/housing/calculators` | Housing calculators |
| `/price-drops` | Price-cuts board: state / suburb / address / agency rollups. Static ISR (1h) + KV (24h), busted by the collector's post-crawl revalidate ping. `/housing/drops` 308-redirects here (`permanentRedirect`); `/housing/suburbs` also 308s to `/housing` (a `next.config.mjs` `permanent: true` redirect) |
| `/features/the-widow-maker` | The editorial long-read, baked data, pinned as the `/news` masthead featured card |
| `/admin` (jobs overview) | Operator: collector/crawl job freshness dashboard |

Plus politician cards embedded on `/housing/[state]/[suburb]`, and the
`BankShortBasket` embed shared with the feature at `/embed/bank-basket`.

## Known-open — re-verified 2026-08-28

The 2026-08-09 audit listed eight items. **Six are now fixed.** Each line below
was re-checked against `main` and against prod on 2026-08-28, not inferred from
a branch name or a status line — several of the "in flight" fixes had in fact
landed, and this section had become more wrong than right.

### Still open

- **Per-address AVM estimates + sales history are served publicly** via
  `GetPropertyHistory` / `/housing/property/[addressKey]`, contradicting
  migration `000088`'s own "derived aggregates only" posture. Verified
  2026-08-28: the rpc still carries
  `option (shortedapi.options.v1.visibility) = VISIBILITY_PUBLIC`, it is absent
  from `internalOnlyMethods`, and the web route exists. This is a licence
  decision, not a bug — it needs an owner, not a patch. → *api-hardening*
- **Prod migrations are hand-applied and the CI allowlist has no housing
  files** — rule 5 above is a live operational dependency, not history.
  Verified 2026-08-28: the allowlist in `terraform-deploy.yml` carries
  `000070/71/74/75`, `000081`–`000085`, `000095` and `000112`, and **not one**
  housing migration (`000053`–`000115`). → *collector-lifecycle / operations.md*

### Fixed since the audit

- **NSW VG suburb medians** — the audit recorded NSW 0/4,544 priced. Prod now
  has **2,433** priced NSW suburbs (5,937 observations, latest period
  2025-12-31); it lands from the residential rig via `-mode vg-nsw`. VIC has
  also moved on a year, from the Dec-2024 freeze to 2025-12-31.
  **QLD (0/3,235) and WA (0/1,701) remain at zero — and that is expected, not
  outstanding**: both states sell sales data through brokers, so it is
  commercially blocked rather than unbuilt. The handover's "settled — do not
  reopen" note governs; this section used to imply a *collector-vg* fix track
  was going to deliver them, and it is not. Every QLD open dataset was
  enumerated on 2026-08-29 and none carries a value — see
  [data-sources.md](data-sources.md#qld-and-wa-suburb-prices--what-is-actually-available-checked-2026-08-29)
  before re-opening this.
- **Suburb sitemap 404s** — the slugifier no longer appends `-${postcode}`
  unconditionally (`suburbSlug` in `web/@/lib/housing/states.ts`). `postcode` is
  still 0/15,345 populated, so slugs are name-only, which resolves:
  `/housing/nsw/bondi` returns 200, and there are **zero** within-state slug
  collisions across all 15,345 suburbs.
- **Official pipeline failures exit 0 / no freshness sentinel** —
  `official_freshness.go` now carries per-source policies (`vg_nsw` 550 days,
  `vg_sa` 270) and `assertOfficialVGFreshness` feeds the mode's exit code. Note
  it measures **data** age, not fetch age, and a test asserts the query must not
  use `fetched_at` — deliberate: re-fetching a source that has published nothing
  new changes nothing, so fetch staleness is not a fault.
- **Housing MV refresh lacks the `000095` guard** — `000107_harden_housing_mv_refresh`
  exists AND prod's `refresh_housing_materialized_views()` handles
  `query_canceled`, confirmed by querying `pg_proc` on 2026-08-28. (The root
  `CLAUDE.md` still calls this known-open; that note is stale.)
- **k-anon floor gaps the suburb rollup** — `mv_suburb_price_drops` carries
  `WHERE a.dropped_listing_count >= 3` in prod, and **0** rows are published
  below the floor.
- **Real portal content in committed testdata** — the four `*-pagemeta.html`
  fixtures are now 900 and 657 bytes with **zero** address keys and **zero**
  price strings.

**The seven fix tracks** (dispatched 2026-08-09; branches
`feat/housing-<track>`): *web-suburbs* (sitemap 404 corpus, static suburb
pages), *collector-lifecycle* (honest exit codes, cursor integrity, freshness
sentinel, CI test gating), *collector-vg* (VIC un-pin, NSW off-cloud run,
never-succeeded loudness), *mv-correctness* (refresh hardening, k-anon floor,
dedup axes, sold windows, headline LAG, crime sentinel), *api-hardening* (AVM
gating, takedown completeness, input normalization, cache-key hygiene),
*crawl-correctness* (thin-suburb false blocks, trace panic safety, medians
contract), *repo-hygiene* (purge committed portal content, synthetic
fixtures, CI provenance gate).

Those tracks are **historical**, not a live work queue — as of 2026-08-28 the
work they describe has largely landed (see "Fixed since the audit" above). Read
them as a record of what was dispatched, and check the section above before
picking any of them up.
