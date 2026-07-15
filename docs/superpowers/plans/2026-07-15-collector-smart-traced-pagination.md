# PR-2: Collector Smarter + Traceable Pagination — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Make the `house-price-collector` page-walker read the portal's own result count to size each sweep exactly (fewer requests, no truncation, delist-safe), stop early on yield decay, dedupe better, pace/cap adaptively, checkpoint/resume — plus a triggerable debug-trace mode capturing per-page screenshots + a decision trace.

**Architecture:** All changes are in `services/house-price-collector`. The sweep loop `sweepSuburbSource` (crawl_listings.go) gains a `pageMeta` (parsed once per page from the same blob `extractListings` already walks) that bounds pagination and upgrades a capped-complete sweep to `sweepComplete`. Trace mode is an orthogonal, off-by-default writer that the sweep emits per-page records to and the CDP fetcher screenshots into. brandbrain still only ever gets counts-only summaries; trace artifacts stay local.

**Tech Stack:** Go 1.x, goquery, playwright-go (CDP), pgx. Repo worktree: `/Users/benebsworth/projects/shorted-housing`.

**Test command baseline (run from `services/house-price-collector`):**
`rtk proxy go build ./... && rtk proxy go test -count=1 . && golangci-lint run --concurrency 1 --timeout 120s ./`
(errcheck is enforced — always `defer func(){ _ = x.Close() }()`.)

---

### Task 1: Phase-0 — confirm the portal result-count key paths (discovery)

Blocking gate for Tasks 2-3. Must run AFTER the corpus crawl frees the warm Chrome (else it doubles IP load). Uses the existing CDP path (a guarded live test, like `crawl_qld_diag_test.go`).

**Files:** Create `crawl_pagemeta_diag_test.go` (guarded on `PAGEMETA_CDP_URL`).

- [ ] **Step 1:** Warm a Chrome (`--user-data-dir=$HOME/.shorted-crawl-chrome --remote-debugging-port=9335 "https://www.realestate.com.au/"`, settle 12s).
- [ ] **Step 2:** Write a guarded test that fetches ONE REA SRP (`New Farm` `reaSearchURL(1)`) and ONE Domain SRP, and writes the raw HTML to `/tmp/rea-srp.html` / `/tmp/domain-srp.html`.
- [ ] **Step 3:** Run it; then inspect the blobs for the result-count path:
  - REA: `python3 -c` to load `window.ArgonautExchange` → the urqlClientCache stringified JSON → find keys `totalResultsCount` / `pagination` / `pageSize`. **Expected path:** `…buySearch.results.pagination.{page,maxPageNumber}` and/or `results.totalResultsCount`.
  - Domain: `__NEXT_DATA__` → `props.pageProps` → find `totalPages` / `totalCount` / `pageSize` (near `componentProps`).
- [ ] **Step 4:** Record the CONFIRMED key paths + a captured minimal blob for each portal into `testdata/rea-pagemeta.json` and `testdata/domain-pagemeta.json` (trimmed to just the meta + 1-2 listings). These become the Task 2 fixtures.
- [ ] **Step 5:** Commit the diag test + fixtures. `git commit -m "test(house-crawl): phase-0 confirm REA/Domain SRP result-count key paths"`

If a portal exposes no reliable count, Task 2 returns `pageMeta{ok:false}` for it and the sweep falls back to today's behaviour for that source (documented, not a failure).

---

### Task 2: `extractPageMeta` — parse per-page pagination metadata

**Files:** Modify `crawl_listings_extract.go` (add `PageMeta` + `extractPageMeta`); Test `crawl_listings_extract_test.go`.

- [ ] **Step 1: Failing test** (uses the Task-1 fixtures):

```go
func TestExtractPageMeta_REA(t *testing.T) {
	html, _ := os.ReadFile("testdata/rea-pagemeta.json") // captured REA SRP
	doc, _ := goquery.NewDocumentFromReader(bytes.NewReader(html))
	m := extractPageMeta(doc, "rea")
	if !m.OK || m.TotalResults <= 0 || m.PageSize <= 0 {
		t.Fatalf("rea pagemeta = %+v", m)
	}
}
func TestExtractPageMeta_Domain(t *testing.T) { /* same shape, source "domain" */ }
func TestExtractPageMeta_Missing(t *testing.T) {
	doc, _ := goquery.NewDocumentFromReader(strings.NewReader("<html><body></body></html>"))
	if extractPageMeta(doc, "rea").OK { t.Fatal("empty page must yield OK=false") }
}
```

- [ ] **Step 2:** Run → FAIL (undefined `extractPageMeta`).
- [ ] **Step 3: Implement** `PageMeta{ OK bool; TotalResults int; TotalPages int; PageSize int }` + `extractPageMeta(doc *goquery.Document, source string) PageMeta`. Reuse the SAME blob-walk pattern as `extractListings` (walk `<script>` JSON, recurse stringified JSON) but scan for the CONFIRMED count keys (Task 1). Compute `TotalPages = ceil(TotalResults/PageSize)` when only count+size present. Return `OK:false` when neither found.
- [ ] **Step 4:** Run → PASS. Full suite green.
- [ ] **Step 5:** Commit.

---

### Task 3: total-count sizing + delist-safe classification in the sweep

**Files:** Modify `crawl_listings.go` (`sweepSuburbSource`, `fetchAndClassify` return, `finishSweep`); Test `crawl_listings_test.go`.

- [ ] **Step 1: Failing test** (fixture-driven `pagedFetcher`, extend the existing harness): a suburb whose page-1 meta says `TotalResults=6, PageSize=20` (→ 1 page) must fetch **only page 1** and classify `sweepComplete` (not walk to maxPages, not `sweepPartial`):

```go
func TestSweep_TotalCountSizesAndCompletes(t *testing.T) {
	p1 := domainPageWithMeta([]string{"a","b","c","d","e"}, "2026", /*total*/5, /*pageSize*/20)
	sw := sweepWith(map[string]string{ bondi.domainSearchURL(1): p1 }) // page 2 is the default empty page
	if sw.status != sweepComplete { t.Fatalf("1-page suburd must be complete, got %s", sw.status) }
	if sw.pages != 1 { t.Fatalf("must fetch exactly 1 page, got %d", sw.pages) }
}
```
(Add `domainPageWithMeta` helper embedding the confirmed Domain count keys.)

- [ ] **Step 2:** Run → FAIL (still walks / classifies partial).
- [ ] **Step 3: Implement:** thread `PageMeta` out of the per-page fetch/parse; after page 1 compute `wantPages = clamp(meta.TotalPages, 1, cfg.maxPages)`; loop to `min(wantPages, cfg.maxPages)`; when the loop reaches `wantPages` with no block/poison, return `sweepComplete` (delist-safe) instead of the page-cap `sweepPartial`. Keep `cfg.maxPages` a hard ceiling; when `meta.OK==false`, retain today's behaviour (walk to cap → partial). Preserve the existing duplicate-signature / empty-later-page / poison / broadening paths.
- [ ] **Step 4:** Run → PASS; existing sweep tests still green (esp. `TestSweep_BroadenedLatePageIsPartial`, `TestSweep_MismatchPoisonIsBlocked`, `TestSweep_PageCapIsPartial`).
- [ ] **Step 5:** Commit `feat(house-crawl): size sweeps by portal result-count; capped-complete sweeps delist-safe`.

---

### Task 4: stop-early on yield decay

**Files:** Modify `crawl_listings.go`; Test `crawl_listings_test.go`.

- [ ] **Step 1: Failing test:** page 1 = 5 real; page 2 = the SAME 5 ids reordered + 0 new (signature differs so the adjacent-sig check misses it) → sweep ends (`sweepComplete` since within wantPages) with only 5 collected.

```go
func TestSweep_StopsOnZeroNewIDs(t *testing.T) {
	p := domainPageHTML([]string{"a","b","c","d","e"}, "2026")
	pReordered := domainPageHTML([]string{"e","d","c","b","a"}, "2026") // same ids, diff signature
	sw := sweepWith(map[string]string{ bondi.domainSearchURL(1): p, bondi.domainSearchURL(2): pReordered })
	if len(sw.listings) != 5 { t.Fatalf("must not double count, got %d", len(sw.listings)) }
	if sw.status == sweepBlocked { t.Fatalf("reordered overlap is not a block") }
}
```

- [ ] **Step 2:** FAIL.
- [ ] **Step 3: Implement:** track `newThisPage` (ids added to `collected`); if `page>1 && newThisPage == 0` (or `< cfg.minNewPerPage`, default 1) end the sweep (`sweepComplete` if reached wantPages else `sweepPartial`). Keep a `seenAll` set for the overlap check.
- [ ] **Step 4:** PASS + suite green.
- [ ] **Step 5:** Commit.

---

### Task 5: stronger cross-page dedup (fieldScore-max merge)

**Files:** Modify `crawl_listings.go` (the `collected[m.ListingID]` merge); reuse `fieldScore` from `crawl_listings_extract.go`; Test `crawl_listings_test.go`.

- [ ] **Step 1: Failing test:** a thin page-1 row (price only) then a rich page-2 row (price+beds+address) for the SAME id → the merged listing keeps the RICH fields.
- [ ] **Step 2:** FAIL (first-wins keeps thin).
- [ ] **Step 3: Implement:** replace `if _, ok := collected[id]; !ok { collected[id]=m }` with a `fieldScore`-max merge (same rule `extractListings` uses intra-page). Extract a shared `mergeListing(dst, src)` helper if clean.
- [ ] **Step 4:** PASS + suite.
- [ ] **Step 5:** Commit.

---

### Task 6: adaptive page cap by suburb size

**Files:** Modify `crawl_targets.go` (optional `Dwellings int` hint) OR derive from ABS at load; `crawl_listings.go` (per-suburb soft cap); `crawl.go` config. Test `crawl_listings_test.go`.

- [ ] **Step 1: Failing test:** with `meta.OK==false` (no portal count), a suburb tagged large gets a soft cap > default and a tiny one gets a lower soft cap, both bounded by the hard ceiling.
- [ ] **Step 2:** FAIL.
- [ ] **Step 3: Implement:** a pure `softPageCap(dwellings, hardCeiling, defaultCap) int`; seed `dwellings` from ABS (the catalog is population-seeded; add a coarse band or read from suburb_demographics at load). Use `min(softCap, hardCeiling)` when `meta.OK==false`; Task-3's exact count wins when available.
- [ ] **Step 4:** PASS.
- [ ] **Step 5:** Commit.

---

### Task 7: adaptive pacing under block-risk

**Files:** Modify `crawl_listings.go` (`jitterSleep` bounds selection); Test `crawl_listings_test.go` (pure bound-selection helper).

- [ ] **Step 1: Failing test:** a pure `paceBounds(consecBlocks int, lastMismatch float64, base [lo,hi]) [lo,hi]` returns WIDER bounds after a blocked/high-mismatch page and the base bounds after a clean page.
- [ ] **Step 2:** FAIL.
- [ ] **Step 3: Implement** `paceBounds` (multiply bounds by a factor when `consecBlocks>0 || lastMismatch>0.30`, capped); call it to choose the page-delay bounds each iteration. Keep suburb-level pacing as-is.
- [ ] **Step 4:** PASS.
- [ ] **Step 5:** Commit.

---

### Task 8: checkpoint / resume cursor

**Files:** New `crawl_resume.go` (read/write per-(source,suburb) last-swept); Modify `crawl_agent.go`/`crawl_listings.go` to skip recently-swept; store helper in `store/`. Test `crawl_resume_test.go`.

- [ ] **Step 1: Failing test:** `shouldSkip(lastSweptAt, now, window)` returns true within the window, false outside; and a resume-set loader round-trips.
- [ ] **Step 2:** FAIL.
- [ ] **Step 3: Implement:** reuse `property_listings.last_seen_at` (max per suburb+source) as the "last swept" signal — a pure `shouldSkip(last, now, window)` (default `CRAWL_RESUME_WINDOW_H=20h`, 0 disables) + a query `lastSweptBySuburbSource(pool)`; in `-mode agent`/`-mode listings`, skip a source whose last sweep is within the window (log the skip; never silently). Env-gated OFF by default so existing behaviour is unchanged unless enabled.
- [ ] **Step 4:** PASS.
- [ ] **Step 5:** Commit.

---

### Task 9: debug-trace mode

**Files:** New `crawl_trace.go` (config + `traceWriter`); Modify `crawl_cdp.go` (screenshot hook when tracing), `crawl_listings.go` (emit per-page + summary records). Test `crawl_trace_test.go`.

- [ ] **Step 1: Failing test:** a `traceWriter` given a temp dir writes `trace.jsonl` (one record per `WritePage`) and `summary.json` (on `WriteSummary`) with the expected fields/paths; no-op when disabled.

```go
type tracePageRecord struct {
	Page int; URL string; Ms int64; Bytes int; Extracted, Matched int
	Mismatch float64; TotalResults, WantPages, NewIDs int; Outcome, Status, Decision string
}
```

- [ ] **Step 2:** FAIL.
- [ ] **Step 3: Implement:** `loadTraceConfig()` (`CRAWL_TRACE=1` or `CRAWL_TRACE_DIR`; optional `CRAWL_TRACE_SUBURB`); `newTraceWriter(dir, suburb, source)` creating `traces/<runId>/<suburb>-<source>/`; `WritePage(rec)`, `WriteHTML(page, html)`, `WriteScreenshot(page, png)`, `WriteSummary(sweep)`. In `sweepSuburbSource`, when tracing, write the per-page record (the exact smart-pagination signals) + HTML; the CDP fetcher exposes an optional `screenshot(page)` used when tracing to save `p{N}.png`. Off → zero overhead.
- [ ] **Step 4:** PASS. `go build`/lint clean. Add `traces/` + `*.png` to `.gitignore`.
- [ ] **Step 5:** Commit `feat(house-crawl): CRAWL_TRACE debug mode — per-page screenshots + decision trace`.

---

### Task 10: live-verify + docs

- [ ] **Step 1:** After the corpus crawl is idle: warm Chrome; run one DENSE suburb (e.g. Blacktown) and one TINY suburb through `-mode listings` (single-suburb) with `CRAWL_TRACE=1` — confirm: dense suburb fetches `wantPages` (not truncated), tiny suburb stops at 1 page, trace dir has screenshots + `trace.jsonl` + `summary.json`, and a capped-complete sweep classifies `sweepComplete`.
- [ ] **Step 2:** Update `services/house-price-collector/deploy/README.md` + `docs/housing-architecture.md` §6 with the smart-pagination behaviour + the `CRAWL_TRACE` debug workflow.
- [ ] **Step 3:** Commit docs. Open/update the shorted PR.

---

## Self-review notes
- Spec coverage: total-count sizing (T2-3), yield-decay (T4), dedup (T5), adaptive cap (T6), adaptive pacing (T7), checkpoint/resume (T8), trace mode (T9), live-verify+docs (T10). Phase-0 (T1) gates the extraction. All spec items covered.
- Boundary: no trace artifact is ever submitted to brandbrain (submit path unchanged — still counts-only `crawlJobSummary`).
- Back-compat: every new behaviour degrades to today's when `meta.OK==false` / resume disabled / trace off.
