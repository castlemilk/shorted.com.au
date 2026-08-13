# Work package: collector-lifecycle

Collector run lifecycle: honest exit codes, cursor integrity, freshness sentinel, CI test gating

## Ground rules (read first)

- You are in a git WORKTREE of the Shorted repo on your own branch. Commit ALL your work
  with conventional-commit messages (one commit per logical unit is fine). Do NOT push,
  do NOT merge, do NOT switch branches, do NOT touch main.
- Before coding, read the Housing section of the repo CLAUDE.md and skim
  docs/housing-architecture.md for the landmines that apply to your files. Non-negotiable
  repo rules: interactive charts import via dynamic(ssr:false) from "use client" modules;
  never pass functions across the RSC boundary; read searchParams client-side (useSearchParams
  under Suspense) on ISR pages - a server-page searchParams read silently forces dynamic;
  server actions use getShortsApiUrl() from app/actions/config.ts, never env vars directly;
  KV reads go through the readCached non-emptiness predicate.
- Migrations: the prod deploy does NOT run migrate up (hand-apply regime). Do NOT create
  migrations unless your spec explicitly assigns you migration numbers. If a schema change
  seems needed but is not assigned, write it up in your final summary instead.
- Do not modify .proto files or run buf generate. If a proto change seems needed, note it
  in the summary.
- Keep the diff scoped to the findings below. No drive-by refactors, no formatting sweeps.
- QA before you finish: run the narrowest relevant tests (go test ./... scoped to the
  packages you touched; for web: cd web && npx tsc --noEmit plus any touched jest suites)
  and report the actual results honestly in your final summary. If something fails and you
  cannot fix it within scope, say so plainly.
- Finish with a summary: what you changed per finding, what you deliberately did not do,
  test results, and anything the reviewer must hand-verify.

These findings come from a 24-agent adversarial audit (2026-08-09); each was independently
verified against the code. Evidence line references were correct as of audit time - re-locate
if lines shifted.

## Track notes

For F02: non-zero exit when all (or a configurable majority of) official sources
error, and when the MV refresh fails - so Cloud Run retries + alerting engage. Distinct
non-zero exit from agent mode when a fatal error occurred and zero jobs completed. Add a
.github/workflows/housing-freshness.yml modelled on economy-freshness.yml /
register-freshness.yml: fail on error rows in house_price_ingest_runs, on max(period)
regression per source, and on prolonged event silence; wire the same optional webhook
pattern those workflows use. For F21: never clobber last_period/rows_upserted on a failed
run - preserve last-success values (append or conditional update). For F20: make the
dual-service proto parity test and the kill-switch regression tests actually gate PRs
(run-tests currently skips on pull_request; scope a job so these specific fast Go tests
run on PRs without dragging the whole integration suite in).

## Findings (verbatim from the audit)

### F02 [high/bug] Housing pipelines fail silently end-to-end: official runs exit 0 on total failure, nothing reads house_price_ingest_runs, no freshness workflow, crawl outages also exit 0 and the alarm has no push sink

**Detail:** Official tier: runOfficial() handles every per-source error with log+continue (main.go:368-394), refresh() failure is logged only (main.go:334-337), and run() returns 0 (main.go:174) — a run where all 16 sources AND the MV refresh fail reports SUCCESS, so Cloud Run max_retries, scheduler retry_config, and the GCP-native jobmonitor all see green. house_price_ingest_runs.status='error' has ZERO readers anywhere, and unlike register/economy there is no housing-freshness.yml. This is exactly why the F01 VG breakage sat unnoticed for a month+ (plus property_valuations CDP failure since 2026-07-24). Crawl tier compounds it: a total auth outage (dead BrandBrainAgent.app) breaks the drain loop but runAgent still returns 0 (crawl_agent.go:601-605, 732-737) so a multi-day outage looks like 'nothing to do'; the freshness guard's CRAWL_FRESHNESS_WEBHOOK is UNSET on the live rig (alarm fired for days into an unread log during the 2026-08 outages); and classifyFreshness excludes never-crawled suburbs — over half the 500-suburb catalog is structurally invisible to it forever. The listings_rea/listings_domain cursor rows also stopped 2026-07-13 because agent mode bypasses updateRun, so the cursor table can't serve as a crawl freshness signal either.

**Evidence:** main.go:368-394, :174; terraform/modules/house-price-collector/main.tf:56; grep house_price_ingest_runs → writers only (collector store.go:116 + jobs fork copy); no housing-freshness workflow vs economy-freshness.yml/register-freshness.yml; crawl_agent.go:601-605/732-737; housing-crawl-common.sh:148-151 (processed==0 → rc 0); crawl_freshness.go:61-65 (never-crawled excluded), webhook unset in ~/.shorted-housing-crawl.env (verified 2026-08-09); prod: vg errors 2026-08-05 + property_valuations error since 2026-07-24 unalerted; listings_* cursors 2026-07-13 vs events through 2026-08-09.

**Suggested fix (advisory, you may do better):** Non-zero exit when any/most official sources error (engages Cloud Run retry + failure alerting); distinct exit code from runAgent when fatalErr && done==0 with wrapper notification + agent-relaunch preflight; add housing-freshness.yml (fail on error rows, max(period) regression, event silence); provision the webhook; add a coverage-trend alarm (Covered stops growing / NeverCrawled grows).

**Verifier note:** CONFIRMED with two peripheral overstatements. Core evidence holds exactly: (1) main.go:368-394 log+continue for all 16 official sources, refresh() failure log-only (334-337), run() returns 0 (174) — a total-failure official run exits 0, so Cloud Run max_retries=2 (module main.tf ~56), scheduler retries, and jobmonitor all see success. (2) house_price_ingest_runs is write-only (collector store.go:116 + jobs fork copy; zero readers in services/shorts, web/src, .github) and no housing-freshness.yml exists while economy-freshness.yml/register-freshness.yml do; no later fix in git log. (3) crawl_agent.go:603-605 (claim error → fatalErr, break) + :732-737 (return 0 unless rewarm) and housing-crawl-common.sh processed==0 → rc 0 confirmed; CRAWL_FRESHNESS_WEBHOOK verified absent from ~/.shorted-housing-crawl.env today. (4) Prod verified live: vg_nsw + vg_vic status='error' at latest run 2026-08-05 (vg_nsw has ZERO rows ever in house_prices; vg_vic frozen at 2024-12-31), property_valuations 'error' since 2026-07-24, listings_rea/domain cursors frozen 2026-07-13 while property_price_events flow through 2026-08-09 (agent mode has no updateRun — only crawl_listings.go writes those cursors). Overstatements: (a) "over half the 500-suburb catalog structurally invisible forever" is wrong today — replicating crawl_delta.go's exact freshnessKey join against prod gives 500/500 covered, 0 never-crawled, and the alarm is actually in firing range (oldest covered ~100h > 72h); the exclusion mechanism is real but currently moot. (b) The crawl tier is not fully unmonitored: runAgent writes an 'error'/stale crawl_run_status row merged into the admin jobs dashboard (crawl_jobs.go, migration 000089), and hc_freshness posts a macOS banner — the true gap is exit codes + durable push alerting, not total absence of signal. Severity stays high: this is a real reliability/alerting gap already demonstrated by live unnoticed prod breakage (vg_nsw never ingested, vg_vic 19 months stale, property_valuations dead 2+ weeks), but it is not itself wrong published data or a security/licence exposure.

### F21 [medium/bug] A failed run clobbers the source's cursor — last_period and rows_upserted overwritten with NULL/0, destroying the 'when did this last succeed' forensics

**Detail:** On any error, runOfficial calls updateRun(..., nil, 0, 'error', ...) and the ON CONFLICT DO UPDATE unconditionally overwrites last_period, rows_upserted and status. The table is one-row-per-source (PK source) with no history. Live proof: prod vg_vic has last_period=NULL and rows_upserted=0 despite 7,938 vg_vic rows to 2024-12-31 in house_prices — after one failed run you can no longer tell when a source last worked or how much it loaded, which is exactly the forensics needed for the F01 breakage.

**Evidence:** store.go:114-123 (unconditional overwrite); main.go:372,377,382,388; migrations/000053:44-51 (PK source); prod: vg_vic → last_period NULL / rows 0 vs house_prices vg_vic 7,938 rows max(period) 2024-12-31.

**Suggested fix (advisory, you may do better):** On status='error', preserve last_period/rows_upserted (COALESCE against the existing row) and only update status/detail/last_fetched_at; or add an append-only run-history table.

### F20 [medium/risk] The dual-service proto parity test and all 20+ kill-switch regression tests do not gate PRs — a drifted visibility annotation or broken kill switch merges green

**Detail:** proto_parity_test.go is the sole enforcement of the housing dual-add contract (each of the 11 HousingService rpcs must exist on the legacy service with identical types and visibility/required_role annotations), and house_prices_test.go holds the HOUSING_DROP_LISTINGS_ENABLED kill-switch regression suite. Both live in the run-tests job skipped on PRs (`if: github.event_name != 'pull_request'`). A drifted visibility annotation (silently making one mounted path auth-required or public) or a broken kill switch merges green and only fails post-merge at deploy time. Known repo-wide gap (documented for politicians), but here it specifically guards the housing licence-exposure controls (F07/F08's only runtime gate).

**Evidence:** terraform-deploy.yml:1488-1491 (run-tests skipped on PRs); proto_parity_test.go:19-83; house_prices_test.go has 13+ t.Setenv("HOUSING_DROP_LISTINGS_ENABLED", ...) tests.

**Suggested fix (advisory, you may do better):** Run at minimum the fast unit slice (proto parity + house_prices kill-switch tests) in a PR-triggered job; keep testcontainers integration post-merge if cost is the concern.

