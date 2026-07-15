# PR-1: brandbrain Agent — Real-estate Tab + Per-Suburb Results — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Give the brandbrain macOS agent a two-tab layout (**Brands | Real-estate**) and a view-only Real-estate results screen showing per-suburb parse outcomes + a queue-wide aggregate, by un-stripping the `result_summary` the backend already stores.

**Architecture:** Two layers. (1) Go runtime: the agent's `crawl_jobs_view.go` poller currently discards `result_summary`/timestamps and caps `recent` at 5; widen it + add a `totals` aggregate, surfaced in the existing `/control/v1/status` `crawl_jobs` block (no new endpoint). (2) SwiftUI: extend the decode models, add a `scannerTab` to `CrawlStore`, add a segmented `Picker` (mirroring `SettingsView`) to `MainPanelView`, and add a `RealEstateView`; move the inline real-estate section out of `ScannerView`.

**Tech Stack:** Go (backend/cmd/agent), Swift/SwiftUI (desktop/macos/BrandBrainAgent, a SwiftPM package). Worktree: the brandbrain worktree (a fresh branch off `origin/main`). brandbrain merge→main **auto-deploys the API**, but this PR only touches the agent runtime + desktop app (no server behaviour change); still, do NOT merge without review.

**Baselines:**
- Go: `cd backend && go build ./... && go test ./cmd/agent/... && go vet ./cmd/agent/...`
- Swift: `cd desktop/macos/BrandBrainAgent && swift build && swift test` (decode tests are XCTest; SwiftUI views are compile-checked + manually smoked).

---

### Task 0: branch off origin/main (isolate from stale local main)

- [ ] `git -C <bb-worktree> fetch origin && git -C <bb-worktree> checkout -b feat/agent-realestate-tab origin/main`
  (local `main` is stale/dirty; the crawl_jobs UI + repo are on origin/main.)

---

### Task 1: Go — widen `crawlJobView`, add `totals`, surface in status

**Files:** Modify `backend/cmd/agent/crawl_jobs_view.go`, `backend/cmd/agent/diag.go` (`crawlJobsInfo`); Test `backend/cmd/agent/crawl_jobs_view_test.go`.

- [ ] **Step 1: Failing test** — the poller must retain `result_summary` + timestamps and compute `totals`:

```go
func TestCrawlJobsView_KeepsResultSummaryAndTotals(t *testing.T) {
	// feed two terminal jobs (succeeded, with result_summary listings/events/blocked)
	view := buildCrawlJobsSummary(sampleJobs) // the function that maps backend DTOs → the cached view
	if view.Recent[0].ResultSummary == nil { t.Fatal("result_summary must survive") }
	if view.Totals.Listings != 243+156 || view.Totals.Events != 243+156 {
		t.Fatalf("totals = %+v", view.Totals)
	}
}
```

- [ ] **Step 2:** Run → FAIL.
- [ ] **Step 3: Implement:**
  - Widen `crawlJobView` (crawl_jobs_view.go:47-56) to add `ResultSummary *crawlResultSummary` (listings/events/blocked_sweeps/needs_rewarm/detail), `Error string`, `StartedAt/CompletedAt *string`, `Attempts int`, `Postcode string` — mapped from the backend list DTO the poller already fetches (stop dropping them).
  - Raise `crawlJobsRecentCap` 5 → 25.
  - Add `crawlJobsTotals{ SuburbsDone, Listings, Events, Blocked, RewarmNeeded int }` and compute it over the terminal jobs in the fetched list; store on the cached summary.
  - `crawlJobsInfo()` (diag.go) emits `recent` (widened) + `totals` + the existing `by_kind_status` in the `crawl_jobs` block.
- [ ] **Step 4:** Run → PASS; `go build ./... && go vet ./cmd/agent/...` clean; existing `TestCrawlJobCounts_*` / `TestBuildCrawlJobsSummary_*` still pass (adjust only for the new fields).
- [ ] **Step 5:** Commit `feat(agent): surface crawl_jobs result_summary + totals in /control/v1/status`.

---

### Task 2: Swift decode models

**Files:** Modify `desktop/macos/BrandBrainAgent/Sources/BrandBrainAgent/Models/RuntimeModels.swift`; Test the package's model-decode tests (e.g. `Tests/BrandBrainAgentTests/RuntimeModelsTests.swift`).

- [ ] **Step 1: Failing test** — decode a `/control/v1/status` fixture whose `crawl_jobs.recent[0]` carries `result_summary` + `crawl_jobs.totals`:

```swift
func testDecodesResultSummaryAndTotals() throws {
    let snap = try decode(ControlStatusSnapshot.self, from: statusWithCrawlResultsJSON)
    XCTAssertEqual(snap.crawlJobs?.recent?.first?.resultSummary?.listings, 243)
    XCTAssertEqual(snap.crawlJobs?.totals?.listings, 399)
}
```

- [ ] **Step 2:** FAIL.
- [ ] **Step 3: Implement:** add `struct CrawlResultSummary: Decodable { listings, events, blockedSweeps, needsRewarm, detail }` (CodingKeys → snake_case), extend `CrawlJobView` with `resultSummary`, `error`, `startedAt`, `completedAt`, `attempts`, `postcode` (all optional, snake_case keys); add `struct CrawlTotals` + `CrawlJobsSummary.totals`. Keep everything OPTIONAL so older runtimes still decode (preserve the hand-written defaulting init).
- [ ] **Step 4:** `swift test` → PASS; `swift build` clean.
- [ ] **Step 5:** Commit.

---

### Task 3: `CrawlStore.scannerTab`

**Files:** Modify `Sources/BrandBrainAgent/State/CrawlStore.swift`.

- [ ] **Step 1:** Add `enum ScannerTab: String, CaseIterable { case brands, realEstate }` + `var scannerTab: ScannerTab = .brands` on `CrawlStore` (an `@Observable`). (No test — trivial state; covered by the view compile + smoke.)
- [ ] **Step 2:** `swift build` clean.
- [ ] **Step 3:** Commit.

---

### Task 4: `MainPanelView` — segmented tab picker

**Files:** Modify `Sources/BrandBrainAgent/Views/MainPanelView.swift`.

- [ ] **Step 1:** In the `.scanner` branch of `content`, wrap the scanner in a VStack whose top is a `Picker("", selection: $crawlStore.scannerTab)` with `.pickerStyle(.segmented)` (two segments "Brands" / "Real-estate"), mirroring `SettingsView`'s picker. Below it, `switch crawlStore.scannerTab { case .brands: ScannerView(...); case .realEstate: RealEstateView(...) }`. Only show the picker on `.scanner` (not report/progress/etc).
- [ ] **Step 2:** `swift build` clean (RealEstateView stubbed as `Text("…")` until Task 5, or implement Task 5 first — recommended order is 5 then 4).
- [ ] **Step 3:** Commit.

---

### Task 5: `RealEstateView`

**Files:** Create `Sources/BrandBrainAgent/Views/RealEstateView.swift`.

- [ ] **Step 1: Build the view** reading `controlStore.runtimeStatus?.crawlJobs`:
  - **Empty state:** `crawlJobs == nil` → "Waiting for the crawl runtime…" placeholder.
  - **Error banner:** `crawlJobs.error` → the existing house.fill orange treatment.
  - **Header:** the queue tallies pill (Queued/In progress/Done via `counts(kind:"housing")`) + an aggregate row from `totals` (Σ suburbs · Σ listings · Σ events · blocked N · re-warm N) using the capsule-pill style.
  - **List:** `ScrollView` of up to 25 `crawlJobs.recent` rows: suburb+state, `listings/events` (from `resultSummary`), status badge (`crawlStatusBadge`), a blocked/re-warm chip when set, relative timestamp; failed rows tinted, showing `error`. Tapping toggles an inline `DisclosureGroup`/expand showing full `resultSummary` + `error` + started/completed + attempts.
- [ ] **Step 2:** `swift build` clean.
- [ ] **Step 3:** Commit `feat(agent): Real-estate results view (per-suburb parse outcomes + aggregate)`.

---

### Task 6: `ScannerView` — extract Brands, drop the inline RE section

**Files:** Modify `Sources/BrandBrainAgent/Views/ScannerView.swift`.

- [ ] **Step 1:** Remove the `realEstateCrawlSection` invocation + its private computed view (now owned by `RealEstateView`). `ScannerView` becomes the Brands tab body only (`scanInputSection` + `recentScansSection`). Keep the `.onAppear` 3s status timer (both tabs benefit from fresh `crawlJobs`).
- [ ] **Step 2:** `swift build` clean; brand-discovery behaviour unchanged.
- [ ] **Step 3:** Commit.

---

### Task 7: build, smoke, docs

- [ ] **Step 1:** `swift build` + `swift test` green; `cd backend && go test ./cmd/agent/...` green.
- [ ] **Step 2:** Run the agent against a live runtime that has crawl_jobs; screenshot both tabs (Brands unchanged; Real-estate showing aggregate + per-suburb rows + an expanded detail). Confirm the tab persists across the 5s poll.
- [ ] **Step 3:** Note in the brandbrain agent README/DROPLET pointer that v1.7 adds the Real-estate tab + results. Open the brandbrain PR (base main; ⚠️ merge auto-deploys the API image even though only the agent changed — leave merge to the user).

---

## Self-review notes
- Spec coverage: tabs (T3-4,6), results view (T5), Go widening + totals (T1), Swift models (T2). All A+B spec items covered.
- Boundary: read-only; no new server behaviour; the API deploy is unchanged (only the agent poller view + desktop app change).
- Back-compat: all new Swift fields optional; older runtimes (no `totals`/`result_summary`) still decode; `crawl_jobs==nil` handled.
- Recommended task order: 0,1,2,3,5,4,6,7 (build RealEstateView before wiring it into the picker).
