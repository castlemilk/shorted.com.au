# Company State Exposure Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Operations-weighted company↔state exposure (LLM-backfilled JSONB + HQ fallback), flattened into an MV, served by two public RPCs, surfaced as two new economy-map metrics + a dossier "Operating here" section.

**Architecture:** `state_exposure JSONB` on company-metadata written by a dedicated enrichment-processor backfill mode (NOT the full-enrichment path); `mv_company_state_exposure` flattens JSONB + hq_state fallback for weighted SQL; RPCs follow the economy handler chain; UI extends the shipped map-metrics registry + state dossier.

**Spec:** `docs/superpowers/specs/2026-07-21-company-state-exposure-design.md`
**Branch:** `feat/state-exposure` (this worktree: `~/projects/.worktrees/shorted-economy-map`). The MAIN checkout at ~/projects/shorted belongs to another session — never touch it; all work happens in this worktree. The local dev DB (localhost:5438) is shared and has all data.

**Load-bearing anchors (scouted 2026-07-21 — verify line drift, don't rediscover):**
- Backfill-mode pattern: `services/enrichment-processor/main.go:140-149` (`--backfill-people` flag dispatch) — mirror it.
- LLM client: `services/pkg/enrichment/gpt_client.go` — OpenAI default, model gpt-5.2 (`:135`), `retryableOpenAICall`, `extractLikelyJSON` (`:595`). OPENAI_API_KEY in repo `.env`; local run env pattern `services/Makefile:183`.
- Structured-JSON field template: key_people (prompt `gpt_client.go:201-219`, parse `:257`, dbPerson `postgres.go:633`, `key_people = $N::jsonb` upsert `postgres.go:2090`).
- Migration template: `services/migrations/000003_add_enrichment_fields.up.sql`; next number 000083. `refresh_all_materialized_views()` definition — find it (grep migrations) and append the new MV.
- Candidate selection: `GetTopStocksForEnrichment` `postgres.go:1457` (market_cap DESC from `key_metrics->>'market_cap'`).
- RPC chain conventions: economy.go / postgres_economy.go / interfaces.go / adapters.go / cache.go / mocks regen (`go:generate mockgen` in interfaces.go) — exactly as Tasks 10-12 of the economy plan did.
- Map metrics registry: `web/src/@/lib/economy/map-metrics.ts` (serializable entries; note the two new metrics are NOT series-template metrics — see Task 5 for the aggregate-fed variant). Dossier: `web/src/@/components/economy/state-dossier.tsx`.
- Logo hydration at read time: copy whatever `mv_top_shorts`-based handlers do (grep logo_icon_gcs_url in store).
- Series/region slugs: nsw,vic,qld,sa,wa,tas,nt,act (+ 'international' for exposure only).

---

## Task 1: Migration 000083 — columns, hq_state backfill, MV

**Files:** `services/migrations/000083_add_state_exposure.up.sql` + `.down.sql`

Up migration (idempotent):
1. `ALTER TABLE "company-metadata" ADD COLUMN IF NOT EXISTS state_exposure JSONB DEFAULT '[]'::jsonb;` and `ADD COLUMN IF NOT EXISTS hq_state TEXT;`
2. hq_state backfill from address (case-insensitive, state token before AUSTRALIA):
```sql
UPDATE "company-metadata"
SET hq_state = lower((regexp_match(upper(address), ',\s*(NSW|VIC|QLD|SA|WA|TAS|NT|ACT)\s*,\s*AUSTRALIA'))[1])
WHERE address IS NOT NULL AND hq_state IS NULL;
```
3. `mv_company_state_exposure`: one row per (stock_code, region). LLM rows from `jsonb_array_elements(state_exposure)` (region/weight/basis, source='llm'); UNION fallback rows (weight 1.0, source='hq_fallback', basis='Registered office') for companies with `hq_state IS NOT NULL AND (state_exposure IS NULL OR state_exposure = '[]'::jsonb)`. Join company_name, industry, `NULLIF(market_cap,'')::numeric` (guard non-numeric with a `~ '^[0-9.]+$'` filter), logo_icon_gcs_url, and current short % (join the same latest-shorts source `mv_top_shorts` uses — check its definition; LEFT JOIN, short % nullable). Exclude region='international' from the MV? NO — include it (dossier shows AU-exposure honestly); aggregates filter it out.
4. UNIQUE index on (stock_code, region) enabling CONCURRENTLY refresh; index on (region, weight DESC).
5. Append the MV to `refresh_all_materialized_views()` (CREATE OR REPLACE the function with the existing body + new line — copy current definition from the latest migration that defined it).

Verify: apply locally (`make migrate-up`), re-run up file idempotently, spot-check: `SELECT * FROM mv_company_state_exposure WHERE stock_code='STO'` → hq_fallback row region='sa' (until Task 3 enriches). Commit.

## Task 2: Enrichment backfill mode `--backfill-state-exposure`

**Files:** `services/enrichment-processor/state_exposure_backfill.go` (+ test), `services/enrichment-processor/main.go` (flag dispatch), `services/pkg/enrichment/state_exposure.go` (+ test), store method in `services/shorts/internal/store/shorts/postgres.go` + interface in `services/pkg/enrichment/store.go` (mirror how --backfill-people plumbs its store access — READ that path first and copy it).

1. `services/pkg/enrichment/state_exposure.go`:
   - `type StateExposure struct { Region string `json:"region"`; Weight float64 `json:"weight"`; Basis string `json:"basis"` }`
   - `GenerateStateExposure(ctx, company)` on the OpenAI client (its own small method — do NOT touch EnrichCompany): system prompt "financial analyst; operations-weighted geographic exposure; ONLY valid JSON"; user prompt with name/code/industry/sector/summary/description (truncate description at ~1500 chars) requesting:
     `[{"region":"wa","weight":0.85,"basis":"Pilbara iron ore operations"}, ...]`
     Rules in prompt: regions from {nsw,vic,qld,sa,wa,tas,nt,act,international}; weights sum to 1.0; 1-5 entries; weight = share of operating assets/revenue-generating activity; use "international" for non-Australian operations; basis ≤ 8 words.
   - `ValidateStateExposure(raw []StateExposure) ([]StateExposure, error)`: drop invalid regions; drop weight ≤ 0; error if empty or > 6 entries; renormalize weights to sum exactly 1 (divide by sum); round to 2dp; TDD this function (valid pass-through, renormalization, invalid-region drop, empty error, garbage rejection).
2. Store method `UpdateStateExposure(stockCode string, exposure []byte) error` — simple parameterized UPDATE of the JSONB column (+ interface + mock if the enrichment store interface needs it — follow the people-backfill plumbing).
3. `state_exposure_backfill.go`: `runStateExposureBackfill(ctx, deps, limit int)` — select top `limit` by market cap WHERE `state_exposure = '[]'::jsonb OR state_exposure IS NULL` (reuse/parallel GetTopStocksForEnrichment's ordering; a direct SQL in the store method is fine), loop with modest concurrency (3), per company: generate → validate → marshal → UpdateStateExposure; log ok/fail counts; non-zero exit if > 20% fail. Flag: `--backfill-state-exposure` + `--limit` (default 300) in main.go mirroring --backfill-people.
4. Tests pass (`go test ./pkg/enrichment/... ./enrichment-processor/...`), build clean. Commit.

## Task 3: Local batch + sanity review

1. Run: `cd services && set -a && source .env 2>/dev/null; set +a; DATABASE_URL='postgresql://admin:password@localhost:5438/shorts?sslmode=disable' go run ./enrichment-processor --backfill-state-exposure --limit 300` (OPENAI_API_KEY from repo .env — check `services/.env` then repo root `.env`).
2. Sanity SQL: FMG mostly wa; STO sa+wa/nt-ish; BHP split incl. wa+qld; CSL majority international; CBA nsw-heavy + international. `REFRESH MATERIALIZED VIEW CONCURRENTLY mv_company_state_exposure;` then `SELECT region, count(*), round(sum(weight*market_cap)/1e9) FROM mv_company_state_exposure WHERE source='llm' AND region<>'international' GROUP BY 1 ORDER BY 3 DESC` — plausibility: nsw+vic dominate financials, wa heavy on materials.
3. Report the 5-company sample + aggregate table verbatim. If systematically bad (e.g. everything 1.0 single-state), iterate the prompt ONCE with explicit few-shot examples (BHP, CSL) and re-run failures only. Commit any prompt tweaks.

## Task 4: RPCs — ListStateCompanies + GetStateCompanyAggregates

Proto (shorts.proto, after economy messages; VISIBILITY_PUBLIC + gnostic, mirror economy RPCs):
```proto
rpc ListStateCompanies (ListStateCompaniesRequest) returns (ListStateCompaniesResponse) {...}
rpc GetStateCompanyAggregates (GetStateCompanyAggregatesRequest) returns (GetStateCompanyAggregatesResponse) {...}

message ListStateCompaniesRequest { string state = 1; int32 limit = 2; } // limit default 10 max 50
message StateCompany {
  string stock_code = 1; string company_name = 2; string industry = 3;
  double weight = 4; string basis = 5; double market_cap = 6;
  double short_percent = 7; string logo_url = 8; string source = 9; // llm | hq_fallback
}
message ListStateCompaniesResponse { repeated StateCompany companies = 1; }
message GetStateCompanyAggregatesRequest {}
message StateCompanyAggregate {
  string state = 1; int32 company_count = 2;        // weight >= 0.2, ex-international
  double exposure_weighted_market_cap = 3;
  double exposure_weighted_short_percent = 4;       // sum(w*mc*short)/sum(w*mc), shorts non-null only
}
message GetStateCompanyAggregatesResponse { repeated StateCompanyAggregate aggregates = 1; }
```
`buf generate`; store queries over the MV (`postgres_state_exposure.go`): list = WHERE region=$1 ORDER BY weight*market_cap DESC LIMIT $2 (validate state ∈ 8 slugs + 'international' rejected with InvalidArgument); aggregates = single GROUP BY region query ex-international. Full interface/adapters/cache/mocks plumbing + handlers (`state_exposure.go` in services/shorts) with cache keys, exactly the economy.go pattern. Handler tests (validation + happy path). Local curl smoke for both RPCs. Commit (proto+gen separate commit from handlers if cleaner).

## Task 5: /economy UI — map metrics + dossier section

1. Registry: the two new metrics are AGGREGATE-fed, not series-template-fed. Extend `map-metrics.ts` with a discriminated variant: `kind: "aggregate"` entries `{ key: "company_footprint", label: "Company footprint", legendLabel: "ASX company footprint (exposure-weighted market cap)", format: "aud", palette: "continuous", aggField: "exposureWeightedMarketCap" }` and `{ key: "local_short_interest", label: "Local short interest", legendLabel: "Short interest of locally-operating companies (exposure-weighted)", format: "percent", palette: "continuous", higherIsBad: true, aggField: "exposureWeightedShortPercent" }`. Existing series metrics get `kind: "series"` (default). Type the union so seriesKeysFor is only called on series metrics (tests updated).
2. Explorer: when metric.kind === "aggregate", fetch via a new client action `getStateCompanyAggregatesClient()` (add to getEconomyClient.ts + server twin in getEconomy.ts for parity) with react-query key ["economy-map-agg"]; build valueById from aggregates (no spark/yoy — tooltip shows value + company count; rank still works). Tooltip adapts (no sparkline for aggregate metrics; shows "N companies operating here").
3. Dossier "Operating here": new client component `state-companies.tsx` — `listStateCompaniesClient(state, 8)` (new client action) → rows: logo (next/image — host must already be allowlisted; use the same logo component/pattern the stock pages use if importable, else plain img per repo convention — CHECK how other client components render logo_icon_gcs_url), code+name link to /shorts/[code], weight badge ("WA 85%" — or "AU 22%" style honesty for low-AU companies), industry, short % chip, hq_fallback rows marked "HQ-based" muted tag. Attribution footnote: "Operations-weighted, AI-estimated from company disclosures · HQ-based where noted". Mount in StateDossier above TopExports.
4. Jest: registry union tests; verification: local dev servers + Playwright — switch to both new metrics (fills + tooltips), open WA dossier ("Operating here" shows FMG/RIO-type names with weights), screenshot. Build check (ISR intact). Commit.

## Task 6: CI wiring + final review + PR

1. terraform-deploy.yml prod migration list += `-f /migrations/000083_add_state_exposure.up.sql`.
2. Full suites (go + jest + tsc + build), final whole-diff review (integration pass: MV↔RPC↔UI agreement, RSC boundary, no fn props, registry union soundness).
3. Push, `gh pr create` (summary + screenshots + "post-merge ops: run prod backfill" note). Do NOT merge; do NOT run the prod backfill — both are explicitly user-gated; surface them in the final report.

## Self-review notes
- The enrichment write path deliberately bypasses the full-enrichment/quality-gate machinery (dedicated column, dedicated mode) — matches the --backfill-people precedent.
- 'international' is stored + shown but excluded from map aggregates.
- market_cap is TEXT in company-metadata — every cast must guard `~ '^[0-9.]+$'`.
- Prod backfill (~300 LLM calls) and PR merge are user decisions.
