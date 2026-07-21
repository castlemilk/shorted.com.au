# Price Drops — focused view, state/suburb rollups, agency tie-in

**Date:** 2026-07-21 · **Branch:** `feat/price-drops-focused-view` · **Status:** approved-by-standing-directive (ultracode autonomous build; user reviews at PR)

## Goal

1. A flagship **`/price-drops`** view: biggest drops by **state** and by **suburb**, analytics
   across **asking** and (caveated) **sold** prices, **agency/agent** attribution, with strong
   visuals — navigable from `/housing`, per-state and per-suburb pages.
2. Roll **all collected listing pricing data** up into state/suburb pricing aggregates.

## Data reality (measured on prod, 2026-07-21)

- 22,155 listings · 5 states (VIC 7.4k, NSW 5.0k, QLD 4.1k, WA 4.0k, SA 1.6k) · 115 metro suburbs.
- 243 `price_drop` events (crawl live since 2026-07-13); avg 6.4%; distribution: 65% < 5%,
  tail ≥ 40% (8 events) are **listing typo corrections** (e.g. $7.5M→$750k = extra-zero fix).
- 6,497 addresses dual-listed on REA **and** Domain → leaderboards must dedup by `address_key`
  (96% of events carry it).
- Agencies: 2,820 distinct names, 10,306 listings with agents (~47%); **sold rows have zero
  agency data** (forward-only capture). Agency IDs are per-portal; agents are name strings.
- **No rents captured** (buy-only crawl; only Census 2021 `median_weekly_rent` exists, static).
- **Sold is incidental** (sold cards leaking into buy SRPs; 1,206 rows) — publish with caveat.

## Decisions

| Decision | Choice | Why |
|---|---|---|
| Route | New top-level `/price-drops`; `/housing/drops` 308-redirects to it | One flagship surface; address board folds in |
| Indexing | `/price-drops` indexable + sitemap; property pages stay noindexed | Page leads with derived aggregates (publishable); per-listing board is client-loaded + flag-gated |
| Render mode | `force-dynamic` (scans pattern PR #310) | Fetches are cheap MV lookups; avoids empty build-shell trap |
| Sanity gate | Exclude `drop_pct > 0.40` from all drop aggregates/boards | Calibrated on prod distribution; ≥40% ≈ typo corrections |
| Dedup | Aggregate MVs dedup by `COALESCE(NULLIF(address_key,''), source‖listing_id)`, keeping the most-severe drop per address | Kills dual-portal double counts |
| Rents | Out of scope (no data). Follow-up: rent crawl channel | "for what we scrape" — we don't scrape rent |
| Sold | Shown with explicit "indicative, incidental capture" caveat | Sparse + last-card-price ≠ settlement price |
| Agency exposure | Leaderboard RPC sits behind the same `HOUSING_DROP_LISTINGS_ENABLED` kill switch as per-listing boards (it carries agency/agent names from restricted rows); drop depth/value suppressed until an agency has ≥3 dropped addresses; per-listing `agency_name`/`agent_names` only on the already flag-gated per-listing RPCs | Adversarial review: named-entity crawl data must be kill-switchable, and n<3 depth figures reverse to a single listing's exact numbers |
| Licence | New MVs are derived aggregates only; per-listing surfaces unchanged (deep-link out) | 000076 header contract |
| Share ratio units | `dropped_share` numerator AND denominator are address-deduped | Review: mixed units understated share up to 2× in cross-listed suburbs |
| Value aggregation | Per address: severest-portal `SUM(drop_abs)` (dedup keeps the portal that saw the most cutting); aggregates sum those | Cross-portal duplicate observations of one real cut must not double-count; multiple real cuts must |
| 'AU' guard | `state_code = 'AU'` junk rows excluded from the state MV | A literal AU row collides with the national GROUPING SETS row and aborts the MV refresh |

## Build

### Migration `000083_price_drops_rollups`
- Recreate `mv_suburb_price_drops`: + sanity cap (`drop_pct <= 0.40`), + address-key dedup
  (severest drop per address), keep 30-day window + n≥3 floor. Same output columns + new
  `dropped_value` (sum of per-address `drop_abs`).
- New `mv_state_price_drops`: per `state_code` + an `AU` national row — dropped_count (deduped,
  capped), avg/median/max drop pct, dropped_value, total_active_listings, dropped_share,
  suburbs_tracked, for_sale_count/priced, avg/median asking, sold_count, avg/median sold.
- New `mv_agency_stats`: per (source, agency_id, agency_name, state_code) — active_listings
  (floor ≥3), priced_listings, avg/median asking, dropped_count 30d (capped), avg_drop_pct,
  total_drop_value, suburbs_covered, agent_names (top ~6 distinct, for display).
- Extend `refresh_housing_materialized_views()` (guarded CONCURRENTLY fallback pattern).
- Down: restore 000076/000077 definitions.

### Proto (`shorts.proto`) + `buf generate`
- `GetPriceDropsOverview` → `{ national: StatePriceDropSummary, states: repeated StatePriceDropSummary }` (ungated).
- `ListAgencyPriceStats(state_code?, sort: drops|listings|avg_cut|value, limit)` → repeated
  `AgencyPriceStats` (ungated, aggregate).
- Add `agency_name` + `repeated string agent_names` to `SuburbDropListing`, `AddressPriceDrop`
  (latest listing's agency), `PropertyListingSnapshot`.

### Backend (`house_prices.go`, `postgres_house_prices.go`)
- Two new store methods over the MVs (sort whitelist, limits, 10s timeouts) + handlers with
  `MemoryCache` (same idiom as existing 4).
- Extend the three per-listing queries to select agency columns.

### Frontend
- `web/src/app/price-drops/page.tsx` (server, force-dynamic, LLMMeta, sitemap): hero + national
  stat strip (SSR) → **state board** (SSR, bar visuals per state, links to `/housing/[state]`)
  → **suburb leaderboard** (SSR via existing unused server action, richer columns: median drop,
  dropped share, median asking vs sold, link to suburb pages) → **biggest individual drops**
  (client AddressDropsBoard, now with agency/agent line + drop-size histogram) → **agency
  leaderboard** (SSR) → methodology/caveats.
- New components in `web/src/@/components/housing/price-drops/`; typography tokens
  (`pageTitle`/`sectionTitle`/`eyebrow`/`lede`), `--semantic-red/green`, mono tabular-nums,
  existing card idiom; charts client-only via `dynamic(ssr:false)`; serializable props only.
- Integrations: `/housing` gets a Price-drops feature card (live stats); `/housing/[state]`
  gets a state drop-summary tile row + link (`/price-drops?state=XX` preselects board filters);
  suburb profile `RecentPriceDrops` shows agency and links to `/price-drops`;
  `HousingBreadcrumb` learns a drops trail; `/housing/drops` → 308 `/price-drops`.

### Review outcomes folded in
Adversarial review (4 dimensions, 22 agents) confirmed and fixed: missing 40% cap on
`ListSuburbDropListings`; mixed-unit `dropped_share`; 'AU' collision aborting refresh;
agency drop-depth identifiability below n=3; agency RPC outside the kill switch;
un-normalized agency cache keys; dead `listAgencyPriceStatsClient`; `LLMMeta`'s
hardcoded ASIC provenance removed from `/price-drops` (page ships its own correct
Dataset JSON-LD). Known accepted quirks: the address board caps the CUMULATIVE window
reduction while MVs cap per-event (documented in-code); `/price-drops` renders its
empty state until 000083 is applied to prod (deploy-order note below); `LLMMeta`'s
false provenance also affects existing housing pages (pre-existing, out of scope).

### Out of scope (follow-ups)
Rent crawl channel; dedicated /sold sweep or VG transfer join; cross-portal agency entity
resolution; per-agent profile pages; time-bucketed aggregate history (MV snapshots lose history).

### Prod rollout (user-gated)
DB-before-code: apply 000083 on Supabase session pooler 5432 (`PGOPTIONS="-c statement_timeout=0"`),
then merge. Collector refresh already calls the shared refresh fn — new MVs refresh on next run.
