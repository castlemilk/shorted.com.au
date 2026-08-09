# Work package: collector-vg

Valuer-General ingest recovery: un-pin VIC workbook, make NSW runnable off-cloud, never-succeeded loudness

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

Three deliverables: (1) VIC: discover the latest houses-by-suburb-*.xlsx asset at
run time (scrape the listing page / API) instead of the pinned 2014-2024 asset id, with the
pinned URL as fallback; browser-realistic headers per the repo's existing ABS/stealthhttp
posture. (2) NSW: make the PSI ingest runnable from a residential rig the way the listings
tier is (env-driven, documented in the collector deploy dir) since Cloud Run egress cannot
clear the Cloudflare challenge - do not try to defeat the challenge from datacenter IPs.
(3) Loudness: a per-source 'has never succeeded in prod' / 'stale beyond threshold'
assertion path so a tier that silently never lands shows up as an error row + non-zero exit
(coordinate with the exit-code semantics in main.go; keep your change minimal and
compatible if you see parallel work there is planned - another work package touches
runOfficial exit codes).

## Findings (verbatim from the audit)

### F01 [high/bug] State VG suburb-median ingest is broken: NSW has never landed a prod row; VIC is 403-blocked AND pinned to a 2014-2024 workbook

**Detail:** runOfficial() wires vg_nsw and vg_vic (main.go:364-366) but both fail on every scheduled run. NSW: prod house_prices has ZERO source='vg_nsw' rows — the tier shipped in PR #237/#239 has never populated prod ('no NSW PSI years fetched'; valuergeneral.nsw.gov.au sits behind a Cloudflare challenge that Cloud Run's datacenter egress does not clear; the code comment's 'verified: 200' was almost certainly a residential-IP check). Live product impact: NSW 0/4,544 suburbs priced, QLD 0/3,235, WA 0/1,701 vs VIC 739/3,076 and SA 426/1,764 — the flagship state's map silently falls back to population colouring and contributes 0 sitemap URLs. VIC: last success 2026-07-05 (7,938 rows), now 403-ing, and even when the fetch works it can never advance past Dec-2024 because vicXLSXURL is hardcoded to the 'houses-by-suburb-2014-2024.xlsx' asset (vic_vpsr.go:24) — every VIC suburb serves ~20-month-old official medians.

**Evidence:** Prod: SELECT count(*) FROM house_prices WHERE source='vg_nsw' → 0; vg_vic → 7,938 rows, max(period)=2024-12-31, last success 2026-07-05. house_price_ingest_runs 2026-08-05: vg_nsw|error|'no NSW PSI years fetched'; vg_vic|error|'fetch VIC xlsx: unexpected status: 403'. Live ListStateSuburbs: NSW 0/4,544 priced. Code: main.go:344-366; vic_vpsr.go:24 (pinned asset 756581); nsw_vg.go:34.

**Suggested fix (advisory, you may do better):** Run the NSW PSI ingest from an egress that clears the Cloudflare challenge (residential rig path like the listings tier, or a one-off scoped local run); discover the latest houses-by-suburb-*.xlsx asset at run time instead of pinning; add per-source 'has never succeeded' assertions so a source that never landed is loud.

**Verifier note:** Every claim reproduced against code + prod. Code: main.go:364-366 wires vg_vic/vg_nsw; vic_vpsr.go:24 pins the 2014-2024 workbook (asset 756581) so VIC can never advance past Dec-2024; nsw_vg.go:100 'no NSW PSI years fetched' fires only when ALL yearly zip fetches fail. Prod DB: vg_nsw rows = 0 (never landed since #237/#239); vg_vic = 7,938 rows, max(period)=2024-12-31, max(fetched_at)=2026-07-05; house_price_ingest_runs 2026-08-05 shows vg_nsw error 'no NSW PSI years fetched' and vg_vic error 'fetch VIC xlsx: unexpected status: 403'. Coverage query reproduced exactly: NSW 0/4,544 priced, QLD 0/3,235, WA 0/1,701 vs VIC 739/3,076, SA 426/1,764. Product impact confirmed: state-suburb-map.tsx:78-88 silently falls back to population colouring when no suburb is priced, and sitemap.ts:546 gates suburb URLs on latestMedianPrice>0 so NSW/QLD/WA contribute zero suburb sitemap URLs. No later commit, open PR, or branch fixes any of this (git log on nsw_vg.go/vic_vpsr.go ends at #239; gh pr list has nothing relevant). Only the aside that the 'verified: 200' comment was a residential-IP check is unverifiable speculation, and it is not load-bearing. Severity stays high (not critical): data is absent/stale with graceful UI fallback rather than wrong, but it is a genuine shipped-and-never-worked reliability gap on the flagship state.

