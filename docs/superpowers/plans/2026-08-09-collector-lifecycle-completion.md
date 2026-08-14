# Collector Lifecycle Completion Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Complete the interrupted collector-lifecycle package without redoing its committed official-ingest, cursor-preservation, freshness-sentinel, wrapper, or PR-gating work.

**Architecture:** Keep the standalone collector and consolidated `services/jobs` fork behaviorally identical. Close the remaining honest-exit gap for an unconfigured agent, expose the official-source failure threshold through Terraform-managed Cloud Run configuration, then verify the committed WIP and additions with package-scoped, workflow, shell, and CI-contract tests.

**Tech Stack:** Go 1.26, Bash, GitHub Actions YAML, Terraform, Node.js `node:test`.

---

## Chunk 1: Remaining lifecycle behavior

### Task 1: Make missing agent infrastructure fatal

**Files:**
- Modify: `services/house-price-collector/lifecycle_test.go`
- Modify: `services/jobs/internal/jobs/houseprices/lifecycle_test.go`
- Modify: `services/house-price-collector/crawl_agent.go`
- Modify: `services/jobs/internal/jobs/houseprices/crawl_agent.go`
- Modify: `services/house-price-collector/main.go`
- Modify: `services/jobs/internal/jobs/houseprices/job.go`
- Modify: `docs/housing-architecture.md`

- [x] **Step 1: Add mirrored failing tests for an unconfigured agent**

Add `TestRunAgentMissingQueueConfigurationIsFatal` in both collector packages. Isolate `HOME` and clear BrandBrain URL/token/control overrides, invoke `runAgent(context.Background(), nil)`, and require exit `7`.

- [x] **Step 2: Run the two targeted tests and verify RED**

Run the package-scoped tests with writable `GOTMPDIR`/`GOCACHE`; expect exit `0` from the implementation today and therefore assertion failures wanting `7`.

- [x] **Step 3: Return exit 7 from both agent entry points when required queue configuration is absent**

Keep the existing re-warm (`3`) and fetcher-init (`4`) contracts unchanged. Update stale comments/docs that still describe missing agent infrastructure as a successful no-op.

- [x] **Step 4: Run the targeted lifecycle tests and verify GREEN**

Run both mirrored lifecycle/store/job exit test slices and require zero failures.

### Task 2: Make the official failure policy declaratively configurable

**Files:**
- Modify: `.github/workflows/housing-lifecycle.test.mjs`
- Modify: `terraform/modules/house-price-collector/variables.tf`
- Modify: `terraform/modules/house-price-collector/main.tf`
- Modify: `terraform/environments/dev/variables.tf`
- Modify: `terraform/environments/dev/main.tf`
- Modify: `terraform/environments/prod/variables.tf`
- Modify: `terraform/environments/prod/main.tf`
- Modify: `docs/housing-architecture.md`

- [x] **Step 1: Add a failing workflow contract test for Terraform propagation**

Require an `official_max_failures` module input, a `HOUSING_OFFICIAL_MAX_FAILURES` Cloud Run environment binding, and dev/prod root inputs passed into the module.

- [x] **Step 2: Run the Node contract suite and verify RED**

Run `node --test .github/workflows/housing-lifecycle.test.mjs`; expect the new Terraform contract assertion to fail.

- [x] **Step 3: Add validated Terraform inputs and Cloud Run binding**

Default the threshold to `15` for the current 16 official sources, reject negative values, expose it in both environment roots, and pass it into the collector module. Document that the code still bounds oversized values so a total failure can never be configured green.

- [x] **Step 4: Run the Node contract suite and verify GREEN**

Require all workflow/Terraform contract tests to pass.

- [x] **Step 5: Format and validate Terraform**

Run `terraform fmt -check` on the touched Terraform directories/files and the narrowest available validation that does not require unavailable provider/network state.

## Chunk 2: Verification and commit

### Task 3: Verify the complete work package

**Files:**
- Verify all files changed since `8c120a352`.

- [x] **Step 1: Run workflow and shell regression suites**

Run the Node workflow contract suite and `housing-lifecycle-exit.test.sh`.

- [x] **Step 2: Run both Go package suites**

Run `go test ./house-price-collector` and `go test ./jobs/internal/jobs/houseprices` with writable Go temp/cache paths. If localhost binding remains sandbox-blocked, record that actual failure and additionally run non-networked targeted test slices plus compile-only package checks.

- [x] **Step 3: Run the PR-gated housing service package**

From `services`, run `GOWORK=off GOPRIVATE='github.com/skunkworq/*' go test ./shorts/internal/services/shorts`.

- [x] **Step 4: Validate changed workflows and shell scripts**

Run `actionlint` on the new freshness workflow and use scoped checks that distinguish pre-existing warnings in the large deploy workflow. Run `shellcheck` on changed scripts and report any deliberate/existing warnings accurately.

- [x] **Step 5: Review the final diff against every F02/F21/F20 requirement**

Confirm there are no migrations, proto changes, web changes, history rewrites, branch switches, pushes, or unrelated refactors.

- [ ] **Step 6: Commit the completion changes**

Create conventional commits on top of `55bb5ae97`, without amending the WIP commit.
