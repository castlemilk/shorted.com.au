You must fix defects found by an adversarial review of YOUR OWN previous change on this branch. The review ran three independent lenses plus a refutation pass; every finding below was CONFIRMED against the actual code (several were reproduced on a real PostgreSQL container). Do not re-litigate them - two of the blockers were found independently by three separate reviewers.

Ground rules:
- You are in the same git worktree, on the same branch, with your previous work already COMMITTED. Add fix commits on top; do not rewrite history, do not push, do not merge, do not switch branches.
- Fix the root cause, not the symptom. Where a finding says a TEST asserts the buggy behaviour, fix the test to assert the correct BEHAVIOUR (not a SQL string literal) - a test that pins a defect is worse than no test.
- After fixing, re-run the scoped tests and report ACTUAL output. If you cannot run something in the sandbox, say so plainly rather than claiming it passed.
- If you believe a finding is genuinely wrong, say so explicitly with evidence in your summary rather than silently ignoring it.

## Confirmed findings on feat/housing-mv-correctness (14 distinct)

### 1. [BLOCKER] F33 crime-rank floor inverts its own contract: GREATEST ignores NULL, so "no data" now returns 0.1 instead of 0
**Where:** services/shorts/internal/store/shorts/postgres_house_prices.go:302-304

**What's wrong:** `COALESCE(GREATEST(ROUND(cr.break_ins_rank::numeric, 1), 0.1), 0)` puts GREATEST *inside* the COALESCE. Postgres GREATEST/LEAST ignore NULL operands and only return NULL when every argument is NULL, so `GREATEST(NULL, 0.1)` = 0.1 and the outer COALESCE never fires. Verified on PG 17.6:

    SELECT COALESCE(GREATEST(ROUND(NULL::numeric,1), 0.1), 0);  -- 0.1

and end-to-end against a LEFT JOIN with no matching crime row:

    sal_code                 | new_behaviour | old_behaviour
    NSW-COVERED              |           0.1 |           0.0
    VIC-SUBURB-NO-CRIME-DATA |           0.1 |             0

So the change does the exact opposite of its stated goal: it makes 0 *unreachable* and collapses "covered, lowest rank" and "no data" onto the same value. The `listStateSuburbsCrimeJoin` (line 259-271) is a LEFT JOIN whose inner query re-asserts `NOT small_pop AND NOT unreliable`, so every suburb outside the loaded jurisdictions AND every deliberately quarantined small-population/unreliable suburb yields NULL ranks here. The added test `TestListStateSuburbsQuery_SeparatesCoveredLowRanksFromNoData` (postgres_house_prices_query_test.go:44) asserts the buggy string literally and so locks the defect in.

**How it fails in production:** Crime data is Phase-1 NSW only. Open /housing/VIC and pick "Colour by → Break-ins". Every one of the ~3,000 VIC suburbs has no row in mv_suburb_crime_latest, so cr.break_ins_rank is NULL, so ListStateSuburbs returns crimeBreakInsRank = 0.1. web/src/@/lib/housing/highlight-metrics.ts:289 (`s.crimeBreakInsRank > 0 ? s.crimeBreakInsRank : null`) therefore treats them as covered and the choropleth paints the entire state at the safe end of the yellow→red danger ramp instead of the no-data hatch — a fabricated crime percentile published for suburbs with zero crime data, including the small_pop/unreliable rows the 000092 gate exists to withhold.

**Suggested fix:** Move the floor inside the null-check, e.g. `CASE WHEN cr.break_ins_rank IS NULL THEN 0 ELSE GREATEST(ROUND(cr.break_ins_rank::numeric, 1), 0.1) END` (or `COALESCE(GREATEST(ROUND(...), 0.1) * (cr.break_ins_rank IS NOT NULL)::int, 0)`), and change the test to assert 0-for-NULL rather than the literal expression.

**Verifier's confirmation:** CONFIRMED, blocker. Verified in /Users/benebsworth/projects/.worktrees/shorted-hw-mv-correctness/services/shorts/internal/store/shorts/postgres_house_prices.go:302-304 (added by 8652951b5 vs 8c120a352).

SQL semantics reproduced on a throwaway PostgreSQL 17.10 container (removed after): SELECT COALESCE(GREATEST(ROUND(NULL::numeric,1), 0.1), 0) => 0.1; GREATEST(NULL::numeric, 0.1) => 0.1. GREATEST ignores NULL operands, so the outer COALESCE is dead code and 0 is unreachable.

End-to-end reproduction against a mock of listStateSuburbsCrimeJoin (same MAX(...) FILTER subquery + "WHERE NOT small_pop AND NOT unreliable" + LEFT JOIN):
  NSW-LOWEST (pct_rank 0.006) -> new 0.1 / old 0.0
  NSW-SMALLPOP (gated out)    -> new 0.1 / old 0
  VIC-NODATA (no row)         -> new 0.1 / old 0
All three collapse to 0.1; covered-lowest and no-data are no longer separable, which is the exact opposite of the new test's name.

Reachable, and no guard exists anywhere in the diff or downstream:
- services/migrations/000090_add_suburb_crime.up.sql:23 states the contract verbatim: "No-data jurisdictions (TAS/NT, and WA under its non-commercial ToU) are simply absent -> they hatch on the map, never paint 0."


---

### 2. [BLOCKER] NULLing mv_agency_stats.dropped_count below k=3 inverts the agency board's default ranking (ORDER BY … DESC is NULLS FIRST)
**Where:** services/migrations/000109_fix_listing_rollup_correctness.up.sql:277

**What's wrong:** `CASE WHEN COUNT(*) >= 3 THEN COUNT(*) END AS dropped_count` replaces 000086's `COUNT(*) AS dropped_count` + `COALESCE(da.dropped_count, 0)` in the final SELECT (line 298 also drops the COALESCE). The MV column is now NULL both for agencies with 1–2 dropped addresses and — via the LEFT JOIN at line 300 — for every agency with no drops at all.

ListAgencyPriceStats (postgres_house_prices.go:1316) sorts with `dropped_count DESC, total_drop_value DESC, active_listings DESC`. Those unqualified names resolve to the MV's *input* columns (the output columns are named `coalesce`), and Postgres defaults DESC to NULLS FIRST. The `sort=value` branch (line 1323, `total_drop_value DESC`) has the identical problem; only `sort=avg_cut` (line 1321) spells NULLS LAST.

Reproduced against the real migrations on PG 17.6 with two seeded agencies (5 active addresses each; one with 5 dropped addresses, one with none), running the exact store query:

    agency_id | agency_name     | dropped_count | total_drop_value
    AG-QUIET  | Quiet Realty    |             0 |                0   <-- rank 1
    AG-BIG    | Big Cuts Realty |             5 |           250000   <-- rank 2

Rolling 000109 back and re-running the same query restores the correct order (Big Cuts first), confirming it is a regression, not pre-existing.

Note also that suppressing a *count* is outside F07's stated scope ("suppress proprietary asking/sold/drop prices below three addresses") — 000086 already suppressed only depth (avg_drop_pct) and value.

**How it fails in production:** /price-drops calls listAgencyPriceStats("", "drops", 12) (web/src/app/price-drops/page.tsx:76). Since almost every agency has fewer than 3 dropped addresses in a 30-day window, the ORDER BY puts hundreds of NULL-dropped_count agencies ahead of the real cutters and LIMIT 12 truncates before reaching any of them. The section headed "agencies ranked by asking-price cuts" (agency-drops-board.tsx:40) renders twelve rows each reading "0 cuts", and the agency actually cutting the most prices never appears.

**Suggested fix:** Keep `COUNT(*) AS dropped_count` unsuppressed (or restore `COALESCE(da.dropped_count, 0)` in the final SELECT) and suppress only avg_drop_pct/total_drop_value as 000086 did; if the count must stay NULLable, add explicit `NULLS LAST` to every DESC key in the store's orderBy whitelist.

**Verifier's confirmation:** Reproduced end-to-end on PG 17.6; every refutation avenue failed.

CODE FACTS VERIFIED
- 000109_fix_listing_rollup_correctness.up.sql:277 is verbatim `CASE WHEN COUNT(*) >= 3 THEN COUNT(*) END AS dropped_count`; the final SELECT (~line 298) emits bare `da.dropped_count` / `da.total_drop_value` over `LEFT JOIN da USING (source, agency_id, state_code)`. So both are NULL for 1-2-drop agencies AND for every zero-drop agency. 000086 emitted `COALESCE(da.dropped_count,0)` / `COALESCE(da.total_drop_value,0)` (NOT NULL).
- postgres_house_prices.go:1316 default orderBy = `dropped_count DESC, total_drop_value DESC, active_listings DESC`. The SELECT list wraps both in COALESCE WITHOUT aliases, so the output column names are literally `coalesce`; the ORDER BY simple names bind to the MV input columns (nullable) and DESC defaults to NULLS FIRST. Only the `avg_cut` branch (line 1321) spells NULLS LAST; `value` (line 1323) has the identical defect.

REPRODUCTION (throwaway local DB `mvverify`, since dropped; no repo files touched — `git status` clean)
Minimal property_listings/property_price_events fixture + VERBATIM 000109 agency-MV DDL + VERBATIM store query:
  AG-QUIET (0 drops)  -> rank 1, re

---

### 3. [BLOCKER] F33 crime floor is inverted: GREATEST ignores NULL, so "no crime data" now publishes as rank 0.1 (safest) instead of the no-data hatch
**Where:** services/shorts/internal/store/shorts/postgres_house_prices.go:302-304

**What's wrong:** `COALESCE(GREATEST(ROUND(cr.break_ins_rank::numeric, 1), 0.1), 0)` relies on GREATEST propagating NULL. PostgreSQL does the opposite: GREATEST/LEAST ignore NULLs and return NULL only if every argument is NULL, so `GREATEST(NULL, 0.1)` = 0.1 and the outer COALESCE(...,0) is dead code. The `cr` subquery (lines 260-271) is a LEFT JOIN over the gated `mv_suburb_crime_latest` (`WHERE NOT small_pop AND NOT unreliable`), so `break_ins_rank`/`violent_rank`/`motor_vehicle_rank` are NULL for (a) every suburb in a state with no crime ingest and (b) every NSW suburb deliberately quarantined by the small_pop/unreliable k-anon+reliability gate. Verified on postgres:16 with the real join shape: a suburb with no crime row returns `new_expr = 0.1` where the pre-change expression returned `0`. The frontend contract is `s.crimeBreakInsRank > 0 ? value : null` (web/src/@/lib/housing/highlight-metrics.ts:289,295,301), where null is the only way a suburb renders as no-data. So this change flips withheld/absent suburbs from "no data" to "covered, lowest crime in the country" on the choropleth and tooltip. The unit test added alongside it (postgres_house_prices_query_test.go:41-49) only asserts the literal SQL string, so it passes.

**How it fails in production:** Open /housing/VIC (or any state with no crime ingest) and pick Colour by → Break-ins. Every VIC suburb has no row in mv_suburb_crime_latest, so cr.break_ins_rank IS NULL → COALESCE(GREATEST(NULL,0.1),0) = 0.1 → highlight-metrics returns 0.1 instead of null → the whole state is painted at the safe end of the danger ramp and tooltips read "0th pctile" instead of showing the no-data hatch. Same for NSW suburbs excluded by the small_pop/unreliable gate: suppressed suburbs are now affirmatively labelled as the lowest-crime suburbs in Australia.

**Suggested fix:** Floor only the covered case, e.g. `CASE WHEN cr.break_ins_rank IS NULL THEN 0 ELSE GREATEST(ROUND(cr.break_ins_rank::numeric,1), 0.1) END`, and add a test that exercises the expression against a no-data row rather than string-matching the SQL.

**Verifier's confirmation:** Reproduced on postgres:16.14 with the real join shape: with the gated `mv_suburb_crime_latest` LEFT JOIN (postgres_house_prices.go:260-271), a suburb with no crime row yields `COALESCE(GREATEST(ROUND(NULL::numeric,1),0.1),0) = 0.1` where the pre-change `COALESCE(ROUND(NULL,1),0)` yielded 0. GREATEST ignores NULLs (returns NULL only if every argument is NULL), so the outer COALESCE(...,0) is dead code. Verified `GREATEST(NULL::numeric, 0.1) = 0.1`.

Reachability confirmed, and no guard exists elsewhere in the diff (git diff --name-only shows no web/ files):
- 000092_crime_read_gating.up.sql bakes `NOT small_pop AND NOT unreliable AND source_licence <> 'wa-tou-noncommercial'` into the MV, so quarantined NSW suburbs have NO row -> NULL after the LEFT JOIN.
- services/house-price-collector/crime.go:63 ingests NSW only (`fetchNSW(ctx, registry["NSW"])`), so 100% of suburbs in the other 7 states/territories are NULL.
- Frontend contract unchanged: web/src/@/lib/housing/highlight-metrics.ts:289,296,303 = `rank > 0 ? rank : null`; choropleth-map.tsx:17 maps null -> `url(#nodata-hatch)`. state-suburb-map.tsx:150 renders ALL HIGHLIGHT_METRICS with no availability gating, so "Colour by -> Bre

---

### 4. [BLOCKER] Agency board ranking inverted: mv_agency_stats.dropped_count/total_drop_value are now NULL below k=3 and the ORDER BY is `DESC` (NULLS FIRST)
**Where:** services/shorts/internal/store/shorts/postgres_house_prices.go:1316

**What's wrong:** 000109 changed `da` to emit `CASE WHEN COUNT(*) >= 3 THEN COUNT(*) END AS dropped_count` and the equivalent for `total_drop_value` (000109_fix_listing_rollup_correctness.up.sql:277-279, 298-300), and the outer SELECT no longer COALESCEs them (the pre-change MV had `COALESCE(da.dropped_count, 0)` / `COALESCE(da.total_drop_value, 0)`, see the .down.sql:206-208). So every agency with 0, 1 or 2 dropped addresses — i.e. almost all of them — now has NULL in those columns. ListAgencyPriceStats orders on the raw MV columns: default `dropped_count DESC, total_drop_value DESC, active_listings DESC` (line 1316) and `sort=value` → `total_drop_value DESC, dropped_count DESC` (line 1323). PostgreSQL's default for DESC is NULLS FIRST, so the suppressed agencies sort to the top. Note line 1321 already uses `avg_drop_pct DESC NULLS LAST` for the one column that was previously nullable — the two newly-nullable columns were not updated. Verified end-to-end on postgres:16 with the real MV: 'Small Agency' (1 dropped address, suppressed→NULL) ranked above 'Big Discounters' (5 cuts, $500k).

**How it fails in production:** /price-drops calls listAgencyPriceStats("", "drops", 12) (web/src/app/price-drops/page.tsx:77). With the new MV, the 12 rows returned are the 12 agencies with fewer than 3 dropped addresses; the store COALESCEs their NULLs to 0 on read, so AgencyDropsBoard renders a ranked list whose #1..#12 all read "0 cuts" (agency-drops-board.tsx:41), and the agencies that actually cut the most prices never appear on the board at all.

**Suggested fix:** Either restore COALESCE(...,0) in the MV's outer SELECT (keeping the depth suppression on avg_drop_pct/total_drop_value only), or add `NULLS LAST` to every DESC term in the ListAgencyPriceStats orderBy whitelist.

**Verifier's confirmation:** CONFIRMED — reproduced end-to-end; the reviewer did not misread anything, and no guard exists elsewhere in the diff.

Code facts (all in /Users/benebsworth/projects/.worktrees/shorted-hw-mv-correctness):

1. `services/migrations/000109_fix_listing_rollup_correctness.up.sql` `da` CTE emits `CASE WHEN COUNT(*) >= 3 THEN COUNT(*) END AS dropped_count` and `CASE WHEN COUNT(*) >= 3 THEN SUM(total_abs) END AS total_drop_value`, and the outer SELECT projects them bare (`da.dropped_count, da.avg_drop_pct, da.total_drop_value`) over a `LEFT JOIN da`. So agencies with 0, 1 or 2 dropped addresses get NULL in both columns. The MV's only filter is `WHERE ag.active_listings >= 3`.

2. This IS a regression, not pre-existing. The actual prior definition — `000086_price_drops_rollups.up.sql:231,233` (faithfully mirrored by 000109's own .down.sql:206,208) — used raw `COUNT(*) AS dropped_count` plus `COALESCE(da.dropped_count, 0)` / `COALESCE(da.total_drop_value, 0)`, i.e. both were NOT NULL. Only `avg_drop_pct` was nullable, which is exactly why `postgres_house_prices.go:1321` alone carries `NULLS LAST`. The sibling MV in the same migration (`mv_state_price_drops`) keeps `COALESCE(d.dropped_count, 0

---

### 5. [BLOCKER] F33 crime floor inverted: GREATEST ignores NULL, so "no data" now reports 0.1 instead of 0
**Where:** services/shorts/internal/store/shorts/postgres_house_prices.go:302-304

**What's wrong:** The new expression is `COALESCE(GREATEST(ROUND(cr.break_ins_rank::numeric, 1), 0.1), 0)` (same for violent/motor_vehicle). In PostgreSQL GREATEST/LEAST *ignore* NULL arguments and only return NULL when every argument is NULL, so `GREATEST(NULL, 0.1)` = 0.1 and the outer COALESCE(...,0) is dead code. `cr` is a LEFT JOIN over mv_suburb_crime_latest (line 259 `listStateSuburbsCrimeJoin`), so `cr.break_ins_rank` is NULL for every suburb with no crime row or one filtered by `NOT small_pop AND NOT unreliable`. I confirmed the semantics on postgres:16: `SELECT COALESCE(GREATEST(ROUND(NULL::numeric,1), 0.1), 0)` -> `0.1` (and `0.04` -> `0.1`, `0.72` -> `0.7`). The intended contract is documented in web/src/@/lib/housing/highlight-metrics.ts:41 ("0 = no data; > 0 always when covered") and enforced at lines 289/296/303 as `s.crimeBreakInsRank > 0 ? s.crimeBreakInsRank : null`, which drives the no-data hatch. Correct form: `CASE WHEN cr.break_ins_rank IS NULL THEN 0 ELSE GREATEST(ROUND(cr.break_ins_rank::numeric,1), 0.1) END`. Note the accompanying test (postgres_house_prices_query_test.go:44-52) only string-matches the buggy literal, so it locks the defect in rather than exercising it.

**How it fails in production:** Open /housing/VIC (or any state outside the NSW-only crime coverage) and pick Colour by -> Break-ins. ListStateSuburbs returns crimeBreakInsRank = 0.1 for all ~3,000 VIC suburbs instead of 0, `value()` returns 0.1 (not null), and the whole state is painted with the lowest-danger colour of the yellow->red ramp with a tooltip reading a fabricated "0.1 percentile". The no-data hatch becomes unreachable, and NSW suburbs deliberately withheld by the small_pop/unreliable gate are likewise shown as "safest" rather than withheld.

**Suggested fix:** Replace GREATEST with an explicit NULL test per rank column: `CASE WHEN cr.<rank> IS NULL THEN 0 ELSE GREATEST(ROUND(cr.<rank>::numeric, 1), 0.1) END`, and change the query test to assert the NULL branch (or add an integration case seeding an empty mv_suburb_crime_latest and asserting rank == 0).

**Verifier's confirmation:** CONFIRMED, blocker retained. Could not refute on any axis.

CODE: /Users/benebsworth/projects/.worktrees/shorted-hw-mv-correctness/services/shorts/internal/store/shorts/postgres_house_prices.go:302-304 is exactly as cited, and `git diff 8c120a352` shows THIS commit (8652951b5) introduced the regression: `COALESCE(ROUND(cr.break_ins_rank::numeric, 1), 0)` -> `COALESCE(GREATEST(ROUND(cr.break_ins_rank::numeric, 1), 0.1), 0)` for all three ranks. The pre-change form was correct.

SEMANTICS RE-VERIFIED independently on postgres:16.14 using the real join shape (listStateSuburbsCrimeJoin, line 259, LEFT JOIN over the gated mv_suburb_crime_latest):
  NSW1 (covered 87.4) -> shipped 87.4 / proposed 87.4
  NSW_SMALL (small_pop-gated) -> shipped 0.1 / proposed 0
  VIC1 (no crime row) -> shipped 0.1 / proposed 0
PG GREATEST ignores NULL args (NULL only when all args NULL), so the outer COALESCE(...,0) is dead code, exactly as claimed.

REACHABILITY - no guard exists anywhere in the diff or downstream:
- store scans raw into SuburbSummaryRow.CrimeBreakInsRank (line 351); service passes verbatim to proto (services/shorts/internal/services/shorts/house_prices.go:133). No remap. (GetSuburbProfile 

---

### 6. [MAJOR] 12-month sold window keys off first_seen/status_change only, silently dropping every sale recorded as a `relisted` event
**Where:** services/migrations/000109_fix_listing_rollup_correctness.up.sql:34-40

**What's wrong:** `sold_transitions` (lines 34-40, duplicated for the state MV at 191-197) requires `e.event_type IN ('first_seen', 'status_change') AND e.listing_status = 'sold'`. But crawl_listings_diff.go:252-268 explicitly *suppresses* status_change when the listing was inactive:

    if !prev.IsActive { ... e.EventType = "relisted"; relisted = true }
    // status_change (suppressed when relisted already conveys the transition).
    if !relisted && l.Status != "" && prev.Status != l.Status { ... }

Delisting sets `is_active = false, listing_status = 'withdrawn'` (crawl_listings_store.go:260), so any listing that drops off the /buy/ or /sale/ SRP long enough to be delisted and later reappears tagged Sold produces a `relisted` event carrying listing_status='sold' — and only that event. property_listings.listing_status is 'sold', but no first_seen/status_change 'sold' event exists, so the address is invisible to the new CTE. The previous definition (000077) read `property_listings.listing_status = 'sold'` directly and captured it.

Reproduced on PG 17.6 with 3 sold listings whose only sold-marking event is `relisted`:

    OLD | SUBURB:NSW-2026-BONDI | sold_count=3 | avg_sold=1500002
    NEW | SUBURB:NSW-2026-BONDI | sold_count=0 | avg_sold=NULL
    STATE-NEW | NSW | sold_count=0 | avg_sold=NULL

**How it fails in production:** A Domain listing in Bondi is delisted after the grace period (status→'withdrawn', is_active=false), then reappears on the /sale/ SRP tagged Sold a fortnight later. eventsFor() emits `relisted` with listing_status='sold' and no status_change. mv_suburb_listing_stats.sold_count and mv_state_price_drops.sold_count both omit it, so the /price-drops suburb leaderboard and state board render "—" for median sold price on suburbs that did have qualifying sales (memory records ~2,574 Domain delistings, i.e. a real population of relist paths).

**Suggested fix:** Either add 'relisted' to the event_type IN list, or derive sold_at from `MAX(observed_at) FILTER (WHERE listing_status = 'sold')` over all event types for the listing.

**Verifier's confirmation:** Verified against the worktree and reproduced on an ephemeral PG 17.6 cluster (torn down afterwards; nothing modified).

SQL as cited: services/migrations/000109_fix_listing_rollup_correctness.up.sql:34-40 (suburb MV) and :191-197 (state MV) both gate sold_transitions on `e.event_type IN ('first_seen','status_change') AND e.listing_status='sold'`. `relisted` is a declared event type (000076_add_property_listings.up.sql:61) and cannot match.

Pipeline really emits relisted-only sold markers: crawl_listings_diff.go:252-270 emits `relisted` whenever `!prev.IsActive`, carrying `base.Status` (the current card's status), and status_change is guarded by `if !relisted && ...` so the two are mutually exclusive. insertPriceEvent (crawl_listings_store.go ~220) persists that Status into listing_status. markAbsent (crawl_listings_store.go:259-262) sets is_active=false, listing_status='withdrawn' after delistGrace (default 2, crawl_listings.go:111). A later sweep seeing the same (source,listing_id) tagged Sold (crawl_listings_extract.go:357-362, Domain UPVSoldListings tags) upserts listing_status='sold' while writing only a `relisted` event. The existing unit test crawl_listings_test.go:346-350 a

---

### 7. [MAJOR] Dropping mv_agency_stats.agent_names breaks the currently-deployed API under the repo's documented DDL-before-merge rollout order
**Where:** services/migrations/000109_fix_listing_rollup_correctness.up.sql:293

**What's wrong:** The rebuilt mv_agency_stats final SELECT (lines 293-303) no longer emits `agent_names`, and `dropped_count` is now NULLable. The store was updated in the same commit to select `'{}'::text[] AS agent_names` and `COALESCE(dropped_count, 0)` — which is forward- and backward-compatible — but the *deployed* build still runs the base-commit query (postgres_house_prices.go:1325-1326 at 8c120a352):

    suburbs_covered, dropped_count, COALESCE(avg_drop_pct, 0),
    COALESCE(total_drop_value, 0), COALESCE(agent_names, '{}')

Verified against the rebuilt MV on PG 17.6:

    ERROR:  column "agent_names" does not exist
    HINT:  Perhaps you meant to reference the column "mv_agency_stats.agency_name".

and independently, `dropped_count` NULL fails the old non-pointer int32 scan. CLAUDE.md mandates applying migrations by hand BEFORE merging ("the prod deploy does NOT run migrate up"), which guarantees this window. Note the same file already establishes the compat idiom for exactly this hazard — `COALESCE((to_jsonb(d) ->> 'dropped_value')::float8, 0)` at postgres_house_prices.go:707 exists so a code deploy ahead of DDL can't break the suburb board.

**How it fails in production:** Operator applies 000109 to prod Supabase on the session pooler (the documented pre-merge step), then merges. Until the Cloud Run revision with the new store code is live, every ListAgencyPriceStats call fails with `column "agent_names" does not exist`; getHousing.ts's withRetryAndNotFound swallows it to undefined and /price-drops renders with the entire "Agencies" section missing (and the KV entry is skipped, so it re-fails on every regeneration).

**Suggested fix:** Keep an `'{}'::text[] AS agent_names` placeholder column in the rebuilt MV (or land the code deploy first and apply the DDL after), and keep dropped_count non-NULL.

**Verifier's confirmation:** Every claim verified; no guard exists anywhere in the diff.

SCHEMA: 000109_fix_listing_rollup_correctness.up.sql:244 does `DROP MATERIALIZED VIEW IF EXISTS mv_agency_stats` and the rebuilt final SELECT (293-303) emits no `agent_names`; the prior definition (000086_price_drops_rollups.up.sql:234) did emit `COALESCE(agents.agent_names,'{}') AS agent_names` and emitted `COALESCE(da.dropped_count,0)` (non-NULL). The new `da` CTE is `CASE WHEN COUNT(*)>=3 THEN COUNT(*) END` + LEFT JOIN, so `dropped_count` is now NULLable. Removal is intentional and test-enforced (mv_correctness.test.mjs:87).

DEPLOYED CODE BREAKS: at 8c120a352 the store selects `suburbs_covered, dropped_count, COALESCE(avg_drop_pct,0), COALESCE(total_drop_value,0), COALESCE(agent_names,'{}')` FROM mv_agency_stats and scans dropped_count into a non-pointer int32. Against the rebuilt MV that is an unavoidable 42703 at parse time (only mv_agency_stats is in FROM, so `agent_names` cannot resolve elsewhere); the NULL dropped_count scan is a second independent break.

WINDOW IS PROCESS-GUARANTEED: .github/workflows/terraform-deploy.yml:1022-1030 applies a hardcoded prod allowlist ending at 000085 — 000109 is not in it. CLAUD

---

### 8. [MAJOR] Agency board default ranking breaks: 000109 makes dropped_count/total_drop_value NULLable while ORDER BY still defaults to NULLS FIRST
**Where:** services/shorts/internal/store/shorts/postgres_house_prices.go:1316

**What's wrong:** Migration 000109 changed the `da` CTE to `CASE WHEN COUNT(*) >= 3 THEN COUNT(*) END AS dropped_count` / `... THEN SUM(total_abs) END AS total_drop_value` (000109_fix_listing_rollup_correctness.up.sql:277-279) and dropped the outer `COALESCE(da.dropped_count, 0)` / `COALESCE(da.total_drop_value, 0)` that 000086 had (000086_price_drops_rollups.up.sql:231-233). Those columns are therefore NULL for every agency with 0, 1 or 2 dropped addresses - i.e. the overwhelming majority. The Go read path added `COALESCE(dropped_count, 0)` to the SELECT list (line 1330) but NOT to the ORDER BY: the default is `orderBy := "dropped_count DESC, total_drop_value DESC, active_listings DESC"` (line 1316) and `case "value"` is `"total_drop_value DESC, dropped_count DESC"` (line 1323). Postgres defaults DESC to NULLS FIRST, and `dropped_count` is not an output alias here (the SELECT list emits unaliased `coalesce` columns), so it binds to the NULLable MV column. The sibling `case "avg_cut"` already spells out `NULLS LAST`, which shows the hazard was known. I reproduced it on postgres:16 with a synthetic mv_agency_stats (2 agencies with 42 and 12 drops, 3 with NULL): the exact production query returned the three NULL agencies as rows 1-3 and never returned the top discounter.

**How it fails in production:** After 000109 is applied, GET /price-drops (server-rendered, sort defaults to "drops", limit 20 - web/src/app/actions/getHousing.ts:221) returns the 20 agencies with fewer than three dropped addresses. AgencyDropsBoard (web/src/@/components/housing/price-drops/agency-drops-board.tsx:39-40) renders each as "0 cuts" with no avg/value, and the agencies actually discounting most disappear from the board entirely. The result is then pinned into the Upstash `cache:housing:drops:*` entry for 24h.

**Suggested fix:** Order on the coalesced expressions (or add NULLS LAST): `COALESCE(dropped_count,0) DESC, COALESCE(total_drop_value,0) DESC, active_listings DESC` and the same for the "value" branch - or keep the MV columns non-NULL and suppress only avg_drop_pct/total_drop_value as the k-anon requirement (F07) actually asks.

**Verifier's confirmation:** Reproduced end-to-end on postgres:16 using the migration's verbatim DDL; could not refute.

(1) MV nullability is real: 000109_fix_listing_rollup_correctness.up.sql:275-303 computes `CASE WHEN COUNT(*) >= 3 THEN COUNT(*) END AS dropped_count` / `... THEN SUM(total_abs) END AS total_drop_value` in the `da` CTE and projects `da.dropped_count`/`da.total_drop_value` bare over a LEFT JOIN, dropping the `COALESCE(...,0)` that 000086:231/233 had. Ran the DDL verbatim against synthetic property_listings/property_price_events (6 agencies x 8 active listings; 5/4/2/0/0/0 dropped addresses): agencies with 0-2 drops returned NULL dropped_count and NULL total_drop_value.

(2) ORDER BY binds to the NULLable MV column, not an output alias: the SELECT list emits `COALESCE(dropped_count, 0)` UNALIASED, so its output name is `coalesce` (confirmed in the psql header, and a temp view over the projection errors `column "coalesce" specified more than once`). `dropped_count` matches no output name -> resolves to the input column; DESC defaults to NULLS FIRST.

(3) The exact production query text from postgres_house_prices.go:1325-1335 with the default orderBy (line 1316) and LIMIT 4 returned the four zer

---

### 9. [MINOR] F05's caller-side timeout fix applied to only one of two byte-identical collector copies
**Where:** services/jobs/internal/jobs/houseprices/store.go:126

**What's wrong:** `git diff` of the two files at the base commit shows they were byte-identical; after this change they diverge. services/house-price-collector/store.go:126-130 now issues `SET statement_timeout = 0; SELECT refresh_housing_materialized_views()` (verified on PG 17.6 that this multi-statement simple query does disarm an already-armed session timeout, where the bare call does not), but services/jobs/internal/jobs/houseprices/store.go:126 still issues the bare `pool.Exec(ctx, "SELECT refresh_housing_materialized_views()")`. houseprices.Job() is registered in the consolidated binary (services/jobs/cmd/shorted/main.go:47) and the shorted-jobs image is built by terraform-deploy.yml:286-288, so this path is live code, merely not yet wired to a Cloud Run job for housing.

**How it fails in production:** When the housing collector is migrated onto the approved consolidated `shorted houseprices` binary (memory: jobs-consolidation is APPROVED), the refresh again runs under Supabase's role-level statement_timeout with only the function-scoped GUC — which 000095's own header documents as insufficient — reproducing the partial-refresh starvation 000107 exists to prevent.

**Suggested fix:** Apply the same two-statement Exec to services/jobs/internal/jobs/houseprices/store.go:126.

**Verifier's confirmation:** Divergence verified. services/house-price-collector/store.go:125-132 now issues `SET statement_timeout = 0; SELECT refresh_housing_materialized_views()`; the clone at services/jobs/internal/jobs/houseprices/store.go:125-128 still issues the bare `pool.Exec(ctx, "SELECT refresh_housing_materialized_views()")`. Both files set `DefaultQueryExecMode = pgx.QueryExecModeSimpleProtocol` (line 40 of each), so the same two-statement fix applies verbatim.

Reviewer detail corrected (immaterial): the two files were NOT byte-identical at 8c120a352 — md5s differ and `diff -u` shows exactly ONE differing line across 508 lines each (`package main` vs `package houseprices`). Line-for-line clones otherwise, so the claim's substance survives.

Registration/build claims check out: houseprices.Job() at services/jobs/cmd/shorted/main.go:47; shorted-jobs image built at .github/workflows/terraform-deploy.yml:286-288.

Reachability is future/manual, not scheduled — which is why minor is the right grade, and the finding says so itself. Today the deployed housing job uses the STANDALONE image (terraform/modules/house-price-collector + var.house_price_collector_image, still built at terraform-deploy.yml:283-

---

### 10. [MINOR] The k=3 floor on mv_suburb_price_drops is arithmetically invertible: count+avg+median+max+max_abs on one row reconstructs each individual listing's cut
**Where:** services/migrations/000109_fix_listing_rollup_correctness.up.sql:118-129

**What's wrong:** The suburb drop row publishes six statistics over the same n addresses: dropped_listing_count, avg_drop_pct, median_drop_pct, max_drop_pct, max_drop_abs and dropped_value (SUM of drop_abs). At the floor itself (n=3) that is an over-determined system: min = 3*avg − median − max recovers the third address exactly, and max_drop_abs / max_drop_pct recovers the prior asking price of the deepest-cut address whenever the same address holds both maxima. Verified on postgres:16 against the migration's own MV: three seeded addresses cut 20% / 10% / 5% produce n=3, avg=0.116667, median=0.1, max=0.2, max_abs=200000 → reconstructed min = 0.050000 (exact) and reconstructed prior ask = $1,000,000 (exact). Every one of those figures is proprietary-tos-restricted per-listing data. This is not covered by the HOUSING_DROP_LISTINGS_ENABLED kill switch: ListSuburbPriceDrops (services/shorts/internal/services/shorts/house_prices.go:367) and GetPriceDropsOverview (house_prices.go:632) have no flag gate, so after a takedown flips the switch off the per-address facts remain derivable from the "anonymous aggregate" board.

**How it fails in production:** An unauthenticated caller hits ListSuburbPriceDrops for a suburb whose row shows droppedListingCount=3. From avgDropPct, medianDropPct and maxDropPct it computes the exact discount on all three homes, and from maxDropAbs/maxDropPct the exact pre-cut asking price of one of them — with HOUSING_DROP_LISTINGS_ENABLED=false and the address board dark.

**Suggested fix:** Do not publish extremes (max_drop_pct / max_drop_abs) alongside count+mean+median on the same k-floored row; either drop the max_* columns, raise the floor for rows that carry extremes, or bucket/round the published statistics so the system is under-determined.

**Verifier's confirmation:** MECHANISM CONFIRMED, SEVERITY DOWNGRADED major -> minor.

Reproduced exactly. I lifted lines 77-132 of services/migrations/000109_fix_listing_rollup_correctness.up.sql verbatim into a scratch postgres:16 DB with three seeded addresses cut 20/10/5%: the MV emits dropped_listing_count=3, avg_drop_pct=0.11666666666666668, median_drop_pct=0.1, max_drop_pct=0.2, max_drop_abs=200000, dropped_value=265000. 3*avg - median - max = 0.05000000000000004 (the third cut, exact) and max_drop_abs/max_drop_pct = 1,000,000 (the prior ask) - drop_pct is literally drop_abs/prior_price (services/house-price-collector/crawl_listings_diff.go:302-303). (Scratch DB dropped; worktree untouched.)

Reachability also confirmed: ListSuburbPriceDrops and GetPriceDropsOverview are VISIBILITY_PUBLIC (proto/shortedapi/shorts/v1alpha1/housing.proto:37,57); the four dropListingsEnabled() call sites (services/shorts/internal/services/shorts/house_prices.go:437,479,593,678) cover only the per-address/per-listing/agency surfaces, not these two; values flow through as un-rounded float64/double (postgres_house_prices.go:702-703, SuburbPriceDrop fields 6-9).

WHY IT IS NOT MAJOR - three things the finding gets wrong or ove

---

### 11. [MINOR] The consolidated `shorted` jobs binary keeps the pre-fix refresh call, so F05 silently un-fixes itself at the Phase-2 cutover
**Where:** services/jobs/internal/jobs/houseprices/store.go:126

**What's wrong:** services/house-price-collector/store.go:125-131 now sends `SET statement_timeout = 0; SELECT refresh_housing_materialized_views()` as one simple-protocol command (necessary because the ALTER FUNCTION ... SET statement_timeout in 000107 cannot disarm a timer already armed for the calling statement). The byte-duplicate of that file under the consolidated jobs binary — services/jobs/internal/jobs/houseprices/store.go:126 — still issues a bare `SELECT refresh_housing_materialized_views()`. Housing is currently the only job still on its own module/image (terraform/environments/prod/main.tf:185-192 uses var.house_price_collector_image, while announcements/economy/news/signals/weekly-report already run var.shorted_jobs_image), so the fix is live today, but nothing pins it there.

**How it fails in production:** When housing is switched to the `shorted houseprices` subcommand like the other five jobs, refresh_housing_materialized_views() runs again under the pooler's inherited statement_timeout; the first MV to exceed it raises query_canceled and the caller-side protection F05 added is gone (the in-function guards keep later views running, but the cancelled view stays stale silently — the exact 19-day staleness class that 000095 was written for).

**Suggested fix:** Apply the same `SET statement_timeout = 0;` prefix in services/jobs/internal/jobs/houseprices/store.go, or make one of the two files the single source.

**Verifier's confirmation:** CONFIRMED (latent, not live). All claims verified in the worktree.

Evidence:
- Byte-duplicate confirmed at base: `git show 8c120a352:services/house-price-collector/store.go` and `8c120a352:services/jobs/internal/jobs/houseprices/store.go` are identical.
- The branch diff touches exactly one Go file outside `services/shorts`: `/Users/benebsworth/projects/.worktrees/shorted-hw-mv-correctness/services/house-price-collector/store.go` (+5 -1). Nothing under `services/jobs/`.
- `/Users/benebsworth/projects/.worktrees/shorted-hw-mv-correctness/services/jobs/internal/jobs/houseprices/store.go:126` still reads `_, err := pool.Exec(ctx, `SELECT refresh_housing_materialized_views()`)`, reachable from `job.go:416` (-mode refresh|all), `crawl_listings.go:353`, `crawl_agent.go:688`.
- No compensating guard: `grep -rn statement_timeout services/jobs --include='*.go'` = 0 hits; its `connect()` uses the same QueryExecModeSimpleProtocol pool with no session GUC, so it inherits the pooler timeout. 000107's `ALTER FUNCTION ... SET statement_timeout TO '0'` cannot disarm a timer already armed for the calling statement (the stated reason the caller-side SET exists), so the migration does not cover this

---

### 12. [MINOR] F05 caller-side timeout fix applied only to the legacy collector, not the ported jobs binary
**Where:** services/jobs/internal/jobs/houseprices/store.go:125-127

**What's wrong:** The fix lands in services/house-price-collector/store.go:125-131 (`SET statement_timeout = 0; SELECT refresh_housing_materialized_views()`), but the byte-identical port at services/jobs/internal/jobs/houseprices/store.go:125-127 still calls `pool.Exec(ctx, "SELECT refresh_housing_materialized_views()")`. services/jobs/README.md lists house-prices as ported (Phase 2d) and awaiting Terraform/rig cutover, so this copy is the intended future runtime. The new contract test (services/migrations/mv_correctness.test.mjs:44-52) reads only ../house-price-collector/store.go, so nothing flags the divergence. The migration's `ALTER FUNCTION ... SET statement_timeout TO '0'` cannot rescue it - as the fix's own comment says, a function-scoped GUC cannot disarm a timeout already armed for the calling statement.

**How it fails in production:** After the documented `shorted house-prices` cutover, a monthly ingest under Supabase's role-level statement_timeout re-hits the exact 000095/#349 failure mode: refresh_housing_materialized_views() is cancelled mid-run, the housing MVs (price drops, listing stats, headline, crime) silently go stale for weeks, and /price-drops + /housing serve frozen data while the job reports success.

**Suggested fix:** Apply the same two-statement Exec in services/jobs/internal/jobs/houseprices/store.go and extend mv_correctness.test.mjs to assert it in both files.

**Verifier's confirmation:** Drift is real and verified: services/jobs/internal/jobs/houseprices/store.go:125-127 still runs bare `pool.Exec(ctx, "SELECT refresh_housing_materialized_views()")` while the fixed twin services/house-price-collector/store.go:125-131 prefixes `SET statement_timeout = 0;`. Both files configure `DefaultQueryExecMode = pgx.QueryExecModeSimpleProtocol` (line 40 in each), so the two-statement Exec ports over verbatim. services/migrations/mv_correctness.test.mjs:44-52 asserts only against ../house-price-collector/store.go (ran it: 4/4 pass), and grep over Makefile/services/Makefile/.github/workflows/package.json finds no runner for that .mjs at all, so nothing flags the divergence — the reviewer did not misread.

Two corrections that keep this at minor rather than higher:
(1) Not reachable today. services/jobs/README.md:305-320 documents house-prices as "CODE ONLY" — Cloud Run job, residential rigs and local operator runs all still exec the standalone collector, and .github/workflows/terraform-deploy.yml:283 still builds services/house-price-collector/Dockerfile. The ported refreshHousingMV is a dormant duplicate until the cutover.
(2) The stated failure scenario is overstated. Migration

---

### 13. [MINOR] The only behavioural test for F17 cannot execute - the integration test is already red before the assertion is reached
**Where:** services/shorts/internal/store/shorts/postgres_suburb_explorer_test.go:204-208

**What's wrong:** The diff adds a `mv_register_suburb_property` stub to setupSuburbExplorerSchema (line 122) plus `assert.Equal(t, int32(2), p.Summary.PoliticianPropertyCount, ...)` at line 206. I ran `go test -tags=integration -run TestHousingLicenceGate ./internal/store/shorts/ -v`: TestHousingLicenceGate_SuburbProfile fails at line 204 with `ERROR: column d.banner_archetype does not exist (SQLSTATE 42703)` (the test schema was never updated for migration 000084), and TestHousingLicenceGate_StateSuburbs fails at line 170 with `ERROR: relation "mv_suburb_crime_latest" does not exist (SQLSTATE 42P01)`. Both are pre-existing gaps, but the consequence is that the new assertion never runs - `require.NoError` aborts first. The only other coverage for F17 is postgres_house_prices_query_test.go:54-64, which greps the source file for the literal SQL/scan strings and therefore cannot detect a column-order or join-shape error.

**How it fails in production:** A future edit that (say) inserts a column between `banner_bg_url` and `declared_property_count` in the SELECT list without moving `&p.Summary.PoliticianPropertyCount` in the Scan call passes both the string-match test and CI, and GetSuburbProfile then either scan-errors at runtime or reports the wrong value - the added integration assertion that would have caught it is unreachable.

**Suggested fix:** Add the banner_* columns to the test suburb_demographics DDL and a stub mv_suburb_crime_latest so these two integration tests actually run, or drop the inert assertion and cover F17 with a mock/handler-level test that exercises the real scan order.

**Verifier's confirmation:** Reproduced verbatim. `go test -tags=integration -run TestHousingLicenceGate ./internal/store/shorts/ -v` in the worktree: TestHousingLicenceGate_SuburbProfile fails at postgres_suburb_explorer_test.go:204 (`require.NoError`) with `column d.banner_archetype does not exist (SQLSTATE 42703)`, and TestHousingLicenceGate_StateSuburbs fails at line 170 with `relation "mv_suburb_crime_latest" does not exist (SQLSTATE 42P01)`. The new assertion (actually lines 209-210, not 206) is therefore unreachable. Both gaps are pre-existing: at base 8c120a352 postgres_house_prices.go already selected d.banner_archetype (L413) and joined mv_suburb_crime_latest (L268) while the base test schema stubbed neither — so the author added the mv_register_suburb_property stub without ever running the test.

Refutation attempts that failed: (a) no guard elsewhere in the diff adds banner_* columns or a crime-MV stub (test file diff is +9 lines total); (b) the other new test, services/shorts/internal/services/shorts/house_prices_test.go::TestGetSuburbProfile_MapsPoliticianPropertyCount, uses a gomock store, so it covers only row→proto mapping and cannot detect a SELECT/Scan column-order regression — the reviewer 

---

### 14. [MINOR] Agency query is not migration-order tolerant: 000109 drops agent_names while the running API still selects it
**Where:** services/shorts/internal/store/shorts/postgres_house_prices.go:1331

**What's wrong:** 000109 recreates mv_agency_stats without the `agent_names` column (000109_fix_listing_rollup_correctness.up.sql:230-303). Per this repo's documented prod procedure, migrations are applied BY HAND before the code merges/deploys. The currently-deployed query (base commit) selects `COALESCE(agent_names, '{}')`, so during that window `ListAgencyPriceStats` fails with SQLSTATE 42703 and the handler converts it to `connect.CodeInternal` (house_prices.go:697-698 -> the error path at the end of the GetOrSet). The sibling suburb query at line 700 deliberately handles exactly this hazard with `COALESCE((to_jsonb(d) ->> 'dropped_value')::float8, 0)` ("keeps this ONE query that works on both the old and new MV shape, so a code deploy ahead of the manual prod DDL can't break the suburb board"); the agency query has no equivalent guard in either direction.

**How it fails in production:** Operator applies 000109 to prod Supabase on the session pooler before the new API image is promoted. Every ListAgencyPriceStats call 500s; web/src/app/actions/getHousing.ts's withRetryAndNotFound swallows it to `undefined`, AgencyDropsBoard returns null, and the agency section silently vanishes from /price-drops (or, worse, the stale 24h `cache:housing:drops:agency*` KV entry masks the outage) until the API rolls.

**Suggested fix:** Either keep an `agent_names text[]` column (empty array) in the rebuilt MV so both code versions work, or read it shape-agnostically like the suburb query does; alternatively document the strict deploy order (code first, then DDL) for this migration.

**Verifier's confirmation:** Real and reachable. Verified in /Users/benebsworth/projects/.worktrees/shorted-hw-mv-correctness: (a) base 8c120a352 postgres_house_prices.go:1327 selects COALESCE(agent_names,'{}') from mv_agency_stats and scans it; (b) services/migrations/000109_fix_listing_rollup_correctness.up.sql:244-303 DROPs mv_agency_stats and recreates it without agent_names (the 000086 `agents` CTE is deleted; the down migration :199-209 restores it, so the column really is gone, not renamed); (c) the new query at :1331 uses a literal '{}'::text[], so the NEW code is shape-tolerant — the gap is only old-binary-vs-new-MV. Ops sequence is real: prod does NOT run migrate up (.github/workflows/terraform-deploy.yml:1019-1032 applies a hardcoded allowlist ending at 000085) and the branch commit message itself says "Migrations 000107-000109 (hand-apply on prod, session pooler 5432)"; repo practice is DB-before-code. Blast radius confirmed: dropListingsEnabled() (house_prices.go:408-415) defaults ON; MemoryCache.GetOrSet (internal/services/shorts/cache.go:104-109) does NOT cache errors, so every post-TTL request re-hits the failing query and 500s via connect.CodeInternal (house_prices.go:719-722); web withRetryAn

---

