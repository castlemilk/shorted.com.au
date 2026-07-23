# Economy Phase-3 Round 3 Implementation Plan

> Executor: **Codex CLI** (`codex exec -s workspace-write < /dev/null`,
> `gpt-5.6-sol` @ high), one task per invocation; coordinator (fable)
> probes/reviews/commits. Branch `feat/economy-phase3-round3` (off
> origin/main). Local `shorts`/`stock_prices` history is shallow (~2 months)
> — smokes assert mechanics + magnitudes, prod derives full history.

**Spec:** `docs/superpowers/specs/2026-07-24-economy-phase3-round3-design.md`

## Task 1 — Collector: price-return index + per-capita families (A+B)  [ ]
markets family extension + derived families; single-scan refactor deferred
to Task 3 (touches the same SQL). Live smoke: mechanics + ±25% guard.

## Task 2 — Migration 000090/000091 + `-mode correlations` (C collector half, F)  [ ]
economic_correlations table; Go rolling-Pearson port with TS golden-vector
test; delete-and-replace per base; MV refreshed_at + staleness warning.
Coordinator: migrate-up on fresh DB check (the 000053 lesson) + live smoke.

## Task 3 — Proto + API: ListSeriesCorrelations + max_observations (C API half, E)  [ ]
Dual-add RPC, buf generate (commit ALL incl. Java SDK), handler/store,
markets.go single-scan refactor, chat executor passes limit through.
Coordinator: parity test + live RPC smoke.

## Task 4 — Web: precomputed correlations + chip overflow + new metrics (C web half, D)  [ ]
SeriesCorrelation precomputed mode w/ client-fallback; state pages +
industry strip on 2-series fetch; More-chips disclosure; approvals +
construction map metrics. jest/tsc/build; coordinator Playwright.

## Task 5 — Integration + ship (coordinator)  [ ]
Suites, review sweeps + fix batch, docs, PR (user merges), deploy watch,
prod: migration 000090/000091 via session pooler (user-gated), collector
execute (user-gated), live verify.
