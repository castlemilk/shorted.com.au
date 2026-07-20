# Australian Economy Data Platform — Design

**Date**: 2026-07-21
**Status**: Draft for review
**Scope decision**: Option 3 (shared pipeline, two consumers) at scope 2 (energy + macro core).

## Goal

One place to snapshot the Australian economy: petroleum/refining, trade by state,
GDP, labour, prices, and policy rates — ingested through a single generic series
layer that both a new `/economy` surface and (later) `/industry-intelligence`
consume. The data model is the product: every source normalizes into the same
fetchable shape.

## Non-goals (v1)

- AEMO electricity/gas, Resources & Energy Quarterly, services trade (future sources).
- Entity-level (ASX company) linkage — economic series are national/state/industry
  level only; entity evidence stays in influence-collector.
- Industry-intelligence UI integration (phase 2; the RPC makes it possible).
- Migrating house-price-collector onto the shared ABS package (explicit follow-up).

## Data model (migration 000081)

The SDMX mental model: a **series catalog** with first-class dimensions, and a
separate **observations** table. Sources normalize into this at ingest; nothing
downstream ever parses a source format.

```sql
CREATE TABLE economic_series (
  id            BIGSERIAL PRIMARY KEY,
  series_key    TEXT UNIQUE NOT NULL,   -- stable slug, see convention below
  topic         TEXT NOT NULL,          -- petroleum | trade | gdp | labour | cpi | rates
  metric        TEXT NOT NULL,          -- refinery_output | export_value | unemployment_rate | ...
  product       TEXT,                   -- diesel | iron_ore | all_groups | NULL
  region_type   TEXT NOT NULL,          -- national | state | refinery | industry
  region_code   TEXT NOT NULL,          -- aus | nsw | ... | lytton | anzsic code
  region_name   TEXT NOT NULL,
  unit          TEXT NOT NULL,          -- megalitres | aud_million | percent | index
  frequency     TEXT NOT NULL,          -- monthly | quarterly | annual
  adjustment    TEXT NOT NULL DEFAULT 'original',  -- original | seasadj | trend
  dimensions    JSONB NOT NULL DEFAULT '{}',       -- source-specific extras
  source_key    TEXT NOT NULL,          -- FK-by-convention into industry_sources registry
  licence       TEXT NOT NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_economic_series_topic_metric ON economic_series (topic, metric);
CREATE INDEX idx_economic_series_source ON economic_series (source_key);

CREATE TABLE economic_observations (
  series_id  BIGINT NOT NULL REFERENCES economic_series(id) ON DELETE CASCADE,
  period     DATE NOT NULL,             -- first day of the period
  value      DOUBLE PRECISION NOT NULL,
  UNIQUE (series_id, period)
);
CREATE INDEX idx_economic_obs_series_period ON economic_observations (series_id, period DESC);
```

- **Revisions**: upsert-overwrite (`ON CONFLICT (series_id, period) DO UPDATE`).
  No revision history in v1 — statistical agencies revise recent periods and we
  always want the latest vintage.
- **Series key convention**: dot-delimited lowercase snake:
  `topic.metric[.product].region[.adjustment]`, adjustment segment only when not
  `original`. Examples: `petroleum.refinery_output.diesel.aus`,
  `trade.export_value.iron_ore.wa`, `gdp.gsp_chain_volume.total.qld`,
  `labour.unemployment_rate.total.nsw.seasadj`, `cpi.index.all_groups.aus`,
  `rates.cash_rate_target.aus`.
- **MVs**: none in v1. Catalog will be a few thousand series; observation queries
  are index-covered. Add an `mv_economy_headline` only if the `/economy` SSR
  snapshot query measurably needs it.

## Shared package: `services/pkg/absdata`

Extract the proven fetch clients into one package used by the new collector:

- `absdata.SDMXClient` — GET `data.api.abs.gov.au/rest/data/{dataflow}/{key}`,
  SDMX-CSV with `labels=both`, the mandatory WAF-safe `User-Agent:
  shorted-housing/1.0 (+https://shorted.com.au)`-style UA (renamed
  `shorted-data/1.0`), retry/backoff, CSV → generic row maps.
- `absdata.RBAClient` — RBA statistical-table CSV fetch + parse (from
  house-price-collector `rba.go`).

house-price-collector and influence-collector keep their local copies for now;
consolidating them is a named follow-up (no behaviour change risk in v1).

## Collector: `services/economy-collector`

Clone of the house-price-collector shape: single binary, `-mode` dispatch,
pgx store on the Supabase transaction pooler (port 6543, simple protocol),
idempotent upserts, registers its sources into the existing `industry_sources`
registry (`public_enabled = existing OR EXCLUDED` — never downgrade).

Modes: `sources | petroleum | trade | gdp | labour | cpi | rba | all`.

### v1 sources

| source_key | Publisher / dataset | Method | Cadence | Licence | Series it yields |
|---|---|---|---|---|---|
| `dcceew-petroleum-statistics` | DCCEEW Australian Petroleum Statistics | XLSX download (excelize) | Monthly | CC-BY-4.0 | Refinery input/output by product; production; consumption (sales) by product × state; imports/exports by product; stocks |
| `abs-merch-trade-state` | ABS International Merchandise Trade | SDMX-CSV | Monthly | CC-BY-4.0 | Export/import value by state × SITC section (iron ore, coal, gas, etc.) |
| `abs-state-accounts` | ABS Australian National Accounts: State Accounts | SDMX-CSV | Annual | CC-BY-4.0 | GSP chain volume + growth by state; industry gross value added |
| `abs-labour-force` | ABS Labour Force, Australia | SDMX-CSV | Monthly | CC-BY-4.0 | Unemployment rate, participation rate, employed persons by state (seasadj) |
| `abs-cpi` | ABS Consumer Price Index | SDMX-CSV | Quarterly | CC-BY-4.0 | All-groups index + annual change, weighted average + capital cities |
| `rba-key-indicators` | RBA statistical tables F1.1 / F11 | CSV download | Monthly | RBA CC-BY-4.0 | Cash rate target; AUD/USD; trade-weighted index |

Exact ABS dataflow IDs and dimension keys are confirmed at implementation time by
probing the SDMX registry (`/rest/dataflow`), the same way the housing flows were
established. Each importer gets fixture-based unit tests (real captured XLSX/CSV
snippets in `testdata/`).

### Petroleum XLSX landmines (known upfront)

- The publication URL is issue-numbered — the importer discovers the latest issue
  link from the DCCEEW data page rather than hardcoding it.
- excelize date-styled cells render as `mm-dd-yy` (AusTender lesson) — parse
  months from the styled string layout, with a fixture test per observed layout.
- Sheet/column names drift across issues — importers match headers by fuzzy
  label lookup, not fixed indices, and fail loudly (non-zero exit) on unknown
  layout so the scheduler surfaces it.

## API (proto additions, `shorts.proto`)

Two public RPCs on the existing shorts service:

- `ListEconomicSeries(topic?, metric?, region_type?, region_code?, product?)`
  → catalog entries only (key, dimensions, unit, frequency, latest period,
  source attribution). Capped at 500 entries.
- `GetEconomicSeries(series_keys[] (max 50), start_period?)`
  → series + observations, observations capped at 600 per series (50 years of
  monthlies).

Both follow the house-prices handler pattern (`house_prices.go` +
`postgres_house_prices.go`): store interface method, conditional-WHERE queries,
Connect handlers with validation, cached at the web layer. Responses carry
`source` + `licence` so the frontend can render attribution (CC-BY requires it).

## Frontend: `/economy`

SSR page in the `/housing` mould, ISR (`revalidate: 3600`), server action with
`cache()` + retry:

- **Headline tiles**: GDP growth, unemployment rate, CPI annual change, cash
  rate, trade balance, national fuel consumption.
- **Energy section**: refinery output by product (stacked), fuel consumption by
  state, petroleum imports vs exports.
- **Trade section**: exports by state, top commodities by value.
- **Macro section**: labour by state, CPI, cash rate history.

All charts through the existing visx patterns via `dynamic(ssr:false)` client
wrappers; serializable format-keys only across the RSC boundary (never formatter
functions); source attribution line under every chart. Single data hue per the
dataviz system unless a chart is genuinely categorical.

Phase 2 (separate PR, out of this spec's implementation plan): a per-industry
"economy context" strip in `/industry-intelligence` fed by `GetEconomicSeries`
for industry-mappable series.

## Deployment

- `terraform/modules/economy-collector`: Cloud Run Job + monthly Cloud Scheduler,
  `min_instance_count = 0`, cloned from `terraform/modules/house-price-collector`.
- Wired into `terraform-deploy.yml` image builds AND both
  `terraform/environments/{dev,prod}/main.tf` in the same PR (the housing PR #211
  lesson: a module that isn't wired into CI never deploys).
- Migration 000081 applies via the normal pipeline; prod DDL is plain
  CREATE TABLE (no CONCURRENTLY needs), so the transaction pooler is fine.

## Error handling

- Importers are per-source atomic: one source failing (WAF change, layout drift)
  exits non-zero for the job but does not corrupt other sources' data
  (per-source transactions).
- Fetches retry with backoff; a source returning 0 rows is an ERROR, not a
  no-op upsert (protects against silent format drift).
- RPCs return `InvalidArgument` for unknown topics/keys, empty (not error) for
  valid filters with no matches.

## Testing

- Unit: each importer against `testdata/` fixtures (XLSX, SDMX-CSV, RBA CSV);
  series-key builder; header-drift failure cases.
- Integration: store round-trip (register sources, upsert series + observations,
  re-run idempotency) under `services/test/integration`.
- API: handler tests with a fake store; cap enforcement.
- Frontend: Jest for tile/section components; e2e smoke that `/economy` renders
  tiles from a seeded local DB.

## Build order (for the implementation plan)

1. Migration 000081 + `pkg/absdata` extraction.
2. economy-collector skeleton + `sources` mode + store.
3. Importers, one per PR-sized chunk: rba → cpi → labour → trade → gdp →
   petroleum (easiest to hardest; petroleum XLSX last).
4. RPCs + store queries.
5. `/economy` page.
6. Terraform module + CI wiring.
