# Housing MV Review Fixes Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Correct every confirmed housing MV review defect while preserving migration-order compatibility and proving the database behavior with executable integration tests.

**Architecture:** Group duplicate findings by root cause and fix them in severity order. Exercise query and migration semantics against PostgreSQL through the existing integration-test harness; retain lightweight source contract checks only where runtime execution cannot directly observe the caller text.

**Tech Stack:** Go, pgx, testcontainers-go, PostgreSQL, Node.js test runner, SQL migrations.

---

### Task 1: Crime-rank null semantics and executable profile coverage

**Files:**
- Modify: `services/shorts/internal/store/shorts/postgres_suburb_explorer_test.go`
- Modify: `services/shorts/internal/store/shorts/postgres_house_prices_query_test.go`
- Modify: `services/shorts/internal/store/shorts/postgres_house_prices.go`

- [ ] Extend the integration schema with the banner columns and crime MV shape required by the real queries.
- [ ] Seed a covered rank below 0.1 and leave another suburb without crime data.
- [ ] Assert covered ranks floor to 0.1, absent ranks remain 0, and the politician-property scan is reached.
- [ ] Run the scoped integration test and verify the crime assertion fails for the shipped `GREATEST(NULL, 0.1)` behavior.
- [ ] Replace each crime-rank expression with an explicit NULL branch and remove the source-string test that pinned the defect.
- [ ] Re-run unit and integration tests and commit the blocker fix.

### Task 2: Agency ranking, privacy, and rollout compatibility

**Files:**
- Create: `services/shorts/internal/store/shorts/postgres_mv_correctness_integration_test.go`
- Modify: `services/migrations/000109_fix_listing_rollup_correctness.up.sql`
- Modify: `services/migrations/mv_correctness.test.mjs`
- Modify: `services/shorts/internal/store/shorts/postgres_house_prices.go`

- [ ] Add a PostgreSQL integration fixture that executes migration 000109 over quiet, sub-k, and qualifying agencies.
- [ ] Assert counts remain visible/non-null, price values remain suppressed below k=3, default/value sorts put qualifying agencies first, and the previous API projection still parses and scans.
- [ ] Assert suburb extrema are not published at the k=3 floor.
- [ ] Run the new test and verify it fails against the shipped MV/query behavior.
- [ ] Restore non-null agency counts, add the empty compatibility `agent_names` column, explicitly sort nullable price values with NULLS LAST, and emit typed NULL extrema from the public suburb MV.
- [ ] Replace static assertions that pinned nullable counts/removed compatibility shape with behavior-backed coverage.
- [ ] Re-run scoped migration/store tests and commit the blocker/major/minor fixes.

### Task 3: Relisted sales in the twelve-month window

**Files:**
- Modify: `services/shorts/internal/store/shorts/postgres_mv_correctness_integration_test.go`
- Modify: `services/migrations/000109_fix_listing_rollup_correctness.up.sql`
- Modify: `services/migrations/mv_correctness.test.mjs`

- [ ] Seed three sold listings whose only sold-marking event is `relisted` and assert suburb/state sold counts and statistics include them.
- [ ] Run the test and verify it fails with sold_count 0.
- [ ] Add `relisted` to both sold-transition event filters and remove the static assertion that pinned the incomplete event list.
- [ ] Re-run scoped tests and commit the major fix.

### Task 4: Refresh caller parity

**Files:**
- Modify: `services/migrations/mv_correctness.test.mjs`
- Modify: `services/jobs/internal/jobs/houseprices/store.go`

- [ ] Extend the caller contract test to check both collector implementations and verify the jobs copy fails.
- [ ] Apply the simple-protocol timeout-disarming call to the consolidated jobs copy.
- [ ] Re-run the Node and Go package tests and commit the minor fix.

### Task 5: Final verification and history

**Files:**
- Verify all modified files and commits.

- [ ] Run gofmt on modified Go files.
- [ ] Run the scoped Node migration tests, Go unit tests, and PostgreSQL-backed integration tests with fresh output.
- [ ] Inspect `git diff`, `git status`, and commits to confirm all fixes are committed on top of `8652951b5` without branch switching, pushing, merging, or history rewriting.
