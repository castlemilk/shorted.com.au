# Housing MV Second Review Fixes Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Correct all six confirmed second-round housing MV defects while preserving the public biggest-cut metric, deterministic address rollups, complete state coverage, and transaction-scoped timeout overrides.

**Architecture:** Treat findings 1 and 2 as one duplicated root cause and restore suburb extrema at the existing k=3 row floor. Prove SQL behavior against PostgreSQL through the existing integration harness, retain narrow source-contract checks for migration ordering and caller SQL, and commit major fixes before minor fixes.

**Tech Stack:** PostgreSQL 14, SQL materialized views, Go/pgx/testcontainers, Node.js test runner.

---

## Chunk 1: Major correctness fixes

### Task 1: Restore suburb biggest-cut extrema consistently at k=3

**Files:**
- Modify: `services/shorts/internal/store/shorts/postgres_mv_correctness_integration_test.go`
- Modify: `services/migrations/mv_correctness.test.mjs`
- Modify: `services/migrations/000109_fix_listing_rollup_correctness.up.sql`

- [ ] Change the integration expectation for the three-address suburb to require `max_drop_pct = 0.20` and `max_drop_abs = 200000`.
- [ ] Change the migration contract assertions to require `MAX(max_pct)`, `MAX(max_abs)`, and k=3 projection guards instead of typed NULL extrema.
- [ ] Run `rtk node --test services/migrations/mv_correctness.test.mjs` and the scoped integration test; confirm they fail on the hard-NULL implementation.
- [ ] Restore per-source/address absolute extrema and project both suburb extrema behind `CASE WHEN a.dropped_listing_count >= 3` guards.
- [ ] Re-run the scoped Node and PostgreSQL integration tests and confirm green.

### Task 2: Make every address winner deterministic

**Files:**
- Modify: `services/shorts/internal/store/shorts/postgres_mv_correctness_integration_test.go`
- Modify: `services/migrations/mv_correctness.test.mjs`
- Modify: `services/migrations/000109_fix_listing_rollup_correctness.up.sql`

- [ ] Seed same-source, same-timestamp relists at one address and assert asking/sold aggregates remain fixed after tuple relocation and MV refresh.
- [ ] Add migration contract assertions requiring `pl.listing_id` as the final key on both asking/active and both sold-address `DISTINCT ON` orderings.
- [ ] Run the scoped tests and confirm at least the ordering contract fails against the current migration.
- [ ] Append `pl.listing_id` to all four winner orderings without changing earlier precedence.
- [ ] Re-run scoped tests and commit the major fixes plus this plan document on top of the existing branch.

## Chunk 2: Minor correctness and guard fixes

### Task 3: Repair the portal-ID fallback regression guard

**Files:**
- Modify: `services/migrations/mv_correctness.test.mjs`

- [ ] Add a focused assertion proving the fallback pattern recognizes `e.source || ':' || e.listing_id`.
- [ ] Run the Node test and confirm it fails with the current inert expression.
- [ ] Update the shared guard pattern to allow an optional table alias and use it for the up-migration rejection.
- [ ] Re-run the Node test and confirm green.

### Task 4: Preserve sold-only state rows and tracked suburbs

**Files:**
- Modify: `services/shorts/internal/store/shorts/postgres_mv_correctness_integration_test.go`
- Modify: `services/migrations/000109_fix_listing_rollup_correctness.up.sql`

- [ ] Seed a state containing only three recent sold addresses and assert it has a state row, contributes to the AU row, and contributes its suburbs to `suburbs_tracked`.
- [ ] Run the scoped integration test and confirm the state row is absent before the fix.
- [ ] Build the state-row driver and `suburbs_tracked` from the union of current active addresses and recent sold addresses; coalesce absent active counts to zero.
- [ ] Re-run the scoped integration test and confirm green.

### Task 5: Scope refresh timeout overrides to the transaction

**Files:**
- Modify: `services/migrations/mv_correctness.test.mjs`
- Modify: `services/house-price-collector/store.go`
- Modify: `services/jobs/internal/jobs/houseprices/store.go`

- [ ] Update the caller contract test to require `SET LOCAL statement_timeout = 0` and reject a session-scoped `SET`.
- [ ] Run the Node test and confirm both callers fail.
- [ ] Change both identical refresh callers and their comments to use the transaction-local override.
- [ ] Run the Node test and relevant Go package tests; commit the minor fixes.

## Chunk 3: Verification

### Task 6: Fresh scoped verification and history audit

**Files:**
- Verify all modified files and new commits.

- [ ] Run `rtk node --test services/migrations/mv_correctness.test.mjs`.
- [ ] Run the scoped Go unit packages for both collectors.
- [ ] Run `rtk go test -tags=integration ./shorts/internal/store/shorts -run 'TestMVCorrectness_' -count=1 -v` from `services`.
- [ ] Run `rtk git diff --check 94bee87db..HEAD` and inspect `rtk git diff 94bee87db..HEAD`, `rtk git status --short --branch`, and `rtk git log --oneline` to confirm all second-round changes are covered by additive commits with no uncommitted changes.
