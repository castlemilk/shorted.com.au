# Australian Economy Platform — Architecture & State of the World

Last updated **2026-07-22** (post PR #328). Shipped across PRs #307 (series
layer + collector), #309 (map explorer), #311 (navigation), #316/#317 (company
state exposure), #319 (state pages, iconography, government finance,
correlations), #321/#323 (ISR/KV resilience), #324 (docs v1), #328 (banners,
centered silhouettes, approvals/retail/population, govfin detail + finance
links). Everything below is **LIVE on prod**. NOTE: the monolithic
`shorts.proto` has since been split per-domain — economy RPCs now live in
`proto/shortedapi/shorts/v1alpha1/economy.proto` as **`EconomyService`**
(4 RPCs); imports come from `~/gen/shorts/v1alpha1/economy_pb`.

The platform has one load-bearing idea: **a single generic economic-series
layer** (SDMX-shaped catalog + observations) that every source normalizes into
and every surface reads from. Adding a data source never touches the API or
frontend; adding a chart never touches ingestion.

```
ABS SDMX (7 flows) ─┐                                 ┌─ /economy (map hub, ISR 3600)
RBA CSV            ─┤                                 ├─ /economy/[state] (SSG ×8, banners)
ABS GFS XLSX       ─┼→ economy-collector → economic_  ┼─ correlations / dual-axis overlays
DCCEEW APS XLSX    ─┤  (11 modes)          series +   │
shorts DB (derived)─┘  monthly Cloud Run   observatns └─ industry-intel context (phase 3, unbuilt)
                       Job (5th, 17:00 UTC)     ↑
                        EconomyService: ListEconomicSeries / GetEconomicSeries
                        + ListStateCompanies / GetStateCompanyAggregates (public)
```

**Live catalog size** (prod + local parity, 2026-07-22): 472 series —
trade 196 · petroleum 126 · govfin 56 · population 35 · labour 21 · retail 9 ·
approvals 8 · gdp 8 · markets 8 · rates 3 · cpi 2. ~120k observations.

## 1. Data model

Two tables (migration `000081`), deliberately SDMX-shaped:

- **`economic_series`** — catalog: `series_key` (stable slug), `topic`,
  `metric`, `product`, `region_type`, `region_code`, `region_name`, `unit`,
  `frequency`, `adjustment`, `dimensions JSONB` (raw source codes for
  provenance), `source_key` (→ shared `industry_intelligence_sources`
  registry), `licence`.
- **`economic_observations`** — `(series_id, period DATE, value)`,
  upsert-overwrite (latest vintage wins; no revision history).

**Series-key convention**: `topic.metric[.product].region[.adjustment]`,
adjustment segment only when not `original`. Examples:
`rates.cash_rate_target.aus` · `retail.turnover.total.wa.seasadj` ·
`approvals.dwelling_units.total.qld` · `population.net_overseas_migration.total.vic` ·
`govfin.expenses.interest.nsw` · `markets.short_interest_wavg.qld` ·
`trade.export_value.crude_materials_inedible_except_fuels.wa`.

**Iron rule**: key segments come ONLY from stable codes or static maps (the
SITC code→slug map in `trade.go` is the canonical example) — never from
slugified source labels, which mutate between releases and silently fork
series history.

Related migrations: `000082` (registry `signal_kind` += economic_series),
`000083` (company `state_exposure` + `hq_state` + `mv_company_state_exposure`),
`000085` (registry `collection_method` += derived).

## 2. Sources — the full reference (11 live)

| source_key | Publication (reference link) | API/flow | Series | Freq | Licence |
|---|---|---|---|---|---|
| `rba-key-indicators` | [RBA Statistical Tables](https://www.rba.gov.au/statistics/tables/) — F1.1 Interest Rates, F11.1 Exchange Rates | CSV `rba.gov.au/statistics/tables/csv/{f1.1,f11.1}-data.csv` | cash_rate_target (monthly); aud_usd + trade_weighted_index (daily) | M/D | CC-BY-4.0 |
| `abs-cpi` | [ABS Consumer Price Index](https://www.abs.gov.au/statistics/economy/price-indexes-and-inflation/consumer-price-index-australia/latest-release) | SDMX `CPI` v2.0.0 | index (quarterly), annual_change (monthly, since 2025-04) | Q/M | CC-BY-4.0 |
| `abs-labour-force` | [ABS Labour Force, Australia](https://www.abs.gov.au/statistics/labour/employment-and-unemployment/labour-force-australia/latest-release) | SDMX `LF` | unemployment_rate, participation_rate, employed_persons — seasadj, 7 regions (no NT/ACT upstream) | M | CC-BY-4.0 |
| `abs-merch-trade-state` | [ABS International Trade in Goods](https://www.abs.gov.au/statistics/economy/international-trade/international-trade-goods/latest-release) | SDMX `MERCH_EXP`/`MERCH_IMP` | export/import_value × 11 SITC products × 9 regions (98/direction) | M | CC-BY-4.0 |
| `abs-state-accounts` | [ABS National Income, Expenditure and Product](https://www.abs.gov.au/statistics/economy/national-accounts/australian-national-accounts-national-income-expenditure-and-product/latest-release) | SDMX `ANA_SFD` | state_final_demand_chain_volume (seasadj, 8 states — SFD is the honest proxy; **no GSP SDMX flow exists**, 5220.0 is Excel-only) | Q | CC-BY-4.0 |
| `dcceew-petroleum-statistics` | [Australian Petroleum Statistics](https://www.energy.gov.au/publications/australian-petroleum-statistics) (page WAF-blocks bots → discovery via [data.gov.au CKAN](https://data.gov.au/data/api/3/action/package_show?id=australian-petroleum-statistics)) | XLSX (monthly issue) | refinery_input/output, imports/exports (14 products), sales incl. by-state | M | CC-BY-4.0 |
| `abs-government-finance` | [ABS Government Finance Statistics, Australia](https://www.abs.gov.au/statistics/economy/government/government-finance-statistics-australia/latest-release) — **no SDMX flow exists** (proven, 1,224-flow scan) | XLSX quarterly workbook, Tables 5–12 (per-state general-government Operating Statements) | revenue (+taxation, +grants), expenses (+employees, +interest = SUM of 'Interest on defined benefit superannuation' + 'Other interest expenses'), net_operating_balance — 8 states; ~3 quarters per cube, history accumulates via upsert | Q | CC-BY-4.0 |
| `abs-building-approvals` | [ABS Building Approvals, Australia](https://www.abs.gov.au/statistics/industry/building-and-construction/building-approvals-australia/latest-release) | SDMX `BA_SA2` (state-level rows; data from 2021-07) | dwelling_units — 8 states | M | CC-BY-4.0 |
| `abs-retail-trade` | [ABS Retail Trade, Australia](https://www.abs.gov.au/statistics/industry/retail-and-wholesale-trade/retail-trade-australia/latest-release) | SDMX `RT` | turnover (seasadj — **keys carry `.seasadj`**), aus + 8 states; national ≈ $37.9B/mo | M | CC-BY-4.0 |
| `abs-population` | [ABS National, state and territory population](https://www.abs.gov.au/statistics/people/population/national-state-and-territory-population/latest-release) | SDMX `ERP_Q` + `ERP_COMP_Q` | erp (level) + natural_increase / net_interstate_migration / net_overseas_migration | Q | CC-BY-4.0 |
| `derived-shorted-markets` | Derived in-house from [ASIC short position reports](https://asic.gov.au/regulatory-resources/markets/short-selling/short-position-reports-table/) (our `shorts` table) × the exposure model (§4) | SQL (`markets.go`, DISTINCT-ON monthly-last, ~100ms) | short_interest_wavg — 8 states, 2015→, **current-constituent basis** (present-day weights/market caps applied retrospectively — documented caveat) | M | derived |

**Probe discipline** (every SDMX importer): dimension codes are pinned from
live probes, recorded in dated comment blocks, parsed **by column name** via
`pkg/absdata` (survives reorder), and **fail closed** — a missing filter
column is an error, never a silently-disabled filter. The three newest
importers additionally use `sdmx.go`'s strict helpers
(`requireSDMXColumns`/`requireSDMXRow`/`sdmxScaleStrict`).

**Magnitude cross-checks recorded at build time** (rerun these when a flow
version bumps): NSW ERP 8.64M · national retail $37.9B/mo · NSW GFS revenue
$31.4B/qtr (8 states sum to ABS "Total State") · SFD 8-state sum within 0.5%
of ANA_AGG national GDP · WA short-interest hand-recompute exact match.

**Upstream quirks that look like bugs but aren't**: ABS confidentialises LNG
out of state-level trade splits (WA "mineral fuels" exports read tiny — real);
NT/ACT have no seasonally-adjusted labour series; DCCEEW folds ACT fuel sales
into NSW; CPI's UNIT_MULT column doesn't exist in v2.0.0; ANA_SFD's UNIT_MULT
always reads 0 despite $m values (hardcoded ×1e6, cross-validated).

## 3. Collector — `services/economy-collector`

Single binary, `-mode sources|rba|cpi|labour|trade|gdp|petroleum|govfin|approvals|retail|population|markets|all`.
Cloud Run Job (min instances 0), monthly scheduler (5th, 17:00 UTC),
`terraform/modules/economy-collector`, image in `terraform-deploy.yml`'s
`build-docker-images` matrix.

- Store: pgx on the Supabase txn pooler (6543, SimpleProtocol), per-source
  transactions, **0 observations = error** (drift tripwire), catalog identity
  fields immutable on conflict; petroleum/govfin have per-sheet resilience
  (healthy sheets persist, run still exits non-zero on any drift).
- `pkg/absdata`: shared ABS SDMX-CSV + RBA CSV clients; UA
  `shorted-data/1.0 (+https://shorted.com.au)` is WAF-mandatory.
- Registry: upserts into `industry_intelligence_sources`;
  `public_enabled = existing OR EXCLUDED` (never downgrades).
- First run in a fresh env: `gcloud run jobs execute economy-collector`.

## 4. Company state exposure

Operations-weighted footprints ("umbrella a company to where economic activity
happens"): weight vectors over 8 states + `international` — FMG→WA .9,
BHP→WA .55/QLD .2/SA .1/intl .15, CSL→intl .8, generated by
`enrichment-processor --backfill-state-exposure` (gpt-5.2, BHP/CSL few-shots,
validation renormalizes to 1.0 and merges duplicate regions), top 300 by
market cap = 93.8% of total; `hq_state` (regex from address) is the weight-1.0
fallback. Flattened by `mv_company_state_exposure` (llm 959 + hq_fallback
1,657 rows on prod). **Prod schema drift warning**: prod `company-metadata`
has NO `sector`/`description` columns — query only columns present in BOTH
environments.

## 5. Read API — `EconomyService` (economy.proto)

Four public RPCs (`VISIBILITY_PUBLIC` on the method IS the auth story):
- `ListEconomicSeries` (catalog, filterable, cap 500)
- `GetEconomicSeries` (≤50 keys × ≤600 obs, newest-600-then-ascending)
- `ListStateCompanies(state, limit)` (weight × market-cap ranked)
- `GetStateCompanyAggregates()` (per-state count / exposure-weighted market
  cap / exposure-weighted short %; `international` excluded)

Handlers normalize keys (trim/lowercase/dedup/sort) before both cache key and
store call. Store: `postgres_economy.go` / `postgres_state_exposure.go`,
index-covered LATERAL joins.

## 6. Frontend

### `/economy` — hub (ISR 3600)
SSR tiles (one `getEconomicSeries` call, **KV-backed** — §7) + client map
explorer: national choropleth (housing's `choropleth-map.tsx` +
`states.topojson`; feature ids are numeric ABS STE codes "1".."8" bridged via
`@/lib/housing/states.ts`), "Colour by" registry
`@/lib/economy/map-metrics.ts` (union `kind:"series" | "aggregate"`; series
metrics incl. retail + population_growth-derived-YoY-diverging; aggregate
metrics read `GetStateCompanyAggregates`), tooltips (value/YoY/sparkline/rank;
mobile <640px pins to the map bottom; desktop clamps to viewport), click →
`router.push('/economy/<state>')`.

### `/economy/[state]` — state pages (SSG ×8, ISR 3600)
- **Banner** (`state-banner.tsx`): gpt-image-1 economy-archetype background
  (light/dark AVIF from `web/public/economy-banners/manifest.json`; tooling
  `web/scripts/economy-banners/` — housing-banners clone, ~$0.50/set to
  regenerate) + the **state silhouette from states.topojson, centered** via
  d3-geo fitExtent (client piece behind ssr:false) + serif title + scrim.
- Breadcrumbs (shared `seo/breadcrumbs` + BreadcrumbList JSON-LD), SSR chip
  strip, then the client grid: unemployment/SFD/exports/imports/diesel +
  retail turnover + dwelling approvals + population charts (availability
  derived from the registry's `unavailableStates` — single source of truth);
  **State finances** (revenue vs expenses, net operating balance + the
  taxation/grants/employees/interest breakdown + "Sources & further reading"
  from `@/lib/economy/state-finance-links.ts` — hand-curated budget-paper URLs
  per state + the ABS GFS release, external links rel=noopener);
  **correlations** (dual-axis overlay of `markets.short_interest_wavg` vs a
  switchable series; rolling-Pearson chips |r|≥0.4 n≥12 with quarterly
  forward-fill alignment — empty chips = no pair clears the bar = correct);
  "Operating here" companies; top export commodities (SITC-icon rows on a
  strict grid).
- **Iconography**: 24-icon warm-duotone sprite (`web/scripts/economy-icons/`,
  gpt-image-1 direct path, ~$1/set) + typed `<EconomyIcon>`.

## 7. Resilience & ops runbook (hard-won)

- **ISR + connect-POST twin landmines** (#321/#323, both observed live): the
  `next:{revalidate}` tag on server-action connect transports is LOAD-BEARING
  (untagged → forced no-store → "Page changed from static to dynamic" throw
  during regen → placeholder BAKED for an hour). Even tagged, transient
  failures return undefined — the durable protection is the **Upstash KV
  last-good layer** in `getEconomy.ts` (sorted-key, toJson/fromJson
  BigInt-safe, never caches empty, `ECONOMY_TTL` 6h). Mirror it for any new
  ISR surface.
- **Every Vercel promote resets ALL ISR pages** to build-time placeholders.
  The deploy workflow promotes itself (~terraform-deploy.yml:1413-1456 —
  don't race it). Post-deploy revalidate sweep: secret is Vercel-*sensitive*
  (unpullable) but mirrored in GCP SM —
  `gcloud secrets versions access latest --secret=REVALIDATION_SECRET
  --project rosy-clover-477102-t5`, then POST
  `/api/revalidate?secret=…&path=/economy,/economy/nsw,…` with a **browser
  UA** (curl UA is edge-blocked).
- **Prod MV refresh**: txn pooler (6543) statement-timeout kills the full
  `refresh_all_materialized_views()` — refresh individual MVs via the session
  pooler (5432) + `PGOPTIONS="-c statement_timeout=0"`.
- **Live regen debugging**: `vercel logs shorted.com.au --scope
  document-analyser` while curling the page catches ISR errors in real time.
- **Local dev**: after large edits, Next dev servers serve stale chunks
  (404ing `error-*.js` is the tell) — kill dev, `rm -rf .next`, restart before
  trusting Playwright results. Worktree web builds need
  `SKIP_ENV_VALIDATION=1`.
- **Migration numbering across parallel sessions**: check origin/main's
  numbers at PR time, not branch-cut time (duplicate-000083 incident broke
  `migrate up` repo-wide).
- **Codex CLI implementation recipe** (used for #328; model/effort from
  `~/.codex/config.toml`): run `codex exec -s workspace-write` **from the
  worktree cwd** (sandbox roots at cwd); resume via `cd <worktree> && codex
  exec resume --last -c sandbox_mode='"workspace-write"'`; Codex's sandbox has
  no network and can't git-commit — the coordinator runs probes / image
  generation / commits and feeds results back through resume.

## 8. Extension recipes

- **New SDMX source**: probe (`/rest/dataflow/ABS?detail=allstubs` → flow →
  `lastNObservations=1`), pin codes in a dated comment, clone the newest
  importer shape (strict `sdmx.go` helpers), fixtures, `sources.go` +
  `main.go`, magnitude cross-check in the smoke.
- **New XLSX source**: clone petroleum/govfin (per-run discovery, sheet-specs,
  fuzzy header match, fail-loud drift, per-sheet resilience, synthetic
  excelize fixtures).
- **New map metric**: serializable entry in `map-metrics.ts` (series template
  — mind `.seasadj` suffixes — or aggregate field); explorer/legend/tooltips
  pick it up.
- **New state-page chart**: templated `EconomySeriesChart` in
  `state-charts.tsx`; availability from the registry, never a local list.
- **New derived series**: clone `-mode markets` (set-based SQL → SeriesDef/Obs,
  registry method `derived`, honest caveat in notes).
- **Regenerate banners/icons**: `web/scripts/economy-banners/` /
  `web/scripts/economy-icons/` READMEs — direct OpenAI path, resumable,
  coordinator supplies network + commits.

## 9. Roadmap (specced or discussed, unbuilt)

- Industry-intelligence "economy context" strip (phase 3 — the RPCs make it
  a UI-only task).
- LLM-composed state insight panels; commodity-level correlation drill.
- Approvals map metric (chip row currently at capacity); state OG images.
- AEMO electricity/gas + Resources & Energy Quarterly sources.
- Full-universe exposure enrichment (tail beyond the top 300).

## Appendix — primary references

- ABS Data API (SDMX): https://data.api.abs.gov.au (docs: https://www.abs.gov.au/about/data-services/application-programming-interfaces-apis/data-api-user-guide)
- ABS releases used: CPI · Labour Force · International Trade in Goods ·
  National Income/Expenditure/Product (SFD) · Government Finance Statistics ·
  Building Approvals · Retail Trade · National/State Population (links in §2)
- RBA statistical tables: https://www.rba.gov.au/statistics/tables/
- DCCEEW Australian Petroleum Statistics: https://www.energy.gov.au/publications/australian-petroleum-statistics (CKAN mirror: data.gov.au)
- ASIC short-position reports: https://asic.gov.au/regulatory-resources/markets/short-selling/short-position-reports-table/
- State budget papers: budget.nsw.gov.au · budget.vic.gov.au ·
  budget.qld.gov.au · statebudget.sa.gov.au · ourstatebudget.wa.gov.au ·
  budget.tas.gov.au · budget.nt.gov.au · ACT (treasury.act.gov.au) — the
  authoritative per-state list lives in `web/src/@/lib/economy/state-finance-links.ts`.
- Licensing: all ABS/RBA/DCCEEW data CC-BY-4.0 (attribution rendered per
  chart); `markets.*` series are in-house derivations (licence `derived`).
- Specs/plans: `docs/superpowers/{specs,plans}/2026-07-2{1,2}-*.md`.

- Phase 3+ backlog (exhaustive, tiered): `docs/economy-roadmap.md`.
