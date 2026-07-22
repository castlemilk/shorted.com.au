# Australian Economy Platform — Architecture

Shipped July 2026 across PRs #307 (series layer + collector), #309 (map
explorer), #311 (navigation), #316/#317 (company state exposure), #319 (state
pages, iconography, government finance, correlations), #321/#323 (ISR/KV
resilience). Everything below is LIVE on prod.

The platform has one load-bearing idea: **a single generic economic-series
layer** (SDMX-shaped catalog + observations) that every source normalizes
into and every surface reads from. Adding a data source never touches the API
or frontend; adding a chart never touches ingestion.

```
ABS SDMX ─┐                                      ┌─ /economy (map hub, ISR)
RBA CSV  ─┤                                      ├─ /economy/[state] (SSG ×8)
ABS XLSX ─┼→ economy-collector → economic_series ┼─ industry-intel (phase 2)
DCCEEW   ─┤   (8 modes)          + observations  │
shorts DB ┘   monthly Cloud     ↑                └─ correlations / overlays
  (derived)   Run Job           │
                          ListEconomicSeries / GetEconomicSeries (public RPCs)
```

## 1. Data model

Two tables (migration `000081`), deliberately SDMX-shaped:

- **`economic_series`** — the catalog. One row per series:
  `series_key` (stable slug), `topic`, `metric`, `product`, `region_type`,
  `region_code`, `region_name`, `unit`, `frequency`, `adjustment`,
  `dimensions JSONB` (raw source codes for provenance), `source_key` (into the
  shared `industry_intelligence_sources` registry), `licence`.
- **`economic_observations`** — `(series_id, period DATE, value)` with
  upsert-overwrite (latest vintage always wins; no revision history).

**Series-key convention**: `topic.metric[.product].region[.adjustment]`,
adjustment segment only when not `original`. Examples:
`rates.cash_rate_target.aus`, `trade.export_value.crude_materials_inedible_except_fuels.wa`,
`labour.unemployment_rate.total.nsw.seasadj`,
`gdp.state_final_demand_chain_volume.total.wa.seasadj`,
`govfin.net_operating_balance.total.vic`, `markets.short_interest_wavg.qld`.

**Iron rule learned in build**: key segments come ONLY from stable codes or
static maps (e.g. the SITC code→slug map in `trade.go`) — never from
slugified source labels, which mutate between releases and silently fork
series history.

## 2. Sources (8 live)

| source_key | Data | Method | Frequency | Landmines |
|---|---|---|---|---|
| `rba-key-indicators` | Cash rate (F1.1), AUD/USD + TWI (F11.1) | RBA CSV | monthly / daily | F11.1 is daily — frequency is stamped by the parser, not assumed |
| `abs-cpi` | All-groups index + annual change | SDMX | quarterly / monthly | CPI v2.0.0 has NO UNIT_MULT; index exists at both M and Q — FREQ-filter or you double-count; annual-change is monthly-only since 2025-04 |
| `abs-labour-force` | Unemployment/participation/employed by state | SDMX | monthly | Dimension is `REGION` not STATE; measures are M-prefixed (M13/M12/M3); NT+ACT have NO seasadj series → 21 series, not 27 |
| `abs-merch-trade-state` | Exports/imports by state × SITC | SDMX | monthly | National state code is `TOT`; UNIT_MULT=3 (thousands); ACT×SITC-4 empty → 98 series/direction; country filtered to TOT (never double-count); ABS confidentialises LNG out of state splits (WA "mineral fuels" looks tiny — it's real) |
| `abs-state-accounts` | State Final Demand (chain volume, seasadj) | SDMX | quarterly | **There is NO GSP dataflow in the SDMX API** (5220.0 is Excel-only; ANA_AGG is national-only) — SFD from ANA_SFD is the expenditure-side proxy, honestly labelled in the UI; the flow's UNIT_MULT always reads 0 despite $m values → hardcoded ×1e6, cross-validated against national GDP within 0.5% |
| `dcceew-petroleum-statistics` | Refinery input/output, fuel imports/exports, sales by state | XLSX | monthly | energy.gov.au WAF-blocks — discovery via data.gov.au CKAN (`/data/api/3`, NOT `/api/3`); sheet names drift → fuzzy match + fail loud; per-sheet resilience (one drifted sheet doesn't stale the other five, run still exits non-zero) |
| `abs-government-finance` | State general-government revenue/expenses/net operating balance | XLSX | quarterly | **No GFS SDMX flow exists** (proven by full catalog scan) — quarterly GFS workbook, Tables 5–12 = one per-state Operating Statement; only ~3 quarters per cube (history accumulates across releases via upsert); discovery from the ABS publication page works with the WAF-safe UA |
| `derived-shorted-markets` | Exposure-weighted per-state short interest | SQL over own DB | monthly | Current-constituent basis (present-day weights/market caps applied retrospectively — documented index-construction caveat); requires `mv_company_state_exposure`; registry needed migration 000085 to allow method `derived` |

Probe discipline (applies to every SDMX source): the collector's dimension
codes are **pinned from live probes**, recorded in a dated comment block at
the top of each importer, parsed **by column name** via `pkg/absdata`
(survives reorder), and **fail closed** — a missing filter column is an
error, never a silently-disabled filter.

## 3. Collector — `services/economy-collector`

Single binary, `-mode sources|rba|cpi|labour|trade|gdp|petroleum|govfin|markets|all`.
Deployed as a Cloud Run Job (min instances 0) with a monthly scheduler (5th,
17:00 UTC) via `terraform/modules/economy-collector`, image built in the
`build-docker-images` matrix of `terraform-deploy.yml`.

- Store: pgx on the Supabase transaction pooler (6543, SimpleProtocol),
  per-source transactions, **0 observations = error** (format-drift tripwire),
  catalog identity fields immutable on conflict.
- `pkg/absdata`: shared ABS SDMX-CSV + RBA CSV clients. UA
  `shorted-data/1.0 (+https://shorted.com.au)` is mandatory (WAF).
- Registry: sources upsert into `industry_intelligence_sources` with
  `public_enabled = existing OR EXCLUDED` (never downgrades). `signal_kind
  'economic_series'` allowed by migration 000082; `collection_method
  'derived'` by 000085.
- First run in a fresh environment: `gcloud run jobs execute economy-collector`
  (the scheduler otherwise waits for the 5th).

## 4. Company state exposure (the "which companies reside where" layer)

Operations-weighted, not HQ-based: each company carries a weight vector over
the 8 states + `international` ("umbrella a company to where economic
activity happens" — FMG→WA 0.9, BHP→WA .55/QLD .2/SA .1/intl .15,
CSL→intl 0.8).

- **Storage**: `company-metadata.state_exposure JSONB` + `hq_state` (regex
  from `address`, fallback weight 1.0) — migration 000083 — flattened by
  **`mv_company_state_exposure`** (one row per stock×region, joined to
  market cap, industry, logo, current short %; source `llm` | `hq_fallback`).
- **Generation**: enrichment-processor `--backfill-state-exposure --limit N`
  (dedicated mode, NOT the full-enrichment/quality-gate path): gpt-5.2, BHP+CSL
  few-shot prompt, validation renormalizes weights to 1.0 and **merges
  duplicate regions** (learned via the FPH incident — two `international`
  rows broke the MV's unique index). Top 300 by market cap = 93.8% of total
  market cap; run against prod ~$5 / 3 min.
- **Read**: `ListStateCompanies(state, limit)` (ranked by weight × market cap)
  + `GetStateCompanyAggregates()` (per-state count, exposure-weighted market
  cap and short interest; `international` excluded from aggregates but shown
  in the UI for honesty).
- **Schema-drift warning**: prod `company-metadata` has NO `sector` or
  `description` columns (local dev does). Any query against that table must
  stick to columns present in BOTH (bit us on the first prod backfill).

## 5. Read API

`ListEconomicSeries` (catalog, filterable, cap 500) and `GetEconomicSeries`
(≤50 keys × ≤600 obs, oldest-first after capping to the newest 600) — both
`VISIBILITY_PUBLIC` (the proto option IS the auth story; no allowlists),
cached via the standard `GetOrSet` layer with **fully normalized keys**
(trim/lowercase/dedup/sort before both cache key and store call). Plus the
two state-company RPCs (§4). Store queries live in
`postgres_economy.go` / `postgres_state_exposure.go` over index-covered
LATERAL joins.

## 6. Frontend

### `/economy` — the hub (ISR 3600)
SSR headline tiles (one `getEconomicSeries` call) + the **map explorer**
(client, `dynamic(ssr:false)`): national choropleth (reuses housing's
`choropleth-map.tsx` + `states.topojson` — feature ids are **numeric ABS STE
codes "1".."8"**, bridged via `@/lib/housing/states.ts`), a "Colour by"
switcher over the serializable registry `@/lib/economy/map-metrics.ts`
(union: `kind:"series"` metrics fetch per-state series; `kind:"aggregate"`
metrics read `GetStateCompanyAggregates`), hover tooltips (value, YoY,
sparkline, rank; NT/ACT honestly hatched where ABS doesn't publish), and
click → `router.push('/economy/<state>')`.

Mobile tooltip rule: below 640px the tooltip pins to the bottom of the map
container; desktop clamps to the viewport (flip-only overflows at corners).

### `/economy/[state]` — state pages (SSG ×8, ISR 3600)
Breadcrumbs (shared `seo/breadcrumbs` + BreadcrumbList JSON-LD), SSR chip
strip, locator-inset map, then the client grid: per-state charts
(unemployment/SFD/exports/imports/diesel, availability derived from the
registry's `unavailableStates` — one source of truth), **State finances**
row (govfin), **correlations** (dual-axis overlay of
`markets.short_interest_wavg` vs a switchable series + rolling-Pearson chips,
|r|≥0.4 n≥12, "descriptive, not causal" footnote — empty chips mean no pair
clears the bar, which is correct behavior), "Operating here" companies
(weights, HQ tags, short chips), top export commodities.

### Iconography
24-icon warm-duotone set generated with the housing-icons pipeline cloned to
`web/scripts/economy-icons/` (direct gpt-image-1 path; flow-orchestrator MCP
optional), packed sprite + typed `<EconomyIcon>` manifest.

## 7. Resilience & ops (hard-won)

- **ISR + connect-POST landmines (BOTH real, PRs #321/#323):** on a static
  route, an UNtagged `serverFetchWithUserAgent` connect POST forces
  `no-store` and **throws "Page changed from static to dynamic"** during
  regen — the `next:{revalidate}` tag on the transport fetch is load-bearing.
  Even tagged, transient failures return `undefined` and would bake the
  empty-state placeholder for an hour. The durable fix is the **Upstash KV
  last-good layer** in `getEconomy.ts` (sorted-key, `toJson`/`fromJson`
  BigInt-safe, never caches empty, `ECONOMY_TTL` 6h) — identical to
  `getHousingOverview`.
- **Every Vercel promote resets ALL ISR pages** to their build-time
  (skipForBuild) placeholders. The deploy workflow promotes itself
  (`terraform-deploy.yml` ~1413–1456; don't race it manually) — after each
  deploy run the revalidate sweep. `REVALIDATION_SECRET` is Vercel-sensitive
  (unpullable) but mirrored in GCP Secret Manager:
  `gcloud secrets versions access latest --secret=REVALIDATION_SECRET
  --project rosy-clover-477102-t5`, then POST
  `/api/revalidate?secret=…&path=/economy,/economy/nsw,…` with a browser UA.
- **Prod MV refresh**: the txn pooler (6543) statement-timeout kills
  `refresh_all_materialized_views()` mid-way — refresh individual MVs via the
  session pooler (5432) with `PGOPTIONS="-c statement_timeout=0"`.
- **Live regen debugging**: `vercel logs shorted.com.au --scope
  document-analyser` while curling the page catches ISR-regeneration errors
  in real time (this is how #323's root cause was proven).
- **Migration numbering across parallel sessions**: check origin/main's
  migration numbers at PR time, not branch-cut time (the duplicate-000083
  incident broke `migrate up` repo-wide).

## 8. Extension recipes

- **New SDMX source**: probe the dataflow (`/rest/dataflow/ABS?detail=allstubs`
  then `lastNObservations=1`), pin codes in a dated comment, clone the
  cpi/labour importer shape (name-based columns, fail-closed filters,
  Dimensions provenance, fixture tests), add to `sources.go` + `main.go`.
- **New XLSX source**: clone the petroleum/govfin shape (per-run discovery,
  sheet-specs with fuzzy header match, fail-loud drift, per-sheet resilience,
  synthetic-excelize fixture tests).
- **New map metric**: add a serializable entry to
  `@/lib/economy/map-metrics.ts` (`kind:"series"` with a key template, or
  `kind:"aggregate"` with an aggregates field) — the explorer, legend and
  tooltips pick it up.
- **New state-page chart**: templated `EconomySeriesChart seriesKey` in
  `state-charts.tsx`; gate availability from the registry, never a local list.
- **New derived series**: clone `-mode markets` (set-based SQL → SeriesDef/Obs,
  registry entry with method `derived` + an honest caveat in notes).

Specs/plans: `docs/superpowers/specs/2026-07-21-*.md`,
`docs/superpowers/plans/2026-07-21-*.md`.
