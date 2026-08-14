# Collector VG Completion Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Complete the interrupted collector-vg package by adding a reliable residential NSW PSI run path while preserving and validating the committed VIC discovery and VG freshness work.

**Architecture:** Keep the normal Cloud Run `official` job free of the NSW source that is known to fail from datacenter egress. Add a source-specific `vg-nsw` mode that reuses the official observation persistence pipeline, refreshes views only after a successful ingest, applies the existing persisted-period freshness assertion to NSW, and returns a non-zero process status on failure. Operate it from macOS through an env-sourcing wrapper and launchd template beside the existing residential collector deploy tooling.

**Tech Stack:** Go, pgx, bash, macOS launchd, Go unit/integration-style wrapper tests.

---

## Chunk 1: Residential NSW collector mode

### Task 1: Add source-specific orchestration tests and mode

**Files:**
- Modify: `services/house-price-collector/main.go`
- Create: `services/house-price-collector/vg_nsw_runner_test.go`

- [x] Write failing tests proving the default official source list excludes `vg_nsw` and the residential runner returns non-zero without refreshing after ingest failure.
- [x] Run the focused tests and confirm they fail for the missing mode/orchestration.
- [x] Extract the existing per-source official persistence pipeline into a boolean-returning helper without changing normal official behavior.
- [x] Add `vg-nsw` mode with a residential-sized timeout, NSW-only ingest, NSW-only freshness enforcement, refresh on success, and propagated exit status.
- [x] Run the focused tests and existing NSW/VG freshness suites.
- [ ] Commit the collector-mode change. Blocked: sandbox cannot create the linked worktree Git `index.lock`.

## Chunk 2: Residential operator workflow

### Task 2: Add tested env-driven macOS deployment

**Files:**
- Create: `services/house-price-collector/deploy/run-housing-vg-nsw.sh`
- Create: `services/house-price-collector/deploy/com.shorted.housing-vg-nsw.plist.template`
- Create: `services/house-price-collector/deploy_vg_nsw_test.go`
- Modify: `services/house-price-collector/deploy/README.md`
- Modify: `CLAUDE.md`
- Modify: `docs/housing-architecture.md`

- [x] Write a failing wrapper test proving env-file loading, binary override, exact `-mode vg-nsw` invocation, logging, and exit-code propagation.
- [x] Run it and confirm failure because the wrapper does not exist.
- [x] Add the minimal wrapper and launchd schedule; syntax-check both artifacts.
- [x] Document build, secret/env setup, rehearsal/manual invocation, scheduling, logs, exit semantics, and the reason NSW is residential-only.
- [x] Run the wrapper test and shell/plist checks.
- [ ] Commit the deployment/documentation change. Blocked by the same Git metadata sandbox restriction.

## Chunk 3: Verification and closeout

### Task 3: Validate inherited and new work

**Files:**
- Verify: `services/house-price-collector/vic_vpsr.go`
- Verify: `services/house-price-collector/official_freshness.go`
- Verify: all files above

- [x] Run focused Go tests for VIC discovery/parser, VG freshness, NSW parser/runner, and deployment wrapper.
- [x] Run the full `services/house-price-collector` Go package test and record the sandbox-only loopback-bind failure exactly.
- [x] Run `bash -n` on touched shell and XML validation on the plist template.
- [x] Attempt the gated live VIC verification; DNS is blocked, and NSW requires residential DB hand-verification.
- [x] Confirm clean formatting and inspect the final diff.
- [ ] Commit final corrections. Blocked by the linked worktree Git metadata being outside writable sandbox roots.
