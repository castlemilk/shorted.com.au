# Economy Phase-3 Round 1 Implementation Plan

> Executor: **Codex CLI** (`codex exec -s workspace-write`, model
> `gpt-5.6-sol` @ **high**), one task per invocation from the worktree cwd,
> driven and reviewed by the coordinator (fable). Worktree:
> `~/projects/.worktrees/shorted-economy-map`, branch
> `feat/economy-phase3-round1` (off origin/main, includes roadmap #330).
> NEVER touch `~/projects/shorted`. Codex sandbox has no network and can't
> commit — coordinator runs live smokes/probes and commits after review.

**Spec:** `docs/superpowers/specs/2026-07-22-economy-phase3-round1-design.md`
**Goal:** the flagship commodity-vs-shorts correlation story end-to-end:
5 importer/derived data families, the industry-intel bridge UI, the chat
tool, and the post-promote revalidate sweep. No DB migrations.

Shared context every task gets: conventions in `CLAUDE.md` (Economy section) +
`docs/economy-architecture.md` §8 recipes; test with
`go test ./services/economy-collector/...` (or scoped pkg); web:
`SKIP_ENV_VALIDATION=1` builds, jest; commit is coordinator-side with
`--no-verify`. Local DB `postgresql://admin:password@localhost:5438/shorts`.

## Task 1 — RBA importers: commodities + credit (spec A+B)  [ ]
Generalize `rba.go`'s table struct (per-table topic/sourceKey/adjustment,
per-spec product) keeping existing rates/fx output byte-identical (test
asserts unchanged keys+dims). Add I2 (6 series) + D1 (5 series) per pinned
Series IDs. Fixtures from real CSV headers; registry entries in `sources.go`;
magnitude guards per spec. Verify: unit tests green; coordinator runs live
`-mode rba` against local DB and checks catalog + magnitudes.

## Task 2 — SDMX importers: job vacancies + WPI (spec C+D)  [ ]
New `vacancies.go` + `wpi.go` cloned from the newest importer shape (strict
`sdmx.go` helpers, fail-closed filters, pinned codes in dated comment
blocks), fixtures, registry, wire `-mode vacancies|wages` + `all`.
Verify: tests; coordinator live-runs both modes, checks 9 + 18 series and the
AUS 324k / 3.2% magnitudes.

## Task 3 — Derived: industry short interest + real wages + trade balance (spec E+F)  [ ]
Extend `markets.go` with the industry derivation (static GICS slug map +
noise floor + drift tripwire) and add `-mode derived` (real wages from
quarterly CPI index; trade balance; both fail-loud). `all` ordering: derived
runs last. Verify: tests incl. slug-map bidirectional check vs web slugify;
coordinator live-runs `markets` + `derived` and sanity-checks a WA
materials-vs-bulk eyeball + real-wage ≈ wpi_yoy − cpi_yoy recompute.

## Task 4 — Chat tool `get_economic_series` (spec G)  [ ]
`tools.go` + `tool_executor.go` + system-prompt line + unit tests per the
existing 8-tool pattern. Verify: `go test ./services/chat-service/...`;
coordinator smoke against local chat service if wired, else test-level.

## Task 5 — Web: correlation candidates + industry-intel strip (spec H+I)  [ ]
Extend state-correlations candidates (national overlays valid vs state
shorts); generalize the dual-axis + rolling-Pearson machinery out of
`state-correlations.tsx` (no fork) and mount the industry economy-context
strip in `/industry-intelligence`. Jest + tsc +
`SKIP_ENV_VALIDATION=1` build; coordinator Playwright-verifies both surfaces
(needs Task 1–3 data ingested locally).

## Task 6 — Deploy-workflow revalidate sweep (spec J)  [ ]
`terraform-deploy.yml` post-promote step, browser UA, GH-secret name
verified by coordinator (`gh secret list`), `continue-on-error: true`.
Update the ops-runbook note in `docs/economy-architecture.md` §7. Verify:
`actionlint`/yaml parse + coordinator eyeball; live proof rides the ship.

## Task 7 — Integration + ship (coordinator)  [ ]
Full suites, whole-diff fable review, docs update (architecture §2 source
table + catalog counts + roadmap tick-offs), PR, user-gated merge,
deploy-watch, prod collector execute (new modes), revalidate sweep (now
automated — verify the workflow step did it), live verify /economy/[state]
chips + industry strip + chat tool, memory update.
