# brandbrain agent: real-estate tabs + per-suburb results + smarter, traceable pagination

**Date:** 2026-07-15
**Status:** design (approved direction, pending spec review)

## Goal

Make the real-estate crawl a first-class surface in the brandbrain macOS agent, and
make the collector's page-walking smart and debuggable:

1. **Tabs** — split the agent panel into two tabs, **Brands** | **Real-estate**
   (today real-estate is a cramped inline ≤3-row section inside the brand scanner).
2. **Processing results** — show per-suburb crawl outcomes (listings/events parsed,
   blocked/re-warm, timing, errors) + a queue-wide aggregate. The data already exists
   in the backend; it is stripped before it reaches the UI.
3. **Smarter pagination** — read the portal's own result-count to size each sweep
   exactly, stop early on yield decay, dedupe better, pace/cap adaptively, and
   checkpoint/resume — **plus a triggerable debug-trace mode** that captures per-page
   screenshots + structured logging + a decision trace, so collection can be
   inspected and tuned against live REA/Domain.

## Architecture — 3 workstreams, 2 PRs

| PR | Repo | Workstreams |
|----|------|-------------|
| **PR-1** | `brandbrain` | **A** (tabs, SwiftUI) + **B** (results: Go control-API widening + SwiftUI results view) |
| **PR-2** | `shorted` | **C1** (smarter pagination) + **C2** (debug-trace mode), in the `house-price-collector` |

The two PRs are independent (different repos, no shared code) and can be reviewed/merged
separately. PR-1 makes today's stored-but-hidden data visible; PR-2 improves + instruments
what the collector actually does.

### Invariant preserved
brandbrain still receives **counts-only** `result_summary` — no listing rows, addresses,
prices, or screenshots ever cross to brandbrain. The trace artifacts (C2) are **local to
the collector rig** (like the listings corpus itself); they are an operator debug tool, not
queue data. The agent's results view (B) shows only the counts-only `result_summary` that
already flows through the queue.

---

## Workstream A — Tabs (brandbrain SwiftUI)

**Current:** `MainPanelView` (420×600 menu-bar window) routes on a hand-rolled
`CrawlStore.ActiveView` enum. The default `.scanner` view is `ScannerView`, which stacks the
brand `scanInputSection` + `recentScansSection` ("Brand discovery") + an inline
`realEstateCrawlSection` (≤3 rows, read-only). No `TabView`; `SettingsView` already uses a
segmented `Picker` bound to a `Tab` enum — the pattern to reuse.

**Design:**
- Add a two-value tab selector to the `.scanner` screen: a segmented `Picker` ("Brands" |
  "Real-estate") at the top of the scanner content (in `MainPanelView.content` or a new
  `ScannerTabsView` wrapper), styled like `SettingsView`'s picker.
- Persist the selection as a serializable enum on `CrawlStore`
  (`enum ScannerTab: String { case brands, realEstate }`, `var scannerTab`) so it survives
  view rebuilds and the 5s/3s status polls; default `.brands`.
- **Brands tab** = the existing `scanInputSection` + `recentScansSection` (unchanged
  behaviour: scan input, brand-discovery history, tap→report).
- **Real-estate tab** = a new `RealEstateView` (workstream B). Remove the inline
  `realEstateCrawlSection` from the brand scroll.
- The Settings gear + back-chevron in `toolbar` stay; only `.scanner` shows the tab picker.

**Files:** `Views/MainPanelView.swift`, `Views/ScannerView.swift` (extract the two
sections), `State/CrawlStore.swift` (add `scannerTab`), new `Views/RealEstateView.swift`.
No new `ActiveView` case needed (tabs live inside `.scanner`); a full-screen per-suburb
**detail** may add one optional `ActiveView.crawlSuburb(String)` case (see B).

---

## Workstream B — Real-estate processing results (brandbrain Go + SwiftUI)

**Current data flow:** the collector submits a counts-only `result_summary`
(`suburbs, listings, events, blocked_sweeps, needs_rewarm, detail`) + `error` per job; the
backend stores it (`crawl_jobs.result_summary` JSONB + `error_message`, `started_at`,
`completed_at`, `attempts`) and returns it in full via `GET /api/v1/agent/crawl-jobs`
(`crawlJobDTO`). **But** the agent's `crawl_jobs_view.go` re-decodes that into a stripped
`crawlJobView` (id/kind/suburb/state/source/tier/status/updated_at only), caps `recent` at
5, and `SummarizeCrawlJobs` only counts rows by kind+status. So `/control/v1/status` carries
none of the parse results.

**Design (Go — `backend/cmd/agent/crawl_jobs_view.go` + `diag.go`):**
- Widen `crawlJobView` to carry the parse result: add `result_summary` (the counts object:
  listings/events/blocked_sweeps/needs_rewarm/detail), `error`, `started_at`,
  `completed_at`, `attempts`, `postcode`. Populate it from the backend list DTO the poller
  already fetches (stop discarding those fields).
- Raise `crawlJobsRecentCap` 5 → 25 so the results list is useful.
- Add a queue-wide **aggregate** over recent/terminal jobs: `totals { suburbs_done,
  listings, events, blocked, rewarm_needed }` (sum the `result_summary` counts). Compute it
  in the poller (from the list it already fetches) so `/control/v1/status` carries it in the
  `crawl_jobs` block (`crawl_jobs.totals`). `SummarizeCrawlJobs`'s by-kind-status counts stay
  for the queue tallies.
- (No new control endpoint required — everything rides the existing
  `/control/v1/status` `crawl_jobs` block. The 25-item widened `recent` + `totals` is enough
  for the results view. If a deeper history is wanted later, add
  `GET /control/v1/crawl-jobs` forwarding the backend list; out of scope for this pass.)

**Design (SwiftUI — `Models/RuntimeModels.swift` + `Views/RealEstateView.swift`):**
- Extend `CrawlJobView` with `resultSummary: CrawlResultSummary?` (new struct: listings,
  events, blockedSweeps, needsRewarm, detail), `error`, `startedAt`, `completedAt`,
  `attempts`, `postcode`. Add `CrawlJobsSummary.totals: CrawlTotals?`.
- `RealEstateView` layout:
  - **Header** — queue tallies (Queued N · In progress N · Done N, existing) + the new
    aggregate (Σ suburbs · Σ listings · Σ events · blocked N · re-warm N), plus the
    offline/`error` banner (reuse the existing house.fill treatment) and a "waiting for
    runtime" empty state when `crawlJobs == nil`.
  - **List** — recent per-suburb rows (up to 25): suburb + state, `listings/events` parsed,
    a status badge (reuse `crawlStatusBadge`), a blocked/re-warm chip when set, relative
    timestamp. In-progress rows show a spinner; failed rows tint red and show the error.
  - **Detail (optional, recommended)** — tap a row to expand inline (or push
    `ActiveView.crawlSuburb`) showing the full `result_summary` + `error` + started/completed
    + attempts. Keep it inline-expand first (simplest); full-screen only if it feels cramped.

**Files:** `backend/cmd/agent/crawl_jobs_view.go`, `backend/cmd/agent/diag.go`
(`crawlJobsInfo`), `Models/RuntimeModels.swift`, new `Views/RealEstateView.swift`,
`Views/ScannerView.swift` (remove inline section). Go + Swift unit tests for the widened
decode + aggregate.

---

## Workstream C1 — Smarter pagination (shorted collector)

**Current:** `sweepSuburbSource` (crawl_listings.go) walks `page 1..maxPages(5)` with fixed
jitter, collecting first-wins into a map, stopping on breaker/block/error/poison/thin-page-1/
duplicate-signature/empty-later-page/page-cap. It reads **no** portal pagination metadata; a
capped sweep is always `sweepPartial` (so delisting never fires on big suburbs), and a
1-page suburb still costs up to 5 fetches. Full scope was approved.

**Phase-0 (blocking, cheap):** dump one live REA SRP blob + one live Domain SRP blob (via the
warm Chrome I already run) and confirm the exact key paths for the total-result count / total
pages / page size (expected: REA `ArgonautExchange → …exchangeState → results.totalResultsCount`
+ `pagination{page,pageSize}`; Domain `__NEXT_DATA__ → props.pageProps.componentProps`
`totalPages`/`totalCount`/`pageSize`). Everything below keys off these confirmed paths.

1. **Total-count sizing.** In `extractListings` (or a sibling `extractPageMeta`), during the
   same blob walk, read `totalResults`/`totalPages`/`pageSize` and return a `pageMeta` on the
   fetch result. `sweepSuburbSource` computes `wantPages = clamp(ceil(total/perPage), 1,
   maxPagesCeiling)` after page 1 and loops to `wantPages` instead of a flat 5. Wins: 1-page
   suburbs stop after 1 fetch; big suburbs aren't truncated; and a sweep that reached
   `wantPages` with no block is `sweepComplete` (delist-safe) instead of `sweepPartial`.
   Keep `maxPages` as a hard ceiling.
2. **Stop-early on yield decay.** Track new-IDs-added-to-`collected` per page; end the sweep
   (`sweepComplete` if we've reached `wantPages`, else `sweepPartial`) when a page contributes
   0 (or `< k`) new IDs even if its signature differs — catches reordered/overlapping tail
   pages the adjacent-`pageSignature` check misses.
3. **Stronger cross-page dedup.** Replace first-wins with the `fieldScore`-max merge
   `extractListings` uses internally (a thin page-1 row is upgraded by a richer page-2 row),
   and keep a rolling all-IDs-seen set for overlap-based end detection.
4. **Adaptive page cap by suburb size.** Seed a per-suburb soft cap from ABS
   population/dwelling count (already in `crawlTargets`) and/or the prior run's page count, so
   dense suburbs aren't truncated and tiny ones aren't over-fetched — bounded by the hard
   ceiling and refined by (1)'s exact count when available.
5. **Adaptive pacing under block-risk.** Feed the consecutive-block counter + high-mismatch
   signal into the `jitterSleep` bounds: widen delay after any blocked/poison page, tighten
   after clean pages — lower block rate without globally slowing clean suburbs.
6. **Checkpoint/resume.** Persist a per-(source,suburb) `last_swept_at` (reuse
   `property_listings.last_seen_at` / a small run-cursor) so an aborted/re-warm-interrupted
   run resumes mid-catalog and skips suburbs swept within N hours — also spreads the catalog
   over time to look more human.

**Files:** `crawl_listings.go` (loop, `sweepSuburbSource`, `finishSweep`, verdict, pacing),
`crawl_listings_extract.go` (`extractPageMeta`), `crawl_listings_targets.go`,
`crawl.go`/`loadListingsConfig` (config), plus store helpers for the resume cursor. Unit
tests: page-meta extraction (from a captured fixture), `wantPages` sizing + `sweepComplete`
classification, yield-decay stop, fieldScore merge, resume-skip.

---

## Workstream C2 — Debug/trace mode (shorted collector)

A triggerable trace that captures, per sweep, **screenshots + structured logging + a decision
trace**, so collection can be inspected and improved against live portals. Local-only.

**Trigger:** `CRAWL_TRACE=1` (or `CRAWL_TRACE_DIR=<path>`, default `~/.shorted-housing-crawl/
traces/`). Off by default (zero overhead). Optionally scope to one suburb via
`CRAWL_TRACE_SUBURB=<slug>` to trace a single problem suburb without flooding disk.

**What it captures**, written to `traces/<runId>/<suburb>-<source>/`:
- **Screenshots** — after each page navigation, `page.Screenshot()` of the rendered SRP
  (`p{N}.png`). Requires the CDP fetcher (`crawl_cdp.go`) to expose a screenshot hook when
  tracing is on (the `fileFetcher`/fixture path is a no-op).
- **Raw HTML** — the fetched blob per page (`p{N}.html`) for offline re-parsing.
- **Decision trace** — a `trace.jsonl`, one record per page: `{page, url, ms, bytes,
  extracted, matched, mismatch, totalResults, wantPages, newIDs, outcome, status,
  decision}` — exactly the signals the smart-pagination logic uses, so a trace shows *why*
  the sweep stopped where it did.
- **Summary** — a `summary.json` (the final `suburbSweep` status + counts + timings) and a
  one-line human log per page to stdout when tracing.

**Boundaries:** trace artifacts contain listing data + screenshots → **never** uploaded to
brandbrain, never leave the rig. `.gitignore` the trace dir. Redact nothing locally (it's a
debug tool on the operator's own machine), but document that traces hold portal data.

**"Somehow see them" (future tie-in, not this pass):** the per-suburb results view (B) could
later deep-link to a local trace path when the agent runs on the same rig — noted as a
follow-up; out of scope now to preserve the counts-only-to-brandbrain boundary.

**Files:** new `crawl_trace.go` (trace writer + config), `crawl_cdp.go` (screenshot hook),
`crawl_listings.go` (emit per-page trace records + summary), `.gitignore`. Unit test the
trace writer (record shape, dir layout) with a fake fetcher; the screenshot path is
manually/operationally verified against the warm Chrome.

---

## Testing

- **A/B (brandbrain):** Go unit tests for the widened `crawlJobView` decode + `totals`
  aggregate + `crawlJobsInfo` payload; Swift decode tests for the extended `CrawlJobView`/
  `CrawlTotals`; build the SwiftUI app; manual smoke of the two tabs + results list against a
  live runtime (screenshots before/after).
- **C1 (shorted):** table tests for page-meta extraction (captured fixture), `wantPages`
  sizing, `sweepComplete`-at-count classification, yield-decay stop, fieldScore merge, resume
  skip. Live-verify one dense + one tiny suburb through the warm Chrome (fewer fetches, no
  truncation, correct status).
- **C2:** unit test the trace writer; live-verify a traced sweep produces screenshots +
  `trace.jsonl` + `summary.json` for one suburb.
- `go build` + `golangci-lint` clean; frontend/Swift compiles.

## Packaging & sequencing

- **PR-2 first-ish** benefits from Phase-0 (blob dump) which I can do immediately with the
  warm Chrome that's already running the corpus crawl. But the two PRs are independent; I'll
  build both. PR-1 (agent UI) has no external dependency.
- Neither auto-merges to prod without review (brandbrain merge→main auto-deploys; shorted is
  the housing feature branch / PR #261 lineage).
