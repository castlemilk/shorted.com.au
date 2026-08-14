Fix defects found by a second adversarial review of your work on this branch. Three independent lenses reviewed the diff and a separate verifier tried to REFUTE each finding; only CONFIRMED ones appear below (several were reproduced against a real PostgreSQL container or by reading the rendered UI). Do not re-litigate them.

Ground rules:
- Your previous work is ALREADY COMMITTED on this branch. Add fix commits on top. Do not rewrite history, push, merge, or switch branches.
- Fix root causes. Where a TEST or a CI guard pins the buggy behaviour or is inert, fix it so it asserts real behaviour - an assertion that can never fire is worse than none.
- Re-run the scoped tests and report ACTUAL output. If the sandbox blocks something, say so plainly rather than claiming it passed.
- If you genuinely believe a finding is wrong, argue it with evidence in your summary rather than silently skipping it.
- Note: sibling branches are fixing other housing areas in parallel. Keep edits to shared files minimal and additive.

IMPORTANT CONTEXT ON FINDING 1 (the max_drop_pct/max_drop_abs NULLing): this regression came from MY instruction, not your judgement - I asked you to "stop publishing extremes alongside count/mean/median on k-floored rows" and you implemented it literally by hard-NULLing the columns. That was the wrong call and it is on me. Resolve it the OTHER way: RESTORE MAX(max_pct)/MAX(max_abs) behind the same `CASE WHEN <count> >= 3 THEN ...` guard that mv_state_price_drops already uses (line ~218), so suburb and state are CONSISTENT at the same k floor, and the live "Biggest cut" sort + column keep working. Do NOT remove the metric end-to-end. If you still consider the k-anon reconstruction concern real at n=3, the honest fix is to raise the floor for rows carrying extremes (and note that median_drop_pct at exactly n=3 IS one address's value, so it has the same property) - say what you chose and why.

## Confirmed findings (6)

### 1. [MAJOR] Fix round hard-NULLs suburb max_drop_pct/max_drop_abs, killing a live "Biggest cut" column + sort and pinning a public API field to 0
**Where:** services/migrations/000109_fix_listing_rollup_correctness.up.sql:119-120

**What's wrong:** The final fix commit (94bee87db, "stop publishing extremes alongside count/mean/median on k-floored rows") replaced `MAX(max_pct)`/`MAX(max_abs)` in `mv_suburb_price_drops` with `NULL::double precision AS max_drop_pct` / `NULL::double precision AS max_drop_abs`. Nothing downstream was updated:

1. `services/shorts/internal/store/shorts/postgres_house_prices.go:696` still offers `sort="max"` as `orderBy = "COALESCE(d.max_drop_pct, 0)"`, so that ordering key is now constant 0 for every row.
2. `web/src/@/components/housing/suburb-price-drops-panel.tsx:57` renders a live "Biggest cut" sort button (used on `/housing` and `/housing/[state]`) that calls `listSuburbPriceDropsClient(stateCode, "max", 25)`.
3. Three surfaces render the value: `suburb-price-drops-panel.tsx:104`, `price-drops/suburb-drops-leaderboard.tsx:60` (the server-rendered, SEO-visible `/price-drops` leaderboard, page.tsx:165), each guarded by `r.maxDropPct > 0 ? … : "—"`.
4. `proto/shortedapi/shorts/v1alpha1/housing.proto:356-357` (`SuburbPriceDrop.max_drop_pct` / `max_drop_abs`, "largest single reduction, AUD") becomes permanently 0 for external API consumers, with no proto/doc change.

The stated k-anon rationale is also applied inconsistently and does not hold on its own terms: the same MV still publishes `median_drop_pct` (line 118) even though `mv_suburb_price_drops` is gated at `dropped_listing_count >= 3` (line 126), and `PERCENTILE_CONT(0.5)` over exactly 3 addresses IS one address's exact drop pct — the very thing the suppression claims to prevent. Meanwhile `mv_state_price_drops` (line 218) still publishes `CASE WHEN d.dropped_count >= 3 THEN d.max_drop_pct END`, i.e. the extreme is retained at the identical k=3 floor for states. So the change removes a working, displayed metric without closing the leak it targets.

The new integration test `postgres_mv_correctness_integration_test.go:171-187` locks the NULLs in, so this ships as intended behaviour unless corrected.

**How it fails:** After 000109 is hand-applied to prod: load `/housing`, click the "Biggest cut" sort button. `ListSuburbPriceDrops(stateCode, "max", 25)` runs `ORDER BY COALESCE(d.max_drop_pct, 0) DESC NULLS LAST LIMIT 25` where every row's key is 0, so Postgres returns an arbitrary 25 suburbs (not the deepest cutters, and a different set from "Most cuts"), and every cell in the "Biggest cut" column renders "—". The same column is a full row of "—" on the server-rendered `/price-drops` leaderboard and on `/housing/[state]`. A public API consumer of `ListSuburbPriceDrops` reads `max_drop_pct: 0` / `max_drop_abs: 0` for every suburb.

**Suggested fix:** Either restore `MAX(max_pct)`/`MAX(max_abs)` behind the same `CASE WHEN dropped_listing_count >= N THEN …` guard used for the state MV (and pick a consistent N across suburb + state), or remove the metric end-to-end: drop the "max" SortKey and the "Biggest cut" columns from `suburb-price-drops-panel.tsx` / `suburb-drops-leaderboard.tsx`, drop the `case "max"` branch in `ListSuburbPriceDrops`, and deprecate `SuburbPriceDrop.max_drop_pct`/`max_drop_abs` in the proto. If the k-anon concern is real, `median_drop_pct` at n=3 must be suppressed too.

**Verifier's confirmation:** Verified end-to-end in the worktree; no guard or compensating change exists in 8c120a352..HEAD.

MV: services/migrations/000109_fix_listing_rollup_correctness.up.sql:119-120 emits `NULL::double precision AS max_drop_pct/max_drop_abs` in mv_suburb_price_drops. `git show 94bee87db` confirms it replaced `MAX(max_pct)`/`MAX(max_abs)`; `max_abs` was also removed from the per_source/win/agg CTEs, so it is no longer even computed.

Downstream is untouched:
- services/shorts/internal/store/shorts/postgres_house_prices.go:696 still maps sort="max" to `COALESCE(d.max_drop_pct, 0)`; :713-714 still COALESCE both columns to 0. The branch's diff of this file only touches crime ranks, ListSuburbDropListings and ListAgencyPriceStats.
- services/shorts/internal/services/shorts/house_prices.go:383 still copies MaxDropPct/MaxDropAbs into the response; the handler does not validate `sort`.
- proto/shortedapi/shorts/v1alpha1/housing.proto:343 still documents sort 'count'|'avg'|'max'; :356-357 still document max_drop_pct/max_drop_abs ("largest single reduction, AUD"). No proto/doc change in the branch.
- 

---

### 2. [MAJOR] mv_suburb_price_drops hard-NULLs max_drop_pct/max_drop_abs but the read path and UI still publish them
**Where:** services/migrations/000109_fix_listing_rollup_correctness.up.sql:119-120

**What's wrong:** The rebuilt `mv_suburb_price_drops` emits `NULL::double precision AS max_drop_pct` / `AS max_drop_abs` (lines 119-120), yet nothing downstream was changed to match:

- `services/shorts/internal/store/shorts/postgres_house_prices.go:713-714` still selects `COALESCE(d.max_drop_pct, 0), COALESCE(d.max_drop_abs, 0)` and maps them onto `SuburbPriceDrop.max_drop_pct/max_drop_abs`.
- `postgres_house_prices.go:696` still whitelists `sort="max"` -> `orderBy = "COALESCE(d.max_drop_pct, 0)"`.
- `web/src/@/components/housing/price-drops/suburb-drops-leaderboard.tsx:60` renders a `Biggest cut` column from `r.maxDropPct`, and `web/src/@/components/housing/suburb-price-drops-panel.tsx:58,104` exposes a `Biggest cut` sort button (server-side: `listSuburbPriceDropsClient(stateCode, sort, limit)`) plus the same column.

Also note the suppression is internally inconsistent: `mv_state_price_drops` still publishes the same extreme at line 165/218 (`MAX(max_pct)`, suppressed only below k=3), and `national-pulse.tsx:23` renders it as "deepest -X%". So the extreme is withheld at suburb level but published nationally.

Verified against a throwaway PG14 with 000107-000109 applied: `mv_suburb_price_drops` row for a suburb with 3 dropped addresses returns `max_drop_pct | (null)` and `max_drop_abs | (null)`, while `mv_state_price_drops` for the same data returns `max_drop_pct | 0.05`.

**How it fails:** After 000109 is hand-applied to prod, every row of the flagship `/price-drops` leaderboard renders `Biggest cut` as "—" (the column is permanently dead), and clicking "Biggest cut" on the `/housing` SuburbPriceDropsPanel issues `sort=max`, which the store turns into `ORDER BY COALESCE(d.max_drop_pct, 0) DESC NULLS LAST` — a constant 0 for every row — so the user gets an arbitrary heap-order list presented as a ranking by biggest cut.

**Suggested fix:** Either keep publishing the suburb extremes (the MV already enforces a >=3 dropped-address floor, and the state MV publishes the same figure), or drop `max_drop_pct`/`max_drop_abs` from the proto/store/UI and remove the `max` sort option — don't leave a live column and sort key wired to a constant NULL.

**Verifier's confirmation:** Verified in worktree shorted-hw-mv-correctness. 000109 up-migration lines 119-120 do emit `NULL::double precision AS max_drop_pct` / `AS max_drop_abs` in mv_suburb_price_drops (introduced by HEAD commit 94bee87db, "stop publishing extremes alongside count/mean/median on k-floored rows"). Nothing downstream was updated: `git diff 8c120a352...HEAD -- web/ proto/` is EMPTY, and the store diff touches only ListAgencyPriceStats ordering + crime-rank/profile code. ListSuburbPriceDrops still has `case "max": orderBy = "COALESCE(d.max_drop_pct, 0)"` (postgres_house_prices.go:696) and still selects `COALESCE(d.max_drop_pct, 0), COALESCE(d.max_drop_abs, 0)` (713-714), mapped to proto at house_prices.go:383. UI still live: suburb-drops-leaderboard.tsx:30/60 ("Biggest cut" header + `r.maxDropPct > 0 ? ... : "—"`) and suburb-price-drops-panel.tsx:11/58/104 (SortKey includes "max", a "Biggest cut" sort button, same column). listSuburbPriceDropsClient passes `sort` through and the handler passes m.Sort straight to the store — no whitelist strips "max". The branch's own tests corroborate the NULL is

---

### 3. [MAJOR] Address-dedup DISTINCT ON has no unique tiebreak, so published asking/sold prices flip between refreshes
**Where:** services/migrations/000109_fix_listing_rollup_correctness.up.sql:24, 50, 176, 205

**What's wrong:** `asking_addresses` (line 24), `sold_addresses` (line 50), `active_addresses` (line 176) and the state `sold_addresses` (line 205) all pick one row per `address_key` with `ORDER BY pl.address_key, pl.last_seen_at DESC, pl.source` (plus `st.sold_at DESC` for sold). None of these keys is unique for two listings from the SAME portal at the same address:

- `last_seen_at` is set to the run timestamp for every listing in a sweep (`services/house-price-collector/crawl_listings_store.go:151,170` — `runTs` is bound to `$22` for both `first_seen_at` and `last_seen_at`), so it is identical across all listings of a sweep.
- `pl.source` is identical for two REA (or two Domain) adverts at the same address.
- Nothing dedups same-source duplicates at write time: the only uniqueness is `UNIQUE (source, listing_id)` (000076), and a relist under a fresh `listing_id` leaves the old row `is_active = true` until a delist sweep, which per the REA truncation behaviour effectively never completes.

The author clearly knew about this class of tie — `mv_agency_stats.base` (line 268) appends `pl.listing_id` as a final tiebreak — but the other four DISTINCT ONs did not get one. The pre-000109 definitions aggregated over all rows (`AVG(price)` over every for-sale listing), so they were deterministic; this diff introduces the non-determinism.

Reproduced on PG14 with the migration applied, two active `rea` rows at `address_key='dup-addr'` with identical `last_seen_at` and prices 2,000,000 / 1,500,000, running the exact `asking_addresses` CTE:
  pick #1 -> 2000000
  (touch the other row so its tuple relocates)
  pick #2 -> 1500000
  pick #3 -> 2000000

**How it fails:** A suburb contains one address advertised twice on realestate.com.au (relist under a new listing_id, old row still is_active) at $2.0M and $1.5M. Two consecutive `refresh_housing_materialized_views()` runs over unchanged listing data publish different `avg_asking`/`median_asking` for that suburb (and different `for_sale_count`/`total_active_listings` if the two rows disagree on `listing_status`), because the DISTINCT ON tie is resolved by physical row order. The same applies to `avg_sold`/`median_sold` via `sold_addresses` and to every state/national aggregate built on `active_addresses`.

**Suggested fix:** Append a unique final tiebreak (`pl.listing_id` or `pl.id`) to the ORDER BY of `asking_addresses`, `sold_addresses` (both copies) and `active_addresses`, matching what `mv_agency_stats.base` already does.

**Verifier's confirmation:** Real and reachable. The four DISTINCT ON CTEs (000109 lines 24, 50, 176, 205) end at `pl.source` with no unique tiebreak, while `mv_agency_stats.base` (252-253) appends `pl.listing_id` — inconsistent within the same migration. Only uniqueness on property_listings is UNIQUE(source, listing_id) (000076), and `runTs` is one timestamp per run bound to $22 for both first_seen_at/last_seen_at (crawl_listings_store.go:151,201; crawl_listings.go:286), so every row re-sighted in one sweep shares an identical last_seen_at. Cross-portal dupes are broken by `pl.source`; two SAME-portal adverts at one address_key seen in the same sweep tie completely.

Reproduced on PG16 with the exact asking_addresses CTE (3 addresses, one with two tied rea rows at 2.0M/1.5M): avg_asking 1,233,333 -> `UPDATE ... SET updated_at = now()` on the winner (exactly what every re-sight upsert does) -> 1,066,667 -> touch the other -> 1,233,333. Pure tuple relocation, no price change.

Measured against prod (read-only): 73,672 active addressed rows; 905 fully-tied (address_key, source, last_seen_at) groups among for_sale/

---

### 4. [MINOR] Regression guard against the portal-ID dedup fallback is inert (regex omits the `e.` alias)
**Where:** services/migrations/mv_correctness.test.mjs:102

**What's wrong:** `assert.doesNotMatch(up, /source \|\| ':' \|\| listing_id/i)` is meant to prove the `source:listing_id` fallback dedup key was removed from 000109's up migration. But every occurrence of that fallback in this codebase is written with a table alias — `COALESCE(NULLIF(e.address_key, ''), e.source || ':' || e.listing_id)` (000086 up:32/92/187, 000109 down:42/94/165) — and the regex requires `':' || listing_id` with no `e.` prefix. Verified with node: the regex returns false against the real string, while the sibling assertion on line 105 (`/source \|\| ':' \|\| e\.listing_id/i`) returns true. So the guard can never fire.

**How it fails:** A later edit reintroduces `COALESCE(NULLIF(e.address_key, ''), e.source || ':' || e.listing_id) AS dedup_key` into 000109_fix_listing_rollup_correctness.up.sql (restoring the cross-portal double-count the migration exists to remove). `node --test services/migrations/mv_correctness.test.mjs` still reports 4/4 passing.

**Suggested fix:** Match the aliased form, e.g. `/source \|\| ':' \|\| \w*\.?listing_id/i`, mirroring the down-file assertion on line 105.

**Verifier's confirmation:** CONFIRMED with a correction to the rationale. Reproduced in a sandbox copy (repo untouched).

Core defect is real and reachable exactly as described: at services/migrations/mv_correctness.test.mjs:102, `assert.doesNotMatch(up, /source \|\| ':' \|\| listing_id/i)` cannot see the aliased form `COALESCE(NULLIF(e.address_key, ''), e.source || ':' || e.listing_id) AS dedup_key` (the regex requires listing_id with no `e.` prefix). Injecting that expression back into the `ev` CTE of mv_suburb_price_drops in 000109_fix_listing_rollup_correctness.up.sql — both as a bare dedup_key swap and as a full regression that ALSO removes that CTE's `AND NULLIF(pl.address_key, '') IS NOT NULL` filter — still yields 4 pass / 0 fail. Nothing backstops it: line 101's address_key assertion is a `match`, satisfied by the three untouched MVs; line 103's join assertion is unaffected.

Correction: the DETAIL's supporting claim that "every occurrence of that fallback in this codebase is written with a table alias" and that "the guard can never fire" is FALSE. Four occurrences are unaliased — 000086_price_drops_ro

---

### 5. [MINOR] State rollup is driven off active-only addresses, so sold-only states vanish while their sales stay in the national row
**Where:** services/migrations/000109_fix_listing_rollup_correctness.up.sql:230-232

**What's wrong:** `mv_state_price_drops` is now `FROM l LEFT JOIN d USING (state_code) LEFT JOIN sold USING (state_code)` (lines 230-232), where `l` is built exclusively from `active_addresses` (`WHERE pl.is_active`, line 172). The previous 000086 definition built `l` from all `property_listings` in the state, so any state with data at all had a row.

Two consequences:
1. A state with no currently-active addressable listing produces no row at all, but its sold addresses still feed the `()` grouping set, so the `AU` row counts sales that no state row accounts for.
2. `suburbs_tracked` (line 185) now counts only suburbs holding a currently-active address, while `sold_count` on the same row spans suburbs that no longer do.

Reproduced on PG14 (NSW: 5 active + 3 sold-inactive; VIC: 3 sold-inactive only):
  000109:      AU total_active=5 sold_count=6 suburbs_tracked=1 | NSW sold_count=3 | (no VIC row)
  000109 down: AU total_active=5 sold_count=6 suburbs_tracked=3 | NSW sold_count=3 | VIC sold_count=3

**How it fails:** `/price-drops` renders the national pulse tile from the `AU` row and the state board from the per-state rows. With a state whose crawled listings have all been delisted, the national tile reports 6 sales while the state board rows sum to 3, and the "N tracked metro suburbs" sub-label drops to the number of suburbs that happen to hold a live advert at refresh time rather than the suburbs the sold figures came from.

**Suggested fix:** Build `l` from the full state universe (or full-outer-join `l`/`sold` on state_code) so the per-state rows still cover states/suburbs that only have sold history, and derive `suburbs_tracked` from the same universe the sold/asking figures come from.

**Verifier's confirmation:** CONFIRMED at the SQL level, reproduced exactly; the described UI symptom is wrong and the vanishing-state branch is not prod-reachable, so severity stays minor.

VERIFIED FACTS
1. services/migrations/000109_fix_listing_rollup_correctness.up.sql:230-232 is `FROM l LEFT JOIN d USING (state_code) LEFT JOIN sold USING (state_code)`, with `l` built only from `active_addresses` (`WHERE pl.is_active`, line 173). The 000086 original built `l` from `property_listings` with per-metric `FILTER (WHERE is_active ...)`, so every state with any listing had a row.
2. The active and sold populations are disjoint by construction: services/house-price-collector/crawl_listings_store.go:209 `statusActive(status) = status != "sold" && status != "withdrawn"` is bound to `is_active` in the upsert (line 201), so every `listing_status='sold'` row is `is_active=false`. `sold_addresses` can therefore never be covered by `active_addresses` at row level.
3. Reproduced on PG16 (scratch container, schemas dropped afterwards; worktree unmodified) with the reviewer's fixture (NSW 5 active for_sale + 3 sold-inactive i

---

### 6. [MINOR] refreshHousingMV uses session-scoped SET instead of SET LOCAL on a shared transaction pooler
**Where:** services/house-price-collector/store.go:129

**What's wrong:** `refreshHousingMV` sends `SET statement_timeout = 0;\nSELECT refresh_housing_materialized_views()` as one simple-protocol command (also at `services/jobs/internal/jobs/houseprices/store.go:129`). The mechanism itself is correct — I verified on PG14 with `ALTER DATABASE ... SET statement_timeout='500ms'` that a bare `SELECT pg_sleep(2)` is cancelled, that the multi-statement form with the leading `SET` completes, and that the function-level `ALTER FUNCTION ... SET statement_timeout TO '0'` alone does NOT save it. But `SET` (not `SET LOCAL`) is session-scoped and survives the implicit transaction; `connect()` in the same file (line 40) pins `pgx.QueryExecModeSimpleProtocol` precisely because this pool talks to the Supabase transaction pooler on 6543, where server connections are handed back to a shared pool after each transaction. `SET LOCAL statement_timeout = 0` works identically inside the implicit block (verified: `current_setting('statement_timeout')` returns `0`) and is scoped to the transaction.

**How it fails:** After a housing collector run, the pooled Supabase server connection it used is returned to the transaction pooler still carrying `statement_timeout = 0`; the next tenant of that server connection runs with no statement timeout, so a runaway query from an unrelated service is never cancelled.

**Suggested fix:** Use `SET LOCAL statement_timeout = 0;` in both `refreshHousingMV` copies so the override dies with the transaction.

**Verifier's confirmation:** Verified in /Users/benebsworth/projects/.worktrees/shorted-hw-mv-correctness (HEAD 94bee87db, diff vs 8c120a352). The finding stands; I could not refute it.

Code as written (identical in both copies — /Users/benebsworth/projects/.worktrees/shorted-hw-mv-correctness/services/house-price-collector/store.go:125-131 and .../services/jobs/internal/jobs/houseprices/store.go:125-131; `diff` reports the files byte-identical):

    _, err := pool.Exec(ctx, `SET statement_timeout = 0;
    		SELECT refresh_housing_materialized_views()`)

Refutation attempts, all failed:

1. "The SET is rolled back with the implicit transaction." REFUTED empirically on local PG17 (psql, two `-c` commands = two implicit transactions on one session, baseline armed via `PGOPTIONS=-c statement_timeout=500ms`):
   - `SET statement_timeout = 0; SELECT current_setting(...)` → inside `0`, and the NEXT command on the same session still reports `0` (leaked).
   - `SET LOCAL statement_timeout = 0; SELECT ...` → inside `0`, next command back to `500ms` (scoped), no "SET LOCAL can only be used in transaction blocks" warning

---

