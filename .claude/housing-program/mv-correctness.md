# Work package: mv-correctness

Housing SQL correctness: refresh hardening, k-anon floor, dedup axes, sold windows, headline LAG, politician count, crime sentinel

## Ground rules (read first)

- You are in a git WORKTREE of the Shorted repo on your own branch. Commit ALL your work
  with conventional-commit messages (one commit per logical unit is fine). Do NOT push,
  do NOT merge, do NOT switch branches, do NOT touch main.
- Before coding, read the Housing section of the repo CLAUDE.md and skim
  docs/housing-architecture.md for the landmines that apply to your files. Non-negotiable
  repo rules: interactive charts import via dynamic(ssr:false) from "use client" modules;
  never pass functions across the RSC boundary; read searchParams client-side (useSearchParams
  under Suspense) on ISR pages - a server-page searchParams read silently forces dynamic;
  server actions use getShortsApiUrl() from app/actions/config.ts, never env vars directly;
  KV reads go through the readCached non-emptiness predicate.
- Migrations: the prod deploy does NOT run migrate up (hand-apply regime). Do NOT create
  migrations unless your spec explicitly assigns you migration numbers. If a schema change
  seems needed but is not assigned, write it up in your final summary instead.
- Do not modify .proto files or run buf generate. If a proto change seems needed, note it
  in the summary.
- Keep the diff scoped to the findings below. No drive-by refactors, no formatting sweeps.
- QA before you finish: run the narrowest relevant tests (go test ./... scoped to the
  packages you touched; for web: cd web && npx tsc --noEmit plus any touched jest suites)
  and report the actual results honestly in your final summary. If something fails and you
  cannot fix it within scope, say so plainly.
- Finish with a summary: what you changed per finding, what you deliberately did not do,
  test results, and anything the reviewer must hand-verify.

These findings come from a 24-agent adversarial audit (2026-08-09); each was independently
verified against the code. Evidence line references were correct as of audit time - re-locate
if lines shifted.

## Track notes

You own migrations 000107-000110 (use only as many as you need, in order; both
.up and .down for each; follow the style of recent housing migrations like 000086/000092).
F05: port the 000095 guard pattern to refresh_housing_materialized_views. F07: extend the
k-anon floor so tiny samples (n<3) never publish an exact proprietary price at ANY rollup
level. F14/F15: fix the address-dedup axes and give sold aggregates an explicit time window
(and fix the dropped_share denominator mismatch). F16: partition the QoQ/YoY LAG windows by
source. F17: make GetSuburbProfile return the real politician_property_count (store-layer
fix). F33: separate the rank-0 'no data' sentinel from genuinely-safest suburbs (distinct
sentinel or NULL + read-path handling). Update the matching Go store queries/tests in the
same commit as each migration so code and SQL stay coherent. Remember: prod applies
migrations BY HAND - call out the exact apply order + any long-running REFRESH implications
in your summary.

## Findings (verbatim from the audit)

### F05 [high/bug] Housing MV refresh lacks the 000095 hardening that a 19-day prod incident forced onto the shorts refresh — one timeout silently starves every MV after it

**Detail:** The live definition (000092:28-58) refreshes mv_housing_headline UNGUARDED (any failure aborts the whole function, skipping mv_suburb_price_drops, mv_suburb_listing_stats, mv_state_price_drops, mv_agency_stats, mv_suburb_crime_latest), and the five guarded blocks use plain EXCEPTION WHEN OTHERS — which per PL/pgSQL does NOT catch query_canceled (57014), the exact error statement_timeout raises. Migration 000095 documents precisely this failure class ('WHEN query_canceled OR OTHERS', function-scoped SET statement_timeout '0') after 5 shorts MVs silently starved for 19 days — the housing function was never given the same treatment. The collector calls it over the Supabase transaction pooler (port 6543) without setting statement_timeout, under a context where prod refresh 'can take minutes', and a failure is only log.Printf'd with exit 0 (compounding F02). Coverage itself is complete (all 6 housing MVs are in the function) — the gap is purely resilience, and it is the proven mechanism of a prior multi-week silent-staleness incident.

**Evidence:** migrations/000092_crime_read_gating.up.sql:31 (unguarded first REFRESH), :34/:39/:44/:49/:54 (grep 'WHEN OTHERS' = 5, 'query_canceled' = 0); migrations/000095_harden_mv_refresh.up.sql:19-32 (corrected pattern + 19-day incident rationale); services/house-price-collector/store.go:34-43,125-128 (pooler 6543, no statement_timeout); crawl_listings_store.go:284-288.

**Suggested fix (advisory, you may do better):** One migration mirroring 000095: guard mv_housing_headline in its own block, change all guards to WHEN query_canceled OR OTHERS (concurrent → blocking fallback → RAISE WARNING skip), ALTER FUNCTION ... SET statement_timeout TO '0', and have the collector SET statement_timeout = 0 before invoking.

**Verifier note:** Every cited fact holds, and live-prod checks strengthen the finding. (1) Prod's live refresh_housing_materialized_views (pg_get_functiondef via services/.env, read-only) is byte-identical to 000092:28-58: mv_housing_headline refreshed UNGUARDED first, then exactly 5 plain WHEN OTHERS guards, zero query_canceled, proconfig=NONE; no migration through 000101 nor any branch commit (git log --all -S) redefines it. (2) The semantics claim was empirically re-proven ON THE PROD SERVER with a no-write DO block: WHEN OTHERS did NOT catch a statement_timeout cancellation (block aborted with 'canceling statement due to statement timeout'), so one timeout aborts the whole function and starves every MV after it. (3) The hazard is armed: the prod session as the postgres role arrives with statement_timeout=2min, and the repo's own comment (crawl_listings_store.go:285-287) says the housing refresh 'on prod Supabase can take minutes'. (4) Collector has zero defense: no statement_timeout anywhere in house-price-collector (grep=0), store.go:125-128 bare SELECT, main.go:334-337 log.Printf-only + exit 0, which ALSO skips pingRevalidate so stale MVs keep serving from unbusted KV/ISR caches. Severity high (not critical): mechanism proven and armed with a prior 19-day-incident precedent, but no direct evidence housing MVs are wrongly stale today. ADJACENT DISCOVERY for the audit: prod's refresh_all_materialized_views is ALSO a pre-000095 body (unguarded, no query_canceled, cfg=NONE) — 000095 appears never hand-applied to prod, so the shorts-side 'fixed baseline' is repo-only; the suggested-fix migration should be applied by hand to prod (session pooler 5432, statement_timeout=0) alongside re-applying 000095.

### F07 [high/risk] K-anon floors are incomplete: a 1-listing suburb publishes that exact proprietary asking price as its 'average', and mv_agency_stats still publishes agent personal names + dropped_count at n=1-2

**Detail:** The always-public ListSuburbPriceDrops reads mv_suburb_listing_stats, whose SQL (000077) has no HAVING/count floor: any suburb with a single active priced listing publishes avg_asking = median_asking = that one ToS-restricted listing's exact price, with for_sale_count=1 confirming n=1 — violating the project's own standard baked into 000086 ('no published figure can be reversed into a single listing's exact numbers'; the drops MVs got a >=3 floor). Broadening-bleed makes tiny suburbs real: prod had 43 bleed suburbs carrying 142 listings (avg 3.3/suburb) as of 2026-07-22, so n=1/n=2 rows almost certainly exist today; same gap on avg_sold/median_sold at sold_count=1. Adjacent gap in mv_agency_stats: the >=3-dropped-addresses suppression covers only drop depth/value — dropped_count is published unsuppressed at 1-2, and agent_names exposes up to six real people's names per agency row with no floor beyond 3 active listings; named individuals + a 1-2 drop count narrow to identifiable listings in small agencies, gated only by the runtime kill switch.

**Evidence:** migrations/000077_add_suburb_listing_stats.up.sql:5-32 (no floor) vs 000086_price_drops_rollups.up.sql:21-23 (stated reversibility standard), :80 (drops >=3 floor), :205-206 (depth/value CASE WHEN COUNT(*) >= 3), :222-226/:231/:238 (agent_names [1:6], unsuppressed dropped_count, only active>=3 floor); public read at postgres_house_prices.go:694-711.

**Suggested fix (advisory, you may do better):** Rebuild mv_suburb_listing_stats to NULL avg/median asking below for_sale_priced >= 3 and avg/median sold below sold_count >= 3 (keep counts), mirroring the mv_agency_stats CASE pattern; in mv_agency_stats, null dropped_count below 3 alongside depth/value and drop agent_names from the MV (fetch names only in the flag-gated per-listing drill-down, which already reads raw rows). Guarded-refresh wiring already exists.

**Verifier note:** Structural claim verified exactly: 000077's mv_suburb_listing_stats has no count floor (no later migration fixes it; store postgres_house_prices.go:694-711 and the VISIBILITY_PUBLIC, un-gated ListSuburbPriceDrops handler add none), and 000086's mv_agency_stats suppresses only depth/value at <3 — dropped_count is published raw and agent_names[1:6] has no floor beyond active_listings>=3. Agency exposure is LIVE in prod: 880/3,546 MV rows publish dropped_count=1-2, 850 of them with agent personal names, and an unauthenticated curl to ListAgencyPriceStats on api.shorted.com.au returned real agent names (kill switch is ON). One empirical sub-claim is stale, however: prod today has ZERO n=1/n=2 suburb rows (min for_sale_priced=4, min non-zero sold_count=10 across all 500 suburbs; re-running the MV's defining query over property_listings also yields none). The 2026-07-22 "43 bleed suburbs" corpus was cleaned from prod, and #284 (b700a35c7, postcode+suburb target match; partitionByTarget drops off-target rows, stored RegionCode comes from the crawl target) prevents new bleed — so the 1-listing-suburb exact-price publication is a latent gap reachable via listing churn (a 4-priced suburb selling down to 1) or a new suburb's transient sold_count=1, not a currently-manifest one. Severity stays high (not critical): the suburb half publishes nothing reversible today, and the agent-names surface was a deliberate, documented, kill-switched decision — but the finding's suggested fix (floor asking/sold stats at n>=3, null dropped_count<3, move agent_names to the flag-gated drill-down) is sound and closes a real violation of the project's own 000086 reversibility standard.

### F14 [medium/bug] The address-dedup contract is violated on two axes: the suburb drill-down dedups by listing_pk (dual-listed cuts show twice), and 5.8% of listings have empty address_key and are counted once per portal in the MVs

**Detail:** mv_suburb_price_drops was rebuilt in 000086 specifically so 'every aggregate counts each physical address once' via dedup_key = COALESCE(address_key, source:listing_id). But: (a) the flag-gated per-suburb drill-down uses `SELECT DISTINCT ON (e.listing_pk)`, so an address cross-listed on REA and Domain (~6.5k such rows per the migration header) that took a cut on both portals renders as two rows for one physical property, and the drill-down can show more entries than the board's deduped dropped_listing_count (the 0.40 cap IS consistently applied — only the dedup axis diverges); (b) 5,170 of 88,689 listings (2,603 REA + 2,567 Domain) have address_key='' — ListAddressPriceDrops correctly excludes them, but the suburb/state/agency aggregate MVs still count them, so a dual-listed cut on an address-less listing counts once per portal, biasing dropped_count upward in suburbs with poor address extraction.

**Evidence:** postgres_house_prices.go:776 (DISTINCT ON (e.listing_pk)) vs migrations/000086_price_drops_rollups.up.sql:9-14,32,47-50 (~6.5k cross-listed; address-level contract); cap parity at :802; prod: SELECT count(*) FILTER (WHERE address_key IS NULL OR address_key='') FROM property_listings → 5,170/88,689 (5.8%); exclusion only at postgres_house_prices.go:1141.

**Suggested fix (advisory, you may do better):** Dedup the drill-down on the same COALESCE(NULLIF(address_key,''), source||':'||listing_id) key (keep the portal with the largest cut, optionally both deep-links on one row); backfill address_key from lat/lng proximity or listing_url slugs and report the empty-key rate in the crawl run summary so extraction regressions are visible.

**Verifier note:** Both axes verified against current code and prod. (a) postgres_house_prices.go:776 ListSuburbDropListings dedups by DISTINCT ON (e.listing_pk) while migration 000086 dedups every aggregate by COALESCE(NULLIF(address_key,''), source||':'||listing_id) (up.sql:9-14,32,47-50); cap parity at :802 holds; no later commit fixes it. Prod (30-day window, drill-down's own filters): 3,432 drill-down rows collapse to 2,323 addresses — 1,109 duplicate rows (32%), and 1,003 of 1,042 duplicated addresses are cross-portal REA+Domain, the exact claimed mechanism. Concrete suburb divergences vs mv_suburb_price_drops.dropped_listing_count: Ivanhoe VIC 30 vs 4, Berwick 79 vs 54, Point Cook 59 vs 39. Flag is ON by default and the drill-down renders in suburb-profile.tsx, so user-visible. (b) Prod today: 5,172/88,700 (5.8%) listings with empty address_key (REA 2,603 / Domain 2,569) — matches the claim; ListAddressPriceDrops excludes them at :1141 while the MVs count them once per portal via the source:listing_id fallback. One caveat: axis (b) is a *documented* approximation (000086 header explicitly notes the fallback for "~4% of rows"), so it's a drifting known limitation (now 5.8%) rather than an unnoticed contract breach — the genuinely unnoticed defect is axis (a). Severity stays medium: headline aggregates are correctly deduped; cost is a visible drill-down inconsistency (near-high given 32% duplication) plus a modest documented count bias, not wrong headline data or licence exposure.

### F15 [medium/bug] 'Sold' aggregates have no time window (all-time blend labelled 'recent sales') and dropped_share divides a 30-day numerator by the current-active denominator — the ratio can exceed 1

**Detail:** mv_suburb_listing_stats' sold CTE is `WHERE listing_status='sold' AND price IS NOT NULL` with no time bound (comment says 'recent sales'); mv_state_price_drops repeats the unbounded FILTERs — while the drop-side numerators are strictly 30-day windowed. As the corpus ages, the board's sold medians/counts become an all-time blend across market conditions sitting next to 30-day drop stats (sold_count grows monotonically forever). Separately, dropped_share divides a 30-day windowed, event-derived address count (retaining addresses that have since sold/delisted) by the CURRENT active-listing count (`WHERE is_active`, no window): in fast-turnover suburbs the share drifts upward and is not bounded by 1, yet renders as 'X% of listings cut'. (Prod currently shows 0 rows with share>1 — a latent, not live, overflow; the epoch mismatch is live.)

**Evidence:** migrations/000077_add_suburb_listing_stats.up.sql:16-23 ('recent sales' comment, no time predicate); 000086_price_drops_rollups.up.sql:135-140 vs :36/:97/:192 (30-day windows on drops only); :36-38+61-80 and :97-100+121-153 (windowed numerator / unwindowed is_active denominator, dropped_listing_count/total_active_listings); data-finder prod check 2026-08-09: 0 rows dropped_share>1 today.

**Suggested fix (advisory, you may do better):** Rebuild with a rolling sold window (6-12 months keyed off the sold-status transition timestamp) and rename/annotate the columns; for the share, either restrict the numerator to still-active addresses or denominate by addresses active within the same 30-day window; document the chosen semantics on the MV.

**Verifier note:** All cited evidence holds exactly. (1) 000077:16-23 sold CTE has no time bound under a "recent sales" comment; 000086 repeats unbounded sold FILTERs (:135-140) while drop numerators are 30-day windowed (:36/:97/:192); dropped_share (:77/:153) divides a 30-day event-derived address count by the current unwindowed is_active count with no clamp. (2) Not fixed: 000090/000092 only re-wire the refresh function, no later migration/commit rebuilds these MVs, and prod pg_matviews definitions match the repo SQL verbatim (mv_suburb_listing_stats has zero interval predicates). (3) Frontend renders it as claimed: state-drops-board.tsx:29 "Share of listings cut (30d)" + unclamped percent; suburb-price-drops-panel.tsx:62 labels the unbounded sold aggregates "recent sold prices". (4) Prod read-only check 2026-08-09 reproduces the finding's own qualifier: 0 rows dropped_share>1 (max 0.267) — latent, not live; mechanism verified (41 of 3,476 30-day drop addresses already inactive, retained in numerator only). (5) Sold corpus is 5,716 rows spanning 2026-07-13→2026-08-09 with no pruning code in the collector, so sold_count grows monotonically — one nuance: the corpus is only ~4 weeks old, so the all-time sold blend is today still effectively "recent"; the mismatch is live in the SQL but its displayed-data distortion accrues from here. Severity stays medium: no wrong prod data or licence exposure today, but structural debt with a concrete accruing cost on a public board.

### F16 [medium/risk] mv_housing_headline QoQ/YoY LAG windows do not partition by source — a second quarterly public source for any existing region×measure×dwelling silently corrupts deltas

**Detail:** The base table's unique key includes source, but the MV's LAG window is PARTITION BY region_code, measure, dwelling_type ORDER BY period with no source term. Today each quarterly public source owns disjoint keys (abs_res_dwell_st→national/state, abs_res_dwell→GCCSA, sa_metro→SA suburbs; crawl rows excluded by the licence gate; annual VG rows by period_freq) so no collision exists yet — but the schema explicitly anticipates more sources ('vic_vpsr | sa_metro | nsw_psi | domain_api'). The moment two Q-frequency public sources cover the same key, rows interleave in one window: LAG(1) can land on the SAME period from the other source (QoQ becomes a source-vs-source delta), LAG(4) stops meaning one year, and the rn=1 tie-break is arbitrary. LAG(4)=YoY also silently mis-computes across any gap quarter within a single source.

**Evidence:** migrations/000054_housing_licence_gate.up.sql:16-29 (window sans source; LAG(1)/LAG(4)); 000053_add_house_prices.up.sql:28-34 (multi-source design + per-source unique key).

**Suggested fix (advisory, you may do better):** Rebuild the MV to pick one preferred source per (region, measure, dwelling, period) via ranked DISTINCT ON before windowing, or add source to the window partition + MV key and let the read path choose.

### F17 [medium/bug] GetSuburbProfile always returns politician_property_count=0 while ListStateSuburbs returns the real count — a public documented field is wrong on 1 of the 2 RPCs carrying it

**Detail:** SuburbSummary.politician_property_count (field 31) is populated only by ListStateSuburbs. GetSuburbProfile's store query has no join to mv_register_suburb_property and the handler's summary construction never sets PoliticianPropertyCount, so any API consumer reading profile.summary.politician_property_count gets a hard 0 even for the ~335 suburbs with declared register properties. The site dodges it (suburb pages use the separate ListSuburbPoliticians RPC), so the wrong value is API-surface-only today — but it is a documented VISIBILITY_PUBLIC field returning wrong data.

**Evidence:** house_prices.go:204-228 (no PoliticianPropertyCount in the summary literal) vs :135; postgres_house_prices.go:362-435 (no mv_register_suburb_property join) vs :310-312 + scan :352; housing.proto:206.

**Suggested fix (advisory, you may do better):** Add the mv_register_suburb_property LEFT JOIN + scan to GetSuburbProfile's query and copy the field in the handler (mirroring the crime-rank copy at house_prices.go:275-282).

### F33 [low/bug] Crime rank 0 'no data' sentinel collides with genuinely safest suburbs after 1-decimal rounding, and the editorial-standards doc has no crime section despite governing the surface

**Detail:** (a) The population-weighted percentile guarantees pct_rank > 0 for every covered suburb — which is what makes 0 usable as the no-data sentinel (highlight-metrics maps 0 → no-data hatch). But ListStateSuburbs rounds to 1 decimal, so any covered suburb with true rank < 0.05 (each state's safest gated suburb is always in this zone) rounds to 0.0 and renders 'no data' instead of 'safest' on the choropleth crime metrics; the profile CrimeCard path is unaffected. (b) The suburb crime surface labels named suburbs on a yellow→red 'danger ramp' — reputationally sensitive publication of exactly the character docs/influence-editorial-standards.md exists to govern, yet it contains zero crime coverage (it scopes itself to Track A). The implemented gating is strong (small_pop + unreliable baked into the MV, WA ToU rows excluded, BOCSAR attribution inline) but exists only as code+migration comments — a future contributor adding VIC/QLD crime or a 'most dangerous suburbs' page has no written rule against ungated small-pop publication or league-table framing.

**Evidence:** crime_compute.go:16 (min rank > 0); postgres_house_prices.go:302-304 (ROUND(...,1) + COALESCE 0); highlight-metrics.ts:41,289 (0 → null); grep -rn crime docs/influence-editorial-standards.md = 0; gating at 000092:9-19 + postgres_house_prices.go:259-271,471-476; attribution at suburb-profile.tsx:380-381.

**Suggested fix (advisory, you may do better):** Use -1 as the no-data sentinel (or per-type has_data booleans on SuburbSummary), or floor covered rows at 0.1 (GREATEST(ROUND(...,1), 0.1)); add a short 'sensitive area statistics' section to the standards doc codifying mandatory suppression on every read path, CVS-adjusted attributed rates, and no superlative framing on named suburbs.

