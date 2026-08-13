# Work package: repo-hygiene

Provenance hygiene: purge committed portal content, synthetic fixtures, CI provenance gate, deploy-artifact cleanup

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

F13: replace the 4 committed testdata files containing real captured REA/Domain
portal content with SYNTHETIC fixtures that preserve the structural features the extraction
tests exercise (build a small fixture generator; hand-craft is fine); flip CRAWL_TRACE
default output location out of the repo tree. Then add a lightweight CI provenance gate
(script + workflow step) that fails if files matching portal-content signatures (realestate
.com.au / domain.com.au markup fingerprints) appear under services/**/testdata or web/.
F27: fix the committed deploy templates so they no longer schedule the block-prone night
hours or instruct operators to rebuild the rejected rig configuration - align them with the
current run-housing-crawl.sh posture. Note: the files are in git history; note in your
summary that history purge is a separate operator decision.

## Findings (verbatim from the audit)

### F13 [medium/risk] Real captured REA/Domain portal content is committed to the PUBLIC repo in 4 testdata files, and CRAWL_TRACE's default relative output dir is gitignored in only one directory

**Detail:** The repo is PUBLIC, and testdata/rea-pagemeta.html + domain-pagemeta.html (duplicated in the jobs fork) contain genuinely captured portal payloads: real New Farm QLD listings with full addresses ('33/75 Welsby Street', '312 Bowen Terrace'), real listing IDs, prices ('Offers over $2.4m', '$1,050,000'), lat/lng, and a live canonicalSearchId — contradicting the repo's own rules (000076: raw listing rows 'MUST NEVER be republished'; stated fixture hygiene: proprietary fixtures live outside the repo, NOT committed). Scale is small (~5KB) but it is verbatim ToS-restricted content republished on GitHub. Compounding the leak path: crawl_trace.go writes per-page portal screenshots + raw HTML to a CWD-relative 'traces' dir whose only .gitignore coverage is anchored inside services/house-price-collector/ — running with CRAWL_TRACE=1 from repo root, services/, or the jobs fork drops full portal pages into unignored paths of the public working tree (the testdata files prove this class of commit happens in practice).

**Evidence:** git ls-files → 4 files; rea-pagemeta.html contains fullAddress '33/75 Welsby Street, New Farm, Qld 4005' + id 151775764; domain-pagemeta.html '312 Bowen Terrace' + '$1,050,000' + lat -27.462; gh repo view = PUBLIC; crawl_trace.go:50,73 (relative 'traces' default); grep traces in root/services .gitignore = 0 matches; only services/house-price-collector/.gitignore:5-7 covers it.

**Suggested fix (advisory, you may do better):** Replace all 4 fixtures with synthetic data preserving the exact JSON shape (tests only assert structure/counts); optionally purge blobs from history; add unanchored 'traces/' to the root .gitignore and/or default CRAWL_TRACE_DIR to an absolute os.TempDir()/$HOME path.

### F27 [medium/risk] Committed deploy artifacts rebuild the rejected rig: templates schedule the block-prone night hours, the README installs the retired legacy runner and documents a wrong env var, and drain rounds buffer ~48 min of logs

**Detail:** (a) The committed launchd templates fire at 03:00 (delta) / 02:00 (full), but REA/Kasada clearance measurably degrades late-night (twin rc=3 circuit trips ~00:22-00:30), which is why the ACTUALLY-INSTALLED plists run 10:00/08:00 — a fresh operator or new rig following deploy/README.md restores the bad night schedule the production experience rejected. (b) README traps: it documents CRAWL_RESUME_WINDOW_H but the code reads CRAWL_LISTINGS_RESUME_WINDOW_H (setting the documented var is a silent no-op); its 'One-time per Mac' section installs the LEGACY com.shorted.housing-crawl static-shard runner, retired on the live rig in favour of delta/full; and the five-silent-outage-modes diagnosis checklist exists only in auto-memory, not the runbook. (c) hc_drain_until_empty captures a whole -mode agent round (out="$($BIN -mode agent 2>&1)") and only appends to the log at round end (~48 min for 20 jobs), which already caused a live run to be misdiagnosed as a stall.

**Evidence:** deploy/com.shorted.housing-delta.plist.template Hour=3 / housing-full Hour=2 vs installed ~/Library/LaunchAgents Hour=10/8 (verified 2026-08-09); memory residential-ip-scaling.md (daytime-on-purpose); deploy/README.md:317 vs crawl_listings.go:114 (env name); README:40-61 (legacy runner install); housing-crawl-common.sh:128-131 (buffered capture); memory housing-crawl-outage-modes.md diagnosis note.

**Suggested fix (advisory, you may do better):** Change the templates to the proven daytime hours with the Kasada rationale in a comment; fix the env name; restructure the README so delta/full is the primary path (legacy runner marked deprecated) and port the outage-modes checklist into it; stream drain output via tee -a while capturing (preserves the grep contracts).

