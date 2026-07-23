# Economy Phase-3 Round 2 Implementation Plan

> Executor: **Codex CLI** (`codex exec -s workspace-write`, `gpt-5.6-sol` @
> high), one task per invocation from the worktree cwd; coordinator (fable)
> probes/reviews/commits. Worktree `~/projects/.worktrees/shorted-economy-map`,
> branch `feat/economy-phase3-round2` (off origin/main). Probe CSVs live in
> /tmp/abs-{HSI_M,LEND_HOUSING,QBIS,CWD}.csv + /tmp/crime-states.xlsx for
> code verification without network.

**Spec:** `docs/superpowers/specs/2026-07-23-economy-phase3-round2-design.md`

## Task 1 — SDMX importers: household spending + lending + construction (A+B+D)  [ ]
Three clone-shape importers (spending.go, lending.go, construction.go) per
pinned filters; registry entries; modes `spending|lending|construction` in
`all` before markets; fixtures incl. must-filter rows; magnitude guards
(AUS spending $60–100B/mo, lending investor $... plausible $bn/qtr,
construction $bn/qtr). Coordinator live-smokes all three.

## Task 2 — QBIS business indicators (C)  [ ]
business.go with the NEW pinned ANZSIC slug map (pin division letters from
/tmp/abs-QBIS.csv), current-families-only emission, `-mode business`.
Coordinator live-smoke + stale-family absence check.

## Task 3 — Recorded crime XLSX + derived rate (E)  [ ]
crime.go (release-page discovery + per-sheet parse, govfin machinery, np
skip, offence static map, per-sheet resilience) + `-mode crime`; rate family
added to `-mode derived` (per-family resilience from round 1). Synthetic
excelize fixtures. Coordinator live-smoke incl. NSW homicide magnitude
(~150–450/yr full range 1993→) + rate recompute vs erp.

## Task 4 — Web: metrics, candidates, state charts, crime card, chat keys (F)  [ ]
Registry entries + candidates + charts + crime card w/ count|rate toggle +
chat cheat-sheet additions. jest/tsc/build; coordinator Playwright.

## Task 5 — Integration + ship (coordinator)  [ ]
Full suites, 8-angle review + fix batch, docs (architecture §2/§3 + roadmap
tick-offs), PR, user-gated merge, deploy watch, prod collector execute
(user-gated), live verify.
