Fix defects found by a second adversarial review of your work on this branch. Three independent lenses reviewed the diff and a separate verifier tried to REFUTE each finding; only CONFIRMED ones appear below (several were reproduced against a real PostgreSQL container or by reading the rendered UI). Do not re-litigate them.

Ground rules:
- Your previous work is ALREADY COMMITTED on this branch. Add fix commits on top. Do not rewrite history, push, merge, or switch branches.
- Fix root causes. Where a TEST or a CI guard pins the buggy behaviour or is inert, fix it so it asserts real behaviour - an assertion that can never fire is worse than none.
- Re-run the scoped tests and report ACTUAL output. If the sandbox blocks something, say so plainly rather than claiming it passed.
- If you genuinely believe a finding is wrong, argue it with evidence in your summary rather than silently skipping it.
- Note: sibling branches are fixing other housing areas in parallel. Keep edits to shared files minimal and additive.

IMPORTANT CONTEXT: findings 1 and 2 are about the INTERACTION between this branch and the sibling branch feat/housing-collector-lifecycle, which changed runOfficial's exit-code semantics. The two must compose: a source that this environment deliberately does NOT run (vg_nsw on Cloud Run, which cannot clear the Cloudflare challenge from datacenter egress) must not make the scheduled `-mode all` job exit non-zero and burn its retries. Distinguish "not attempted here / not applicable in this environment" from "attempted and failed". Equally, a rig run that got Cloudflare-blocked on the newest years must NOT report success. Make both directions honest.

## Confirmed findings (4)

### 1. [MAJOR] `-mode vg-nsw` reports success (exit 0, status='ok') when the newest NSW years are Cloudflare-blocked — the freshness gate is fooled by the thin-suburb pooled period
**Where:** services/house-price-collector/main.go:432-441 (runNSWVGRig) / official_freshness.go:24-29,64-78 / nsw_vg.go:100-133

**What's wrong:** The mode's stated contract (main.go:56-60 and deploy/README.md: "returns exit 1 on ingest/freshness failure ... launchd cannot report a silent success") is not met.

Three things combine:
1. `ingestNSWSuburbMedians` treats a per-year Cloudflare block as a SKIP (nsw_vg.go:69-76) and only errors when ALL three years fail (`if fetched == 0`, nsw_vg.go:100). One year out of three is enough to return observations.
2. The thin-suburb pooled fallback stamps its median at `latestYr` — `years[len(years)-1]`, computed from `nswRecentYears()` (nsw_vg.go:104-105) and NOT from the years actually fetched. So a run that only downloaded 2023.zip still emits `Period = 2025-12-31` for every thin suburb with >= 6 pooled sales (nsw_vg.go:130-133). NSW has thousands of low-turnover localities, so this always fires.
3. `assertOfficialVGFreshness` reads `MAX(period)` over the whole `house_prices` table for the source (official_freshness.go:24-29). That is monotonic (upserts never delete), and it is now equal to the fake 2025-12-31 stamp.

Result: `runOfficialJob` returns true -> `updateRun(vg_nsw, 2025-12-31, N, 'ok')` (main.go:424-426), `classifyVGFreshness` sees a period well inside the 550-day horizon and returns "", `runNSWVGRig` returns 0, the wrapper skips its osascript alert, and `refresh()` publishes MVs built from a 1-of-3-years corpus. Nothing in the pipeline compares this run's `latestPeriod(obs)` against the persisted cursor, so a regression is invisible by construction.

**How it fails:** Rig runs `-mode vg-nsw` on the 8th. valuergeneral.nsw.gov.au serves the Cloudflare interstitial for 2025.zip and 2024.zip (logged "did not return a zip ... skipping") but 2023.zip downloads. Suburb medians are rebuilt from 2023 sales only; every thin suburb writes a 2023-derived median stamped `period = 2025-12-31`. `house_price_ingest_runs.vg_nsw` shows status='ok', last_period=2025-12-31; the process exits 0; launchd records success; `mv_housing_headline` is refreshed with two years of NSW suburb medians silently missing and 2023 prices published as 2025. The next Cloud Run `-mode all` freshness assertion also passes. No operator signal for 550 days.

**Suggested fix:** Gate on the run's own coverage rather than the fact table's monotonic MAX: fail `-mode vg-nsw` when `fetched < len(nswRecentYears(nswYears))` (or at minimum when the newest complete year was not fetched), and stamp the pooled fallback at the newest year actually fetched, not `nswRecentYears()[last]`. Additionally compare `latestPeriod(obs)` against the persisted `house_price_ingest_runs.last_period` and treat a regression as an error.

**Verifier's confirmation:** Defect is real and reachable; one factual correction to the reviewer's illustrative scenario.

CONFIRMED mechanics:
1. services/house-price-collector/nsw_vg.go:69-81 — a Cloudflare interstitial for a given year is a `continue` (skip); only `fetched == 0` returns an error (:100-102). Contrast: the VIC path in the same diff hard-fails on a block page (vic_vpsr.go).
2. nsw_vg.go:104-105,130-133 — the thin-suburb pooled fallback stamps `Period` at `latestYr = nswRecentYears(nswYears)[last]`, i.e. a year that may never have been fetched. Reproduced with a verbatim copy of the emit loop (/tmp/vgcheck): with 2023+2024 fetched and 2025 blocked, a 3+3-sale suburb emits `Period = 2025-12-31` from 2023/2024 sales.
3. store.go:84-112 upserts only (never deletes) so `MAX(period)` per source is monotonic; official_freshness.go:24-29,64-78 gates solely on that monotonic max vs a 550-day horizon. Nothing compares this run's `latestPeriod(obs)` to the persisted cursor — updateRun (store.go:114-123) overwrites `last_period` unconditionally, so a 2025->2024 regression is recorded as status='ok'. Grep c

---

### 2. [MAJOR] The Cloud Run `-mode all` job now exits 1 for `vg_nsw`, a source it deliberately does not run — with max_retries=2 this re-runs the entire ABS/RBA/SA/VIC ingest 3x every month
**Where:** services/house-price-collector/main.go:49-55

**What's wrong:** `scheduledOfficialJobs()` (main.go:366-386) intentionally drops `vg_nsw` because its challenge cannot clear from datacenter egress, but line 51 still asserts freshness over the FULL `vgFreshnessPolicies` list, which includes `vg_nsw` (official_freshness.go:18-22). With no `vg_nsw` rows in prod, `classifyVGFreshness` returns the "has never succeeded" branch (official_freshness.go:65-67), `enforceVGFreshness` sets exit 1, and `run()` returns 1 at line 54.

`terraform/modules/house-price-collector/main.tf:56` sets `max_retries = 2`, so a non-zero task exit is retried twice. Each attempt re-executes all 15 scheduled sources (ABS SDMX + RBA + CKAN + land.vic.gov.au fetches), plus `refresh()` -> `linkSuburbSalCodes` + `refresh_housing_materialized_views()` + `pingRevalidate` (main.go:341-364). So one monthly schedule becomes 3 full ingests, 3 prod MV refreshes and 3 ISR purges of /price-drops + /housing.

Secondary effect: the job's pass/fail signal no longer means "the sources I ran are healthy". A genuine ABS/RBA/VIC breakage is indistinguishable from "the residential Mac hasn't been set up yet", and the job is red from the moment this merges until someone installs and successfully runs the launchd job.

**How it fails:** Merge lands; scheduler fires on the 5th at 16:00 UTC. runOfficial completes all 15 sources successfully, then `assertOfficialVGFreshness` logs "LOUD: vg_nsw house_prices has never succeeded" and `run()` returns 1. Cloud Run marks the task failed and retries twice -> 45 upstream source fetches, 3 `refresh_housing_materialized_views()` calls on prod Supabase and 3 revalidate pings in one scheduled window, and the job shows FAILED in the jobs dashboard indefinitely.

**Suggested fix:** Assert only the policies for sources this invocation actually ran (pass a filtered list, mirroring what `runNSWVG` does at main.go:445-450), and surface the cross-source watchdog through the persisted `house_price_ingest_runs` row / job-monitoring rather than through the shared job's process exit code — or set `max_retries = 0` on the job so a data-freshness alarm doesn't triple the ingest.

**Verifier's confirmation:** CONFIRMED as described, and prod state was verified rather than assumed.

MECHANISM (all re-read in the worktree):
- services/house-price-collector/main.go:49-55 — `case "official","abs","all"` calls `assertOfficialVGFreshness(ctx, pool, vgFreshnessPolicies)` with the FULL policy list, then `return 1`. The `policies` parameter exists specifically so a caller can scope it; `runNSWVG` (main.go:432-450) does filter to `nswSource`, the scheduled path does not.
- official_freshness.go:18-22 includes `{source:"vg_nsw", maxAgeDays:550}`; `scheduledOfficialJobs()` (main.go:366-386) deliberately omits `vg_nsw`, and vg_nsw_runner_test.go ASSERTS that omission. The scheduled job therefore enforces a policy it structurally cannot satisfy. No env gate, no build tag, no fallback anywhere in the diff.
- Scoped suite re-run green (10/10): `go test ./house-price-collector/ -run 'VGFreshness|ClassifyVG|EnforceVG|AssertVG|ScheduledOfficialJobs|RunNSWVGRig|CollectorTimeout' -v`. The tests themselves encode "never succeeded -> exit 1".

AMPLIFICATION (verified):
- terraform/modules/house-price-collector/

---

### 3. [MINOR] VIC workbook discovery has no year floor: a listing page whose newest matching link is OLDER than the pinned fallback is fetched and ingested, and the fallback is never tried
**Where:** services/house-price-collector/vic_vpsr.go:87

**What's wrong:** `selectVICWorkbookURL` seeds `bestEnd = -1` (line 67) and picks the maximum `end` year among links matching `houses-by-suburb-YYYY-YYYY.xlsx` (line 87). It never compares the winner against the pinned `vicXLSXURL` (2014-2024) or against the period already persisted for `vg_vic`.

`fetchVICSuburbWorkbook` only falls back to the pinned URL when discovery *errors* (lines 107-118). A discovery that succeeds with an older workbook short-circuits the fallback entirely: the bytes validate as xlsx (`validateVICXLSX`, line 139), `parseVICSuburbMedians` parses them, and `runOfficialJob` upserts every row. `upsertObservations` is `ON CONFLICT (region_code, measure, dwelling_type, period, source) DO UPDATE SET value = EXCLUDED.value` (store.go:90-93), so the older edition's numbers overwrite the current values for every overlapping suburb-year, and `updateRun` records status='ok' with a regressed `last_period` (main.go:424-426). Nothing compares the new max period to the stored cursor.

The new freshness gate cannot catch this either: it reads `MAX(period)` across all `vg_vic` rows (official_freshness.go:25-29), which still includes the untouched 2020-2024 rows, so it stays green.

**How it fails:** land.vic.gov.au renames the current release (e.g. to `median-house-by-suburb-2025.xlsx`, or `houses-by-suburb-time-series.xlsx`) so the regex at vic_vpsr.go:38 misses it, while an "Earlier statistics" link to `houses-by-suburb-2013-2023.xlsx` remains on the page. Discovery returns the 2013-2023 archive; it fetches 200 and parses cleanly; the collector overwrites `house_prices` values for VIC suburbs across 2014-2023 with the older edition's medians, drops nothing for 2024, and writes `vg_vic` status='ok' last_period=2023-12-31. `/housing/vic/*` serves the regressed medians and neither the run row nor the freshness gate flags it.

**Suggested fix:** Reject any discovered candidate whose end year is not greater than both the pinned fallback's end year (2024) and the persisted `house_price_ingest_runs.last_period` year; on rejection either fall through to the pinned URL or fail loudly. Also compare `latestPeriod(obs)` against the persisted cursor in `runOfficialJob` and treat a backwards move as an error rather than 'ok'.

**Verifier's confirmation:** Core defect verified in /Users/benebsworth/projects/.worktrees/shorted-hw-collector-vg/services/house-price-collector/vic_vpsr.go, but one supporting claim is wrong and the severity is overstated.

CONFIRMED mechanics (all read directly):
1. vic_vpsr.go:66-91 — `bestStart, bestEnd := -1, -1` then `if end > bestEnd || (end == bestEnd && start > bestStart)`. No floor against the pinned `vicXLSXURL` (2014-2024, line 29) and no read of any persisted period. Any single matching link wins, however old.
2. vic_vpsr.go:99-126 — the pinned fallback is reached only when `discoveryErr != nil` OR the discovered fetch/`validateVICXLSX` fails. A discovery that succeeds and downloads a valid older xlsx returns at line 112 and never touches `vicXLSXURL`.
3. Reachable on the deployed path: `{"vg_vic", ingestVICSuburbMedians}` is in `scheduledOfficialJobs()` (main.go:385) and `.github/workflows/terraform-deploy.yml:283` builds `services/house-price-collector/Dockerfile` for the Cloud Run job. (The stale duplicate at services/jobs/internal/jobs/houseprices/vic_vpsr.go:40 still uses the pinned URL only 

---

### 4. [MINOR] The consolidated `shorted house-prices` port still hardcodes the dead 2014-2024 VIC asset and still schedules vg_nsw from Cloud Run
**Where:** services/jobs/internal/jobs/houseprices/vic_vpsr.go:24 (and job.go:448)

**What's wrong:** `services/jobs/internal/jobs/houseprices/` is a full copy of this collector, built and pushed to the prod artifact registry on every merge (`.github/workflows/terraform-deploy.yml:286-287`, image `shorted-jobs`) and registered as a runnable job (`services/jobs/cmd/shorted/main.go:47`). It was not touched by this branch: `vic_vpsr.go:24` still pins `houses-by-suburb-2014-2024.xlsx` with a single unconditional `FetchBytes` (line 40) and no listing discovery, and `job.go:448` still has `{"vg_nsw", ingestNSWSuburbMedians}` in the scheduled official job slice. There is no `vg-nsw` mode there and no cross-copy parity test (`job_test.go` only checks the copy's own mode list against its own help string).

`services/jobs/README.md:328-333` states the explicit plan for rigs and the Cloud Run job to cut over to this binary (`HOUSING_CRAWL_BIN='.../shorted house-prices'`), so the divergence is scheduled to become live.

**How it fails:** An operator follows services/jobs/README.md and flips the housing surfaces to `shorted house-prices`. The VIC ingest reverts to the 403ing pinned asset (silently no-op'ing the recovery this branch exists for), the Cloud Run official run resumes hammering the NSW Cloudflare challenge from datacenter egress, and the new launchd job fails with `unknown -mode "vg-nsw"`.

**Suggested fix:** Port the discovery + `scheduledOfficialJobs` split + `vg-nsw` mode into `services/jobs/internal/jobs/houseprices/`, or add a test asserting the two copies' official source lists and VIC fetch entrypoint stay in sync.

**Verifier's confirmation:** Every citation verified exactly. services/jobs/internal/jobs/houseprices/vic_vpsr.go:24 still pins houses-by-suburb-2014-2024.xlsx with a lone unconditional FetchBytes at line 40 (no vicListingPageURL / selectVICWorkbookURL / fetchVICSuburbWorkbook / vicFetcher); job.go:448 still has {"vg_nsw", ingestNSWSuburbMedians} in the runOfficial slice reached from the official/all dispatch at job.go:130-131; official_freshness.go is absent from the mirror entirely. The mirror is live shipped code: houseprices.Job() at services/jobs/cmd/shorted/main.go:47, shorted-jobs in the terraform-deploy.yml:286-287 build matrix whose `if:` only skips unlabeled PRs (so merges to main build+push it), and `go vet ./internal/jobs/houseprices/` from services/jobs passes.

Drift is branch-attributable, not pre-existing: at base 8c120a352 the two vic_vpsr.go files were byte-identical except `-package main`/`+package houseprices`, and both official slices contained vg_nsw. `git diff --stat 8c120a352` touches no services/jobs/ path, so this branch created the divergence. No parity guard exists — job_test.go's Tes

---

