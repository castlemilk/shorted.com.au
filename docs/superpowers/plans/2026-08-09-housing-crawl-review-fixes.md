# Housing Crawl Review Fixes Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Correct every confirmed defect in commit `1b18eb19f` without rewriting history, while preserving delist safety and enforcing a numeric-only, unambiguous brandbrain projection.

**Architecture:** The listings sweep will treat authoritative REA thin-suburb metadata as an exception to page-one poison/thin blocking, but will still pass through the normal listing merge and capped-complete path. The medians projection will use exact normalized aggregate keys, numeric values only, canonical-name ambiguity rejection, and a typed empty-projection error that prevents an RPC. Documentation changes in the obsolete monolith will be reverted so the in-flight housing documentation move does not conflict; the canonical wording is tracked against the moved document constraint.

**Tech Stack:** Go, `testing`, `httptest`, Playwright orchestration fakes, Git.

---

## Chunk 1: Crawl and brandbrain correctness

### Task 1: Preserve thin-suburb listings and classify broadened page one

**Files:**
- Modify: `services/house-price-collector/crawl_listings.go`
- Test: `services/house-price-collector/crawl_listings_test.go`

- [ ] **Step 1: Strengthen the page-classification table**

Add an expected listing count to every matrix case and add a REA case with two on-target listings plus twenty-three off-target listings whose authoritative `listings_total` is two.

- [ ] **Step 2: Run the focused test and verify RED**

Run from `services/`: `rtk go test ./house-price-collector -run 'TestSweep_PageClassificationMatrix' -count=1 -v`

Expected: FAIL because the narrow thin case returns zero listings and the broadened thin case returns `blocked` with zero listings.

- [ ] **Step 3: Implement the minimal sweep fix**

Compute the authoritative page-one exhaustion predicate before the poison gate. Use it only to bypass the page-one poison/thin-block verdicts, then allow the page to reach the existing merge loop and capped-complete tail so every matched listing is retained.

- [ ] **Step 4: Run focused and scoped listing tests**

Run from `services/`: `rtk go test ./house-price-collector -run 'TestSweep_' -count=1 -v`

Expected: PASS with both thin-suburb cases complete and carrying their two real listings.

- [ ] **Step 5: Commit**

Run from the repository root:

`rtk git add services/house-price-collector/crawl_listings.go services/house-price-collector/crawl_listings_test.go && rtk git commit -m "fix(housing-crawl): preserve thin-suburb listings"`

### Task 2: Enforce the aggregate boundary and skip empty RPCs

**Files:**
- Modify: `services/house-price-collector/crawl_brandbrain.go`
- Modify: `services/house-price-collector/crawl.go`
- Test: `services/house-price-collector/crawl_brandbrain_test.go`
- Test: `services/house-price-collector/crawl_playwright_test.go`

- [ ] **Step 1: Add hostile-value, ambiguity, and empty-projection tests**

Add behavioral tests proving strings/booleans under fuzzy aggregate-looking names never enter the decoded contract, historical/nearby median keys do not become current medians, conflicting distinct values for one canonical median are refused, and script-free HTML performs zero HTTP calls with a distinguishable empty-projection result. Update orchestration fixtures to contain real numeric aggregate scripts and decode `aggregate_fields` rather than checking `req.HTML != ""`.

- [ ] **Step 2: Run the focused tests and verify RED**

Run from `services/`: `rtk go test ./house-price-collector -run 'TestBrandbrain_|TestCrawlSuburb_RoutesBothSourcesToBrandbrain|TestCrawlSource_EmptyProjection' -count=1 -v`

Expected: FAIL because hostile strings currently cross, ambiguous medians are emitted, and empty payloads still call the server.

- [ ] **Step 3: Implement numeric exact-key projection**

Replace fuzzy name matching with an exact normalized-key map, accept only finite JSON numbers, emit only numeric values, and remove a canonical aggregate when more than one distinct numeric value maps to it. Preserve deterministic ordering and carry a finite source-key label only if needed for the outbound contract.

- [ ] **Step 4: Prevent empty projection RPCs**

Return a sentinel empty-projection error before request construction/HTTP, recognize it in `crawlSource`, increment rejected once, emit a distinct log line, and keep network retries for non-empty payloads only.

- [ ] **Step 5: Run focused and scoped tests**

Run from `services/`: `rtk go test ./house-price-collector -run 'TestBrandbrain_|TestCrawlSuburb_|TestCrawlSource_' -count=1 -v`

Expected: PASS with no request for empty projection and numeric-only aggregate contracts.

- [ ] **Step 6: Commit**

Run from the repository root:

`rtk git add services/house-price-collector/crawl_brandbrain.go services/house-price-collector/crawl.go services/house-price-collector/crawl_brandbrain_test.go services/house-price-collector/crawl_playwright_test.go && rtk git commit -m "fix(housing-crawl): seal aggregate projection boundary"`

## Chunk 2: Documentation alignment and final verification

### Task 3: Remove obsolete monolith edits and align safety wording

**Files:**
- Modify: `docs/housing-architecture.md`
- Modify if safely representable on this branch: `docs/feature/housing/architecture.md`
- Modify: `CLAUDE.md`

- [ ] **Step 1: Revert the two edits to the obsolete monolith**

Restore the two paragraphs in `docs/housing-architecture.md` to their `origin/main` wording so this branch no longer produces modify/delete conflicts with `docs/housing-feature-docs`.

- [ ] **Step 2: Align canonical wording with the enforced boundary**

The canonical file exists only on `docs/housing-feature-docs`; adding a divergent copy on this branch would replace the current modify/delete risk with add/add risk. Confirm the ancestry constraint with `rtk git merge-base HEAD docs/housing-feature-docs` (expected `8c120a3521576117f6f79d3eddf49cd7168875a4`) and `rtk git diff --find-renames 8c120a3521576117f6f79d3eddf49cd7168875a4..docs/housing-feature-docs -- docs/housing-architecture.md docs/feature/housing/architecture.md`. Keep this branch conflict-free by not adding the canonical path, record the exact canonical paragraph replacements under the `Canonical documentation follow-up` section below, and ensure `CLAUDE.md` claims only guarantees enforced by the final code. The final report must identify this user-constraint-limited portion of finding 6 explicitly rather than claiming the canonical branch was edited.

- [ ] **Step 3: Verify the documentation diff and commit**

Before committing, run `rtk git diff --check` and inspect `rtk git diff -- docs/housing-architecture.md docs/feature/housing/architecture.md CLAUDE.md docs/superpowers/plans/2026-08-09-housing-crawl-review-fixes.md`.

Expected: no stale monolith content additions and no whitespace errors.

- [ ] **Step 4: Commit**

Run:

`rtk git add CLAUDE.md docs/housing-architecture.md docs/superpowers/plans/2026-08-09-housing-crawl-review-fixes.md && rtk git commit -m "docs(housing): align crawl boundary guarantees"`

After committing, inspect `rtk git diff origin/main...HEAD -- docs/housing-architecture.md docs/feature/housing/architecture.md CLAUDE.md docs/superpowers/plans/2026-08-09-housing-crawl-review-fixes.md`.

#### Canonical documentation follow-up

Once `docs/housing-feature-docs` is an ancestor of the integration branch, update `docs/feature/housing/architecture.md` §6 to say that the medians tier forwards exact-key, finite numeric aggregates only; arbitrary strings/booleans, listing data, historical/nearby fuzzy keys, and ambiguous canonical medians are refused, and an empty projection skips ExtractRealEstate entirely. Update §6.4 to distinguish the counts-only listings queue contract from that numeric-only medians contract. This follow-up cannot be committed on the present branch without violating the user’s no-merge/no-switch/no-history-rewrite constraints or creating the add/add conflict identified by finding 6.

### Task 4: Full scoped verification

**Files:**
- Verify: `services/house-price-collector/**`

- [ ] **Step 1: Run formatting and static checks**

Run `rtk gofmt -w house-price-collector/crawl_listings.go house-price-collector/crawl_listings_test.go house-price-collector/crawl_brandbrain.go house-price-collector/crawl.go house-price-collector/crawl_brandbrain_test.go house-price-collector/crawl_playwright_test.go` and `rtk go vet ./house-price-collector` from `services/`, then `rtk git diff --check` from the repository root.

- [ ] **Step 2: Run the complete collector suite**

Run from `services/`: `rtk go test ./house-price-collector -count=1`

Expected: PASS, with any environment-dependent skips reported exactly.

- [ ] **Step 3: Inspect commits and worktree**

Run: `rtk git status --short --branch` and `rtk git log --oneline origin/main..HEAD`.

Expected: current branch remains `feat/housing-crawl-correctness`, fix commits sit above `1b18eb19f`, and no push/merge/branch switch occurred.
