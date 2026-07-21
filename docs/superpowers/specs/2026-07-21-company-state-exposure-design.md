# Company State Exposure — Design

**Date**: 2026-07-21
**Status**: Approved direction (user: operations-weighted, not HQ — "umbrella a company
to where they primarily operate and where economic activity happens")
**Depends on**: #307 (economy platform), #309 (map explorer), #311 (nav)

## Goal

Connect the ASX company universe to the economy map through **operations-weighted
state exposure** (FMG → WA where the iron ore is; BHP split WA/QLD/SA; CSL mostly
international), so the `/economy` map can show which companies' economic activity
lives where, and (phase 2) correlate state economics with local short interest.

## Attribution model

Per company: a weight vector over `nsw,vic,qld,sa,wa,tas,nt,act,international`
summing to ~1, with a one-line `basis` per entry ("Pilbara iron ore operations").
Weights reflect where operating assets / revenue-generating activity sit — NOT the
registered office. `hq_state` (regex-parsed from the existing `address` column,
2,034/4,499 populated) is kept as a separate field and used as a weight-1.0
fallback for companies not yet LLM-enriched.

## Scope (v1 = phase 1)

- Migration 000083: `state_exposure JSONB DEFAULT '[]'` + `hq_state TEXT` on
  `company-metadata` (hq_state backfilled in-migration via SQL regexp on address);
  `mv_company_state_exposure` materialized view flattening the JSONB (with
  hq_state fallback rows, `source` = 'llm' | 'hq_fallback') joined to
  company_name/industry/market_cap and current short % — refreshed with
  `refresh_all_materialized_views()`.
- Enrichment: a dedicated `--backfill-state-exposure` mode in enrichment-processor
  (mirrors `--backfill-people`): small prompt (name, industry, description,
  summary) → strict JSON array of {region, weight, basis} → validation (valid
  regions, weights renormalized to 1, 1-5 entries) → direct column write.
  Batch = top 300 by market cap (93.8% of total market cap, measured). No proto
  EnrichmentData change needed (dedicated mode, not the full-enrichment path).
- RPCs (public):
  - `ListStateCompanies(state, limit)` → companies ranked by exposure-weighted
    market cap (weight × market_cap desc); fields: code, name, industry, weight,
    basis, market_cap, short %, logo (read-time hydration), source.
  - `GetStateCompanyAggregates()` → per state: company count (weight ≥ 0.2),
    exposure-weighted market cap, exposure-weighted average short interest.
- `/economy` UI:
  - Map metrics + registry: "Listed company footprint" (exposure-weighted market
    cap) and "Local short interest" (exposure-weighted avg short %) — fed by
    `GetStateCompanyAggregates` (client, cached).
  - State dossier gains "Operating here": top ~8 companies with weight badge
    ("WA 85%"), basis on hover/subtext, short-interest chip, link to
    /shorts/[code]. Attribution line: "Operations-weighted (AI-estimated from
    company disclosures); HQ-based where noted."
- Honesty rules: `international` weight is displayed (CSL shows "AU exposure
  22%"); `hq_fallback` rows are visually marked; the methodology note names the
  LLM-estimation basis.

## Phase 2 (separate follow-up, out of this spec's plan)

Derived market series (`markets.short_interest_wavg.{state}` etc.) written into
`economic_series` by a collector `-mode markets` reading the shorts DB; dual-axis
correlation charts + rolling-Pearson insight chips in the dossier.

## Non-goals (v1)

- Revenue-segment-level precision (LLM estimates from public knowledge are the
  contract; ±0.1 weight accuracy is acceptable and labelled).
- Full-universe coverage (top 300 first; tail enriches later via the same mode).
- Any change to the full-enrichment prompt/quality-gate path.

## Ops

- Local batch first (local DB), review a sample (FMG/BHP/STO/CSL/CBA sanity),
  then prod batch (DATABASE_URL_PROD, ~300 LLM calls, est. < $5 gpt-5.2) — the
  prod run is flagged to the user before executing.
- Migration applies via the normal pipeline; add 000083 to the prod migration
  file list in terraform-deploy.yml (idempotent DDL, same as 000081/000082).

## Testing

- Go: exposure JSON validation (regions, renormalization, rejects), MV
  flattening + fallback SQL (integration), RPC handlers (mocks), aggregates math.
- Web: registry additions, dossier company-list rendering, jest suites green.
- E2E: local Playwright pass on the two new metrics + dossier section; live
  verify post-deploy.
