You must fix defects found by an adversarial review of YOUR OWN previous change on this branch. The review ran three independent lenses plus a refutation pass; every finding below was CONFIRMED against the actual code (several were reproduced on a real PostgreSQL container). Do not re-litigate them - two of the blockers were found independently by three separate reviewers.

Ground rules:
- You are in the same git worktree, on the same branch, with your previous work already COMMITTED. Add fix commits on top; do not rewrite history, do not push, do not merge, do not switch branches.
- Fix the root cause, not the symptom. Where a finding says a TEST asserts the buggy behaviour, fix the test to assert the correct BEHAVIOUR (not a SQL string literal) - a test that pins a defect is worse than no test.
- After fixing, re-run the scoped tests and report ACTUAL output. If you cannot run something in the sandbox, say so plainly rather than claiming it passed.
- If you believe a finding is genuinely wrong, say so explicitly with evidence in your summary rather than silently ignoring it.

## Confirmed findings on feat/housing-crawl-correctness (7 distinct)

### 1. [BLOCKER] New thin-suburb "exhausted" verdict returns sweepComplete with an EMPTY listing set → delists the whole suburb
**Where:** services/house-price-collector/crawl_listings.go:622-624 (`if metaOK && onTargetResults > 0 ... return finish(sweepComplete)`)

**What's wrong:** The new gate returns `finish(sweepComplete)` at line 624, but `collected` is only populated by the merge loop at lines 646-654, which is *below* this early return. Every pre-existing `sweepComplete` path (duplicate page 641, empty page 641/643, capped-complete tail 682, the two `upgradeIfPageMetaConfirms` upgrades) is reached only after page 1 has already passed the `len(matched) >= minPerPage` gate, so before this diff the invariant `sweepComplete ⇒ collected >= minPerPage` held. This branch is the first path that can return `complete` with zero listings, and `complete` is exactly the status that unlocks the delist pass in `crawl_listings_diff.go:101-132`: `seen` is empty, so `activeListingsForRegion(source, regionCode)` returns every live listing in the suburb, each gets `missed_sweeps+1` via `markAbsent`, and at `delistGrace` (default 2) each gets a `delisted` price event and `status='withdrawn'`. The listings that were actually rendered on page 1 are also never upserted (no `first_seen`, no price diff), so a new thin suburb never enters `property_listings` at all. Because those delist events count as `events>0`, `agentJobTerminal`/`agentJobOutcome` (crawl_agent.go:870-896) bank the job as "succeeded" — the corruption is silent. Note the intended outcome was already reachable without this branch: with `onTargetResults=2, pageSize=25` the walk is sized to `wantPages=1`, so deleting the early return lets the loop fall through to the capped-complete tail (line 682) and return `sweepComplete` *with* the 2 listings.

**How it fails in production:** REA page 1 for a thin suburb renders its 2 on-target listings with `listings_total:2, totalResultsCount:104, pageSize:25`. minPerPage=5, so the gate fires: `metaOK && 2>0 && 2<5 && 2<=2` → `finish(sweepComplete)` with `collected` empty. Verified by running the real sweep (overlay test against `reaPageWithMeta([]string{"a","b"},"2026",104,2,25)`): `status=complete listings=0 pages=1 blocks=0`. Downstream, `diffSuburb` sees `sweep.status==sweepComplete` and `seen={}`, so on the first such run every active listing in that suburb/portal gets missed_sweeps=1 and on the second consecutive run each is written as `delisted`/`withdrawn` — including the two listings the crawler literally just read off the page. The suburb then stays permanently withdrawn because the same gate fires every subsequent run.

**Suggested fix:** Populate `collected` (run the merge loop over `matched`) before returning, or simply drop the early return and let the walk fall through to the existing capped-complete tail at line 682, which already yields `sweepComplete` with the listings intact for `wantPages < softCap`. Add an assertion in `finishSweep` (or a test) that `sweepComplete` never carries 0 listings when page 1 matched >0.

**Verifier's confirmation:** CONFIRMED (blocker). Reproduced with a Go -overlay test against the real sweepSuburbSource in /Users/benebsworth/projects/.worktrees/shorted-hw-crawl-correctness (worktree unmodified; git status clean):

  thin-exhausted (listings_total=2, totalResultsCount=104, pageSize=25): status=complete listings=0 pages=1 blocks=0
  healthy        (listings_total=5, totalResultsCount=105, pageSize=25): status=complete listings=5 pages=1 blocks=0

Mechanism verified end to end:
- services/house-price-collector/crawl_listings.go:622-624 returns finish(sweepComplete) from inside the `page == 1 && len(matched) < minPerPage` gate (line 616). The merge loop that fills `collected` is at 646-654, BELOW it, and finish -> finishSweep(collected, ...) (line 784) builds sweep.listings from that map, so it is empty.
- The gate arithmetic guarantees the page DID render listings: onTargetResults > 0 && onTargetResults <= len(matched) implies len(matched) >= 1. So it reports "whole suburb seen, zero listings" for a page that just rendered 1-4 real on-target listings.
- crawl_listings_diff.go:100-131: status==sweepComplete with empty `seen` -> activeListingsForRegion (crawl_listings_store.go:231, WHERE source=$

---

### 2. [BLOCKER] F12 thin-suburb branch returns sweepComplete with an EMPTY listing set, arming the delist pass against nothing
**Where:** services/house-price-collector/crawl_listings.go:622-624

**What's wrong:** The new `stop-thin-page1-exhausted` branch returns `finish(sweepComplete)` at line 624, but `collected` is not populated until line 647 (`for _, m := range matched { collected[m.ListingID] = m }`), which is *below* it in the loop body. So the branch hands back `suburbSweep{listings: [], status: sweepComplete}` — the page-1 listings it just proved were genuine are discarded.

That matters because `sweepComplete` is the ONLY status that unlocks the delist pass: `crawl_listings_diff.go:102` runs `activeListingsForRegion` and marks every active listing not in `seen` as absent, delisting it once `missed_sweeps >= delistGrace` (default 2, `crawl_listings.go:111`). With `sweep.listings` empty, `seen` is empty, so EVERY active listing for that (source, suburb) is missed — including the very listings that rendered on page 1, which were never upserted so their `last_seen_at`/`missed_sweeps` are never reset.

This is a new reachable state: every other `sweepComplete` path (`stop-duplicate-page`, `stop-empty-page`, loop-bound `upgradeIfPageMetaConfirms`) requires `page > 1`, i.e. page 1's listings are already in `collected`. Before this change the same branch returned `sweepBlocked`, and `diffSuburb` returns early on `sweepBlocked` (touch nothing), so dropping the listings was harmless.

Secondary effect: `*blockCounter++` is skipped, so `blockedSweeps == 0` and `agentJobTerminal` (crawl_agent.go:870) banks the job as "succeeded" — the suburb is never re-queued, which is exactly the "never-attempted job banked as succeeded" silent-stoppage class this subsystem has been bitten by before.

Verified by running the real sweep against the branch's own fixture (`go test -overlay`, no repo files touched):
  lc.sweepSuburbSource(bondi, "rea", reaPageWithMeta(["a","b"], "2026", 104, 2, 25))
  -> status=complete listings=0 pages=1 blocks=0

The added test `TestSweep_PageClassificationMatrix` (crawl_listings_test.go:548+) asserts only `sw.status` and the block counter, never `len(sw.listings)`, so it passes with zero listings — unlike the neighbouring `TestSweep_CompleteOnEmptyPage`, which does assert `len(sw.listings) != 5`.

**How it fails in production:** REA reports listings_total=2 for a small suburb (e.g. a thin regional/inner-city SAL) and page 1 renders both on-target listings. minPerPage=5, so the outer thin-page test fires; metaOK && onTargetResults==2 && 2 < 5 && 2 <= len(matched)==2 -> the new branch returns sweepComplete with listings=[]. diffSuburb writes no listing rows (no first_seen/price events, last_seen_at not refreshed) and then runs the delist pass with an empty seen-set: all active REA rows for that region get missed_sweeps+1. After 2 consecutive runs (delistGrace=2) every one of them — including the 2 listings the crawler had just successfully rendered — gets markAbsent(delist=true) plus a 'delisted'/'withdrawn' price event. The job is reported to the brandbrain queue as 'succeeded' (blockedSweeps==0), so nothing re-crawls it.

**Suggested fix:** Move the `collected` population above the page-1 thin/exhausted branch (or populate `collected` from `matched` before returning), so `finish(sweepComplete)` carries the listings it just validated. Add `len(sw.listings)` assertions to the matrix test.

**Verifier's confirmation:** CONFIRMED by reading + running. crawl_listings.go:617-624 returns finish(sweepComplete) before `collected` is populated (line 647), so finishSweep (line 784) yields {listings: [], status: complete}. Reproduced with the branch's own fixture via a temp-dir `go test -overlay` (no repo files touched): sweepSuburbSource(bondi,"rea",reaPageWithMeta(["a","b"],"2026",104,2,25)) -> status=complete listings=0 pages=1 blocks=0; control with 5 on-target -> listings=5, so the loss is specific to this branch.

Reachability of the harm verified: diffSuburb (crawl_listings_diff.go:20) returns early only on sweepBlocked (line 21); with empty listings the upsert loop is skipped (no first_seen, last_seen_at/missed_sweeps never reset) and line 102 then runs activeListingsForRegion(source, region_code) (store line 231) marking every active row absent, delisting at missed >= delistGrace (default 2, crawl_listings.go:111) with a delisted/withdrawn price event.

The "new state" claim is correct: every other sweepComplete producer implies non-empty collected — stop-duplicate-page / stop-empty-page are page>1 gated; stop-broadening / stop-yield-decay go through sweepPoisonVerdict (line 845, requires collect

---

### 3. [MAJOR] F35 projection allowlists field NAMES but passes VALUES through verbatim — an arbitrary string (address/agent/listing id/raw HTML) still crosses to brandbrain
**Where:** services/house-price-collector/crawl_brandbrain.go:128, 194-201

**What's wrong:** `walkBrandbrainAggregates` copies `child` unchanged into the outbound contract (line 128) whenever `brandbrainAggregateName(key) != ""` and `isBrandbrainAggregateScalar(child)` is true — and `isBrandbrainAggregateScalar` (line 194) accepts `string` and `bool`, unbounded in length and content. Name matching is fuzzy `strings.Contains` (lines 171-191): any key containing `median`+`price` (and not `rent`), or `daysonmarket`, `rentalyield`, `clearance`+`rate`, `annualgrowth`, `pricegrowth`, matches — so `medianPriceDisclaimer`, `medianSoldPriceCommentary`, `daysOnMarketBlurb`, `medianPriceWidgetHtml` all qualify, anywhere in any script blob on the page, at any nesting depth (including inside per-listing objects and inside JSON-in-string values).

So the boundary is a key allowlist with a value passthrough, not a value allowlist. Verified against the built code (`go test -overlay`, nothing written to the repo):

  input:  {"suburbProfile":{"medianPriceNote":"Sold by Jane Agent of 12 Smith St for $2,100,000","daysOnMarketLabel":"listing-id-99887 at 4 Ocean Rd"}}
  output: {"aggregate_fields":[{"name":"days_on_market","value":"listing-id-99887 at 4 Ocean Rd"},{"name":"median_sale_price","value":"Sold by Jane Agent of 12 Smith St for $2,100,000"}]}

Every one of the five categories the change claims cannot cross (address, price, listing id, agent, raw HTML) crossed in that one call.

The added test `TestBrandbrain_ExtractRealEstate_SendsAggregateOnlyPayload` (crawl_brandbrain_test.go:97+) only checks a fixed list of forbidden literals against one synthetic fixture in which the private data sits under NON-matching keys (`listing.address`, `listing.agent.name`, `vendorSecret`). It therefore cannot catch this class at all: it never exercises a string value under an allowlisted name.

Note the downstream consumer needs none of this: every field of `reaListing` (crawl_brandbrain.go:61-68) is `float64`, and the count fields are integers, so admitting `string`/`bool` buys nothing while widening the contract.

The CLAUDE.md (line ~493) and docs/housing-architecture.md (line 250) sentences added by this same commit — "raw portal HTML, listing IDs, addresses, prices and agents stay on the rig" — therefore assert a guarantee the code does not enforce.

**How it fails in production:** REA/Domain ships (or A/B-tests) a suburb-profile key whose name fuzzy-matches the allowlist but whose value is prose or markup — e.g. `medianPriceDisclaimer: "Based on 3 sales incl. 12 Smith St, sold by Jane Agent of Ray White for $2.1m"` or `medianPriceWidgetHtml: "<div class=...>...</div>"`. `brandbrainMediansPayload` emits it as `{"name":"median_sale_price","value":"<that whole string>"}` and `extractRealEstate` POSTs it to api.brandbrain.dev. Address, agent name, an asking price and raw HTML leave the rig, in the exact tier the change was written to seal. No test fails.

**Suggested fix:** Restrict `isBrandbrainAggregateScalar` to `float64` (parse money strings locally with the existing `parseMoney`/`toMoney` before emitting), or clamp string values to a numeric/enum shape plus a hard length cap. Add a table-driven test whose cases put hostile strings UNDER allowlisted names, and prefer exact key matching over `strings.Contains`.

**Verifier's confirmation:** CONFIRMED — mechanism reproduced against the built code; the reviewer did not misread it, and no guard exists elsewhere in the diff.

Reproduction (go test -overlay, nothing written to the repo; `git status --porcelain` clean before and after) in /Users/benebsworth/projects/.worktrees/shorted-hw-crawl-correctness/services/house-price-collector:

  in : <script type="application/json">{"suburbProfile":{"medianPriceNote":"Sold by Jane Agent of 12 Smith St for $2,100,000","daysOnMarketLabel":"listing-id-99887 at 4 Ocean Rd","medianPriceWidgetHtml":"<div class=\"x\">raw markup</div>","clearanceRateFlag":true}}</script>
  out: {"aggregate_fields":[{"name":"clearance_rate","value":true},{"name":"days_on_market","value":"listing-id-99887 at 4 Ocean Rd"},{"name":"median_sale_price","value":"Sold by Jane Agent of 12 Smith St for $2,100,000"},{"name":"median_sale_price","value":"<div class=\"x\">raw markup</div>"}]}

Also reproduced with the hostile string nested INSIDE a per-listing object (`results.exact.items[0].medianSoldPriceCommentary`) — it crossed, while the sibling `address`/`agent.name` keys on the same object did not. Address, agent, an asking price and raw markup all crossed in o

---

### 4. [MINOR] The new thin-suburb gate is unreachable for the dominant REA thin-suburb shape (page-1 broadening trips the poison gate first)
**Where:** services/house-price-collector/crawl_listings.go:603-615 vs 616-628

**What's wrong:** The poison gate at line 603 (`mismatch > 0.30`) runs before the new thin-page-1 gate at 616. For a genuinely thin REA suburb, page 1 is a 25-row SRP containing the suburb's 2-3 on-target rows plus ~22 broadened surrounding-suburb rows — mismatch ≈0.92 — so `sweepPoisonVerdict(page=1, collected=0, minPerPage)` returns `sweepBlocked` (crawl_listings.go:845-850, early page ⇒ blocked) and control never reaches the new `listings_total` check. F12's stated goal ("classify thin suburbs from on-target page metadata rather than treating a small page-1 result as a Kasada block") is therefore not achieved for the broadened case, even though `PageMeta.OnTargetResults` is present and would prove exhaustion.

**How it fails in production:** REA page 1 for Bondi returns 2 on-target listings (postcode 2026) + 23 broadened rows (postcode 9999) with `listings_total:2, pageSize:25`. Verified by running the real sweep: `status=blocked listings=0 pages=1 blocks=1` — identical to pre-diff behaviour, breaker still incremented, no delist safety gained. Only the narrow case where the portal returns *only* the thin on-target set (mismatch 0) reaches the new gate — which is the case that hits the blocker above.

**Suggested fix:** If PageMeta confirms `OnTargetResults <= len(matched)` on page 1, consult that evidence inside/before the poison gate (a page whose on-target count matches the portal's own on-target total is exhaustion, not page-1 poison) rather than after it.

**Verifier's confirmation:** CONFIRMED, severity minor (unchanged). Code-path claim is exactly right and I reproduced the reviewer's result byte-for-byte.

ORDERING VERIFIED (/Users/benebsworth/projects/.worktrees/shorted-hw-crawl-correctness/services/house-price-collector/crawl_listings.go): poison gate `if mismatch > 0.30` at line 603; new thin-page-1 check at line 622 inside the `page == 1 && len(matched) < minPerPage` branch at 616. `sweepPoisonVerdict` (line 845) returns sweepPartial only for `page > 1 && collectedMatched >= minPerPage`, so on page 1 with `collected` empty it always returns sweepBlocked -> `finish(sweepBlocked)` at 614 and line 616 is unreachable. The whole crawl_listings.go delta is +9/-0, entirely inside that branch, so no guard elsewhere in the diff was missed.

REPRODUCED (ran real sweepSuburbSource via `go test -overlay=` with a temp test file; worktree never modified, `git status` clean):
  2 on-target + 23 broadened rows, listings_total:2 pageSize:25 -> status=blocked listings=0 pages=1 blocks=1  (identical to the reviewer's claim)
  2 on-target + 0 off                                        -> status=complete listings=0 pages=1 blocks=0
  3 on-target + 1 off (mismatch .25)        

---

### 5. [MINOR] The aggregate projection collapses distinct median keys to 3 canonical names, so a historical/neighbouring median can be stored as this quarter's suburb median
**Where:** services/house-price-collector/crawl_brandbrain.go:148-190 (`brandbrainAggregateName`) + 322-350 (`brandbrainObservations`)

**What's wrong:** `brandbrainMediansPayload` walks every JSON blob on the page and emits `{name, value}` pairs, where `name` is derived purely from the key: any key containing `median`+`price` (and not `rent`) becomes `median_house_price` / `median_unit_price` / `median_sale_price`. The original key, the DOM position, and any surrounding suburb/period context are discarded; entries are deduped only by (name, value), so N distinct medians on the page arrive as N indistinguishable `median_house_price` entries with `SuburbHint` as the only context. `crawl_extract.go:12-17` and `robustMedian` (crawl_validate.go:60-77) document that a portal page carries *multiple* median candidates on purpose — the local legacy extractor defends against that by taking the median of survivors, but the brandbrain path uses `firstNonZero` (crawl_brandbrain.go:353) and stamps the result with `Period: currentQuarterEnd()`. Previously the LLM at least received the full page and could use structure to pick the right one; after this change no such signal exists. `validateMedian` only checks absolute bounds + a 0.15-8x capital band, which an adjacent-suburb or last-year median passes trivially. (Impact is contained because `-mode crawl` is opt-in and never scheduled — main.go:61-68.)

**How it fails in production:** A REA/Domain suburb page carries `medianPrice: 1,850,000` (current) and `medianSoldPriceLast12Months: 1,620,000` (historical) — or a `medianPrice` for a nearby-suburb insights module. Both normalize to `median_house_price` and are emitted as two separate `aggregate_fields` entries with no qualifier. The extractor returns whichever it saw first; `firstNonZero` takes it, `validateMedian` passes (in-band), and it is written to `house_prices` as the suburb's `median_price/house` for `currentQuarterEnd()` with source `brandbrain_rea`.

**Suggested fix:** Carry the original key (and any sibling suburb/period label) alongside the canonical name in `brandbrainAggregateField`, or refuse to emit a median field when more than one distinct value maps to the same canonical name.

**Verifier's confirmation:** Real regression, correctly diagnosed, with two small citation errors and stronger evidence than the reviewer had.

VERIFIED MECHANISM: brandbrainAggregateName (crawl_brandbrain.go:148-192) collapses by substring only. Ran the function standalone: medianHousePrice, previousMedianHousePrice, medianHousePrice12MonthsAgo, nearbySuburbMedianHousePrice and medianPriceHouse2019 all return "median_house_price". Dedup key is name+value (line 125), so N distinct page medians emit as N unlabelled entries; original key, DOM position, period and neighbouring-suburb context are all discarded. Downstream is as described: firstNonZero (line 303, used 355) takes the first, validateMedian only enforces $100k-$50M plus the 0.15-8x capital band (crawl_validate.go:41-55), Period is stamped currentQuarterEnd() unconditionally (line 340), and crossCheck logs only above 30% divergence so a 12% wrong-vintage median is silent.

STRONGER THAN CLAIMED: brandbrain's ExtractRealEstate runs a deterministic path-precise pass FIRST, which its own header calls authoritative for suburb medians — extractArgonautMedians reads REA at marketProfileBySlug.insights.medianPrice.buy.{house,unit}.allBed.yearly, extractDomain

---

### 6. [MINOR] Doc edits land in a file that a parallel branch has already reduced to a redirect stub — the edits will conflict or be silently lost
**Where:** docs/housing-architecture.md:250, 280

**What's wrong:** This commit edits two paragraphs inside `docs/housing-architecture.md`. On the in-flight docs branch `docs/housing-feature-docs` (currently checked out in the primary worktree) that same file is already a 567-byte redirect stub whose body reads "This file is a redirect stub kept only so older links resolve — do not add content here", and the monolith has moved to `docs/feature/housing/architecture.md` (77KB). Both edited paragraphs exist there verbatim and UNEDITED, at `docs/feature/housing/architecture.md:262` ("fail-safe by design …") and `:292` ("crawlJobSummary: suburbs, listings, events, blocked_sweeps, needs_rewarm").

So whichever branch merges second either conflicts on those hunks or, if the stub-ifying delete wins, drops these two content edits entirely — and the new canonical doc keeps describing the pre-change brandbrain boundary.

**How it fails in production:** docs/housing-feature-docs merges first (it deletes ~77KB from docs/housing-architecture.md). This branch then merges: git reports a modify/delete-style conflict on both hunks, or a resolver takes the stub and the two paragraphs are lost. docs/feature/housing/architecture.md:262 and :292 continue to state that the medians tier hands brandbrain the rendered HTML, contradicting the shipped code.

**Suggested fix:** Re-apply the two paragraph edits to docs/feature/housing/architecture.md:262 and :292 (and drop the docs/housing-architecture.md hunks), or rebase onto docs/housing-feature-docs before merging.

**Verifier's confirmation:** CONFIRMED — every factual claim checks out, and the conflict is empirically proven rather than predicted.

EVIDENCE
1. Branch is real and in-flight: `docs/housing-feature-docs` (commit 259c2ba22, 2026-08-09) is checked out in the primary worktree /Users/benebsworth/projects/shorted, exactly 1 commit ahead of origin/main. It is UNPUSHED (`git ls-remote --heads origin | grep housing-feature-docs` → no match) with no open PR (`gh pr list` shows only #408, #292, #104, #103). That is the strongest refutation angle and it FAILS: the same commit adds `.claude/housing-program/crawl-correctness.md` — the dispatch spec that produced the very branch under review — so both branches are products of one active program.
2. Stub confirmed: `git show docs/housing-feature-docs:docs/housing-architecture.md | wc -c` = 567 bytes, body ends "This file is a redirect stub kept only so older links resolve — do not add content here." Monolith moved to docs/feature/housing/architecture.md (78,858 bytes). origin/main still carries the 77,529-byte monolith and has no docs/feature/housing/ tree.
3. Line numbers are exact: sed -n '258,266p' puts the "fail-safe by design…" paragraph at line 262; sed -n '288,296p'

---

### 7. [MINOR] The 'nothing forwarded to brandbrain' assertion is now unreachable, and an empty projection still burns the full 3-attempt RPC with no distinguishing log
**Where:** services/house-price-collector/crawl_playwright_test.go:97

**What's wrong:** `brandbrainMediansPayload` (crawl_brandbrain.go:92) always returns at least `{"aggregate_fields":[]}` — confirmed by dumping the payload — so `req.HTML` can never be the empty string. The orchestration test's guard `if req.HTML == "" { t.Errorf("brandbrain: empty aggregate projection forwarded") }` therefore can no longer fire, and the coverage it used to provide (the fetcher forwarded nothing) is gone.

The production side has the same blind spot: `extractRealEstate` marshals and POSTs unconditionally, so total key-schema drift on REA/Domain yields a zero-field contract sent per source per suburb through the 3-attempt / 90s-timeout client, and the only downstream signal is `cr.stats.rejected++` in crawlSource — indistinguishable from "the LLM found nothing on a real page".

**How it fails in production:** REA renames its ArgonautExchange keys so no key matches the allowlist. Every `-mode crawl` suburb POSTs `{"aggregate_fields":[]}` to api.brandbrain.dev (2 requests/suburb, retried on 5xx), the extractor returns nothing, `cr.stats.rejected` climbs, and no log line says the local projection was empty rather than the extraction. The unit suite stays green because the only assertion that could have caught an empty forward is now dead code.

**Suggested fix:** Skip the RPC (and log once) when the projection yields zero aggregate fields, and change the test guard to assert the decoded contract has at least one aggregate_fields entry rather than comparing req.HTML to "".

**Verifier's confirmation:** Verified in /Users/benebsworth/projects/.worktrees/shorted-hw-crawl-correctness.

1) Dead assertion — CONFIRMED. services/house-price-collector/crawl_brandbrain.go:93 initialises `contract := brandbrainMediansContract{AggregateFields: []brandbrainAggregateField{}}` (non-nil empty slice) and line 106 marshals unconditionally; a standalone marshal of the identical struct yields `{"aggregate_fields":[]}` (23 bytes, err=nil). Marshal cannot fail — values come from json.Unmarshal into `any` and are gated to float64/string/bool by isBrandbrainAggregateScalar, so no NaN/Inf. goquery parse failure also falls through to the same marshal. Therefore extractRealEstateReq.HTML is never "", and the guard at crawl_playwright_test.go:96-98 is unreachable in all five brandbrainServer call sites.

2) Lost coverage — CONFIRMED empirically. `go test -run TestCrawlSuburb_RoutesBothSourcesToBrandbrain` PASSES with the script-free fixtures at crawl_playwright_test.go:110-111, i.e. an empty projection is forwarded twice and nothing complains. All non-skipped orchestration fixtures (110-111, 197-199, 219-220, 315-316) are script-free; the only realistic-HTML orchestration test (TestCrawlSource_WithRealFixt

---

