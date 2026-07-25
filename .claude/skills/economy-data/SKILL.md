---
name: economy-data
description: Operate and extend the Shorted economy data platform — run the periodic research sweep (new ABS/RBA sources, upstream drift, freshness), probe and pin new data sources, build importers/derived series, and ship them to prod. Use when checking economy data freshness, hunting new data sources, adding an economy series/importer, investigating a collector failure, or on the scheduled economy-sweep interval.
---

# Economy Data — Research Sweep & Source Extension

Operating manual for growing and maintaining the `economic_series` platform
(~800 series, 20 sources, correlation matrix). Architecture:
`docs/economy-architecture.md`. Backlog: `docs/economy-roadmap.md`. Prior
build specs: `docs/superpowers/specs/2026-07-2*-economy-*.md`.

**Iron rules (violations have all caused real incidents):**
1. **Probe truth wins.** Never invent SDMX codes, series IDs, or sheet layouts
   — pin every code from a live probe, dated, in the importer's comment block.
2. **Never derive series keys from source labels** — stable codes/static maps
   only (labels mutate between releases and silently fork history).
3. **Check the LAST NON-EMPTY VALUE, not just column presence** — columns
   outlive their series (RBA DGFACB12 died 2019 with its column intact;
   QBIS state×industry died 2022-Q3; Weekly Payroll Jobs died entirely).
4. **Stock-price return math uses `adjusted_close` with per-pair column
   consistency** — raw `close` turns ASX consolidations into fake +900%
   returns (two prod incidents).
5. **WAF-mandatory UA** on every ABS/RBA/release-page fetch:
   `shorted-data/1.0 (+https://shorted.com.au)` (+ `Accept:
   application/vnd.sdmx.data+csv;labels=both` for SDMX data).

## 1. The periodic research sweep (interval mode)

Run in order; each step's output feeds the report at the end.

### 1a. Freshness (deterministic)
```bash
cd services/economy-collector
DATABASE_URL=postgresql://admin:password@localhost:5438/shorts go run . -mode freshness   # local
# prod: read-only — point DATABASE_URL at the prod SESSION pooler URL from services/.env
```
Non-zero exit = at least one source stale (also checks correlation-matrix
age). This also runs monthly in CI (`.github/workflows/economy-freshness.yml`,
8th, prod job execution — a failed run is the interval trigger for this
sweep). FROZEN sources (upstream-discontinued, e.g. abs-retail-trade since
2025-06) are reported, never alarmed. NOTE: the annual crime alarm is tuned
to fire when the next yearly release is DUE — a STALE crime source usually
means "check the release page for the new issue", not breakage. For each
STALE source: check the upstream release page for a schedule
change before assuming breakage; then check collector job logs
(`gcloud logging read ... job_name="economy-collector"`, config
`shorted-prod`).

### 1b. Catalog diff (new + removed ABS flows)
```bash
curl -s -A "shorted-data/1.0 (+https://shorted.com.au)" -H "Accept: application/vnd.sdmx.structure+json" \
  "https://data.api.abs.gov.au/rest/dataflow/ABS?detail=allstubs" -o /tmp/abs-flows-now.json
```
Diff `{id,version}` pairs against the committed snapshot
`services/economy-collector/probes/abs-flow-catalog.json`:
- **New flows** → candidate list (ignore `C21_*`/`CENSUS`/`C16_*` census noise).
- **Version bumps on PINNED flows** (grep importer files for `Version` consts)
  → re-probe that flow (§2) and re-run its magnitude cross-check; a bump can
  drop columns (CPI/WPI UNIT_MULT class) or change codes.
- **Removed pinned flows** → upstream discontinuation; escalate in the report.
- Update the snapshot file in the same PR as any resulting change.

### 1c. XLSX release-page checks (govfin, petroleum, crime)
Fetch each release page (UA rule) and confirm the cube link the importer
discovers still matches its pattern; for crime also confirm the Table-9 title
year advanced as expected (importer is title-driven since #346-era fixes).

### 1d. Report + next-cut proposal
Summarize: stale sources + cause, new candidate flows (with a 1-line value
judgment vs the roadmap tiers), version bumps handled, dead upstreams to
record in `docs/economy-roadmap.md`. If candidates justify a build round,
propose the cut per §3 — do NOT auto-build; the user approves rounds.

## 2. Probing a candidate source (before any code)

```bash
# SDMX structure: one-row-per-series dump reveals dimensions + codes + currency
curl -s -A "shorted-data/1.0 (+https://shorted.com.au)" -H "Accept: application/vnd.sdmx.data+csv;labels=both" \
  "https://data.api.abs.gov.au/rest/data/ABS,<FLOW>,<VER>/all?lastNObservations=1" -o /tmp/probe.csv
# then enumerate every dimension's values, note UNIT_MULT presence, TSEST
# availability PER REGION (states are often original-only), and record 2-3
# magnitude cross-checks (real values you can hand-verify later).
# RBA tables: https://www.rba.gov.au/statistics/tables/csv/<t>-data.csv —
# pin Series IDs from the 'Series ID' row AND check last non-empty values.
```
Version quirks seen: flow version `1.0` ≠ `1.0.0` (JV 404s on 1.0.0);
UNIT_MULT sometimes absent (CPI v2, WPI); quarterly data may be
original-only for states. Probe files go to /tmp and get referenced in the
spec; Codex has no network — everything it needs must be pinned in the spec
or saved as a probe file.

## 3. Building a round (the established cadence)

1. **Spec + plan** in `docs/superpowers/{specs,plans}/` (see the round 1–3
   files for the exact shape): every code pinned, magnitude guards stated,
   scope cuts justified, out-of-scope recorded with reasons.
2. **Branch** off origin/main; **check migration numbers at PR time** —
   parallel sessions consume them fast (000090→000093 renumber incident).
3. **Codex implements** one task per invocation:
   `codex exec -s workspace-write -m gpt-5.6-sol -c model_reasoning_effort='"high"' "<task>" < /dev/null`
   (the `< /dev/null` is load-bearing — background codex hangs on open stdin).
   Coordinator runs anything needing network/DB and feeds results back via
   `codex exec resume --last`.
4. **Live-smoke gate per task**: run the new `-mode`, verify series counts +
   magnitude cross-checks against the probe values in the DB.
5. **Review**: 2+ finder sweeps (correctness + cleanup) over the whole branch
   diff, verify/adjudicate, one fix batch, re-verify. Recurring finding
   classes to check first: chat cheat-sheet key vocabulary (wrong-key class
   ×2), formatter duplication, family-coupling failure modes, eager-fetch
   growth.
6. **Ship** (all prod writes are USER-gated — hand commands over, never
   self-merge): merge → deploy watch → migrations (if any) via **session
   pooler 5432** with `statement_timeout=0` BEFORE → collector execute →
   live verify via prod RPC + real-browser Playwright (curl is edge-blocked).

## 4. New-endpoint / API changes

Follow CLAUDE.md "Adding a New API Endpoint" — dual-add to the domain proto
AND legacy `ShortedStocksService`, `VISIBILITY_PUBLIC` on both, canonical
`cd proto && buf generate` (Codex can't reach buf.build — coordinator reruns
it), commit ALL outputs incl. Java SDK churn. Parity enforced by
`proto_parity_test.go`.

## Quick reference — landmine table

| Symptom | Cause / fix |
|---|---|
| SDMX 404 on probe | try version `1.0` vs `1.0.0`; flow may not exist at all (crime, GFS, payrolls) |
| `UNIT_MULT column not found` | some flows genuinely lack it (CPI v2, WPI) — drop from required, don't scale |
| blank OBS_VALUE errors | `OBS_STATUS=q` rows are normal — skip, don't fail |
| importer fine locally, dead on prod | shallow local history (~2-5 months) hides history-dependent bugs — prod is the real test |
| all states breach a return guard | systematic artifact, not cohort noise — check price columns (adjusted_close rule) |
| one small state breaches | real microcap volatility — per-state exclusion is by design |
| collector run fails but siblings persisted | per-family resilience working — read `partial ... written despite error` lines |
| codex background task hangs | `< /dev/null` missing |
| `gcloud` reauth loop | user must run `gcloud auth login` via `!` — short reauth window on ben@shorted.com.au |
