Fix defects found by a second adversarial review of your work on this branch. Three independent lenses reviewed the diff and a separate verifier tried to REFUTE each finding; only CONFIRMED ones appear below (several were reproduced against a real PostgreSQL container or by reading the rendered UI). Do not re-litigate them.

Ground rules:
- Your previous work is ALREADY COMMITTED on this branch. Add fix commits on top. Do not rewrite history, push, merge, or switch branches.
- Fix root causes. Where a TEST or a CI guard pins the buggy behaviour or is inert, fix it so it asserts real behaviour - an assertion that can never fire is worse than none.
- Re-run the scoped tests and report ACTUAL output. If the sandbox blocks something, say so plainly rather than claiming it passed.
- If you genuinely believe a finding is wrong, argue it with evidence in your summary rather than silently skipping it.
- Note: sibling branches are fixing other housing areas in parallel. Keep edits to shared files minimal and additive.

## Confirmed findings (4)

### 1. [MAJOR] INGEST_ERROR check is unscoped — any operator-run mode's stale 'error' row pins the daily sentinel red forever
**Where:** .github/workflows/housing-freshness.yml:90-91

**What's wrong:** The first violation branch is `FROM house_price_ingest_runs AS r WHERE r.status = 'error'` with no join to `expected_fact_sources`, no source allowlist and no age bound. `house_price_ingest_runs` is NOT an official-ingest-only table: `updateRun(..., "error", ...)` is also written by the opt-in / operator-run modes — `crawl` (crawl.go:258, 294), `listings_rea`/`listings_domain` (crawl_listings.go:275, 292), `listing_details` (crawl_details.go:70, 89), `property_valuations` (crawl_property.go:83, 102), `crime_primaries` (crime.go:34-106), `backfill_address_key`, `abs_census`, `aec_federal`, `abs_lga`, `local_amenities`, `nbn_footprint`, `suburb_archetypes`, plus the VIC/FAG council loaders. Those modes are documented as "opt-in only, never part of the scheduled run" (main.go:68, 78) — nothing clears the row, so `status` stays `'error'` until a human re-runs that exact mode. The workflow's own comment at lines 36-37 claims the explicit map "excludes non-fact cursors such as listings and census" — that is only true for the PERIOD_REGRESSION branch. Cadence compounds it: the official ingest is MONTHLY (terraform/modules/house-price-collector/main.tf scheduler) but this sentinel runs DAILY, so one failed source on the 5th produces ~30 consecutive red runs + 30 webhook pages. This also breaks the exit-code design's backstop: `officialRunFatal` deliberately lets 15/16 official sources fail and still exit 0 (main.go:60-66, TF default 15), on the assumption this sentinel catches partial failures — a permanently-red sentinel catches nothing.

**How it fails:** Someone runs `-mode crime` once (yearly, operator-run) and the BOCSAR download 404s → `crime_primaries` row is written with status='error' and is never touched again. From that day on, Housing Freshness exits 1 at 22:11 UTC every single day and POSTs to CRAWL_FRESHNESS_WEBHOOK, regardless of housing data health. The EVENT_SILENCE branch — the check that actually detects a dead residential rig within 72h, the thing this workflow exists for — produces no state change because the run was already red, so a dead rig goes unnoticed exactly as before.

**Suggested fix:** Scope INGEST_ERROR to the same `expected_fact_sources` cursor list used by PERIOD_REGRESSION (or an explicit allowlist), and/or bound it by `r.last_fetched_at > now() - interval 'N days'` so a stale one-shot mode's cursor cannot pin the sentinel.

**Verifier's confirmation:** CONFIRMED as described, at .github/workflows/housing-freshness.yml:82-91.

Verified chain:
1. The INGEST_ERROR arm is literally `FROM house_price_ingest_runs AS r WHERE r.status = 'error'` — no join to expected_fact_sources, no allowlist, no age bound. The explicit cursor map (lines 42-59) feeds only mapped_fact_maxima, which is used solely by the PERIOD_REGRESSION arm, so the "excludes non-fact cursors such as listings and census" comment at lines 36-37 does not apply to the first arm.
2. house_price_ingest_runs is a one-row-per-source cursor (migration 000053: `source TEXT PRIMARY KEY`; store.go:114-126 `ON CONFLICT (source) DO UPDATE ... status = EXCLUDED.status`). No TTL/trigger/cleanup exists in any migration, so a row's status persists until that exact source is written again.
3. Non-official writers of status='error' confirmed by grep: crime.go:34,42,48,57,66,76,91,106 (crimeRunSource = "crime_primaries"), crawl_listings.go:275,292, crawl_details.go:70,89, crawl_property.go:83,102, crawl.go:258, crawl_backfill_address.go:25,33, plus main.go for abs_census, aec_federal, abs_lga

---

### 2. [MAJOR] New PR gate runs a package this PR doesn't touch; the deployed collector's lifecycle tests run in no CI job at all
**Where:** .github/workflows/terraform-deploy.yml:1488-1509

**What's wrong:** The `housing-contract-tests` job is the only new PR-time gate, and its Go step is `go test ./shorts/internal/services/shorts` — a package with zero changes in this diff. The packages this branch actually changes are `services/house-price-collector` (the binary terraform/environments/{dev,prod}/main.tf actually deploys as the `house-price-collector` Cloud Run job) and `services/jobs/internal/jobs/houseprices`. Grepping every `go test` in `.github/workflows/`: line 1509 (`./shorts/internal/services/shorts`) and line 1542 (`cd services/jobs && go test ./...`). There is no invocation that reaches `services/house-price-collector`, so `lifecycle_test.go` (TestOfficialRunFatal, TestAgentExitCode, TestRunAgentMissingQueueConfigurationIsFatal) and `store_test.go` (TestUpdateRunSQLConflictContract) never execute in CI. `deploy/housing-lifecycle-exit.test.sh` — the only regression coverage for the new wrapper/drain exit propagation — is wired into no job either. The jobs-module mirror is covered only by `run-tests`, which is `if: github.event_name != 'pull_request'` (line 1513), i.e. post-merge.

**How it fails:** A later PR reverts `services/house-price-collector/store.go:118-120` back to `last_period = EXCLUDED.last_period` (silently re-introducing the F21 cursor-clobber this branch fixes) or changes `agentExitCode` so `fatalErr` returns 0. Every check on that PR passes green — `housing-contract-tests` runs an unrelated package and `run-tests` is skipped on pull_request — and the regression ships to the deployed collector.

**Suggested fix:** Point the job's Go step at the packages the branch owns: `go test ./house-price-collector` (working-directory: services) plus `cd services/jobs && go test ./internal/jobs/houseprices/...`, and add a step running `bash services/house-price-collector/deploy/housing-lifecycle-exit.test.sh`.

**Verifier's confirmation:** Verified in worktree /Users/benebsworth/projects/.worktrees/shorted-hw-collector-lifecycle (afe20dc23 vs 8c120a352); every element of the finding holds.

EVIDENCE
1. Wrong package gated: `git diff --stat 8c120a352...HEAD -- services/shorts` is EMPTY, yet the only new PR-time job (.github/workflows/terraform-deploy.yml:1486-1509, `housing-contract-tests`, `if: github.event_name == 'pull_request'`) runs `GOWORK=off ... go test ./shorts/internal/services/shorts`.
2. Zero CI coverage of the changed collector: exhaustive grep of `go test` in .github/workflows/ yields exactly two invocations — terraform-deploy.yml:1509 (`./shorts/internal/services/shorts`) and :1542 (`cd services/jobs && go test ./...`). The remaining test step in run-tests is `make test-integration-ci`, which per services/Makefile:857-863 only runs `test/integration` and `market-data`. services/house-price-collector/Dockerfile contains no `go test`. So services/house-price-collector/lifecycle_test.go (TestOfficialRunFatal, TestAgentExitCode, TestRunAgentMissingQueueConfigurationIsFatal, TestEnqueueExitCode, TestOfficialLi

---

### 3. [MINOR] `-mode agent` — the nightly path — still logs and continues past an MV-refresh failure and exits 0
**Where:** services/house-price-collector/crawl_agent.go:696

**What's wrong:** The branch makes MV-refresh failure fatal for `official`/`all` (main.go:60), `crawl` (main.go:74-77) and `refresh` (main.go:184), and docs/housing-architecture.md:134 now states "A materialized-view refresh failure always exits non-zero". But the modes that actually run nightly on the rigs still swallow it: crawl_agent.go:696 `if err := refreshHousingMV(finCtx, pool); err != nil { log.Printf("[agent] mv refresh failed: %v", err) }` — nothing sets `fatalErr`, so `agentExitCode` returns 0. Same at crawl_listings.go:360 for `-mode listings`. Because `pingRevalidate` is in the `else` branch, a failed refresh also skips the cache bust, so the drain reports success while /price-drops keeps serving pre-crawl data.

**How it fails:** A nightly `run-housing-delta.sh` drain crawls 60 suburbs and writes several thousand price events, then `refresh_housing_materialized_views()` is killed by Supabase's statement_timeout (WHEN OTHERS in migration 000092 does not trap query_canceled). `-mode agent` logs `[agent] mv refresh failed`, exits 0, `hc_drain_until_empty` returns 0, the wrapper exits 0, and `crawl_run_status` records a successful run — the exact 'everything failed, reported SUCCESS' shape this branch set out to eliminate, one layer down.

**Suggested fix:** Either propagate the finalizer's refresh error into a non-zero agent/listings exit code, or narrow the docs/housing-architecture.md claim to the official/crawl/refresh modes.

**Verifier's confirmation:** Verified in worktree shorted-hw-collector-lifecycle. Every cited mechanic holds: services/house-price-collector/crawl_agent.go:695-701 logs the refreshHousingMV error and puts pingRevalidate in the else branch; fatalErr is set at exactly one site (crawl_agent.go:602, the client.claim path) and agentExitCode(anyRewarm, fatalErr, done) takes no refresh input, so the process exits 0; deriveCrawlRunStatus (crawl_run_status.go:89-102) likewise never sees it, so crawl_run_status records "ok"; hc_drain_until_empty only branches on rc 3/4/other-non-zero, so run-housing-delta.sh exits 0. Same shape at crawl_listings.go:359-364 and in the services/jobs mirror (crawl_agent.go:686-692). The doc claim at docs/housing-architecture.md:134 ("A materialized-view refresh failure always exits non-zero") is real, and the branch's own lifecycle_test.go asserts refresh-fatality only for the official path (TestOfficialLifecycleFatalWhenRefreshFailsWithHealthySources). The scenario is reachable: refreshHousingMV is a bare SELECT refresh_housing_materialized_views(), and PL/pgSQL WHEN OTHERS does not trap QU

---

### 4. [MINOR] psql stderr is captured to query_error_file and never surfaced, so a CHECK_FAILURE reports only an exit code
**Where:** .github/workflows/housing-freshness.yml:34

**What's wrong:** `query_error_file` is assigned at line 34 and used exactly once, as the 2> target at line 41. Nothing ever reads it: the failure path at lines 134-136 overwrites `$report_file` with a synthetic `CHECK_FAILURE\tpsql\tread-only freshness query failed (exit N)` line, and the step summary block (141-154) only renders `$report_file`. The actual libpq/Postgres message is written to a temp file on an ephemeral runner and discarded.

**How it fails:** The DATABASE_URL_PROD secret is rotated and the sentinel starts failing. The GitHub step summary and the webhook payload both say only 'read-only freshness query failed (exit 2)'. The operator cannot tell 'password authentication failed' from 'relation "property_price_events" does not exist' from 'connection timed out' without re-running the query by hand against prod.

**Suggested fix:** On the failure path, append the (truncated) contents of "$query_error_file" to $report_file / $GITHUB_STEP_SUMMARY.

**Verifier's confirmation:** Verified in /Users/benebsworth/projects/.worktrees/shorted-hw-collector-lifecycle/.github/workflows/housing-freshness.yml. A repo-wide grep returns exactly two hits for `query_error_file`: the assignment (line 34) and the `2>` redirect target (line 41). Nothing ever reads it — no `cat`, no artifact upload, and the job has a single step, so the file is destroyed with the ephemeral runner. The failure branch at 134-136 uses truncating `>"$report_file"` (also discarding any partial stdout rows), and the summary block at 141-154 renders `$report_file` only. The new test .github/workflows/housing-lifecycle.test.mjs asserts nothing about error surfacing, so no guard exists elsewhere in the diff.

Reproduced the failure path with a faithful simulation (real psql, unreachable host): exit 2, step summary shows only `CHECK_FAILURE\tpsql\tread-only freshness query failed (exit 2)`, while `psql: error: connection to server ... failed: Connection refused` sits in the discarded stderr file.

Two imprecisions in the write-up, neither of which rescues the code: (1) under ON_ERROR_STOP=1 a missing re

---

