# Economy Phase-3 Round 1 — Design Spec

Scope = the roadmap's suggested next-round cut (`docs/economy-roadmap.md`):
1.1 + 1.2 + 1.3 + 1.4(vacancies) + 1.5 + 4.1 + 4.2 + 5.4 + 6.1, plus the 1.6
industry-intel bridge UI. **No DB migrations** — all data lands in the existing
`economic_series` / `economic_observations` tables (migration 000081).

All source probes below were run live 2026-07-22 by the coordinator (Codex
sandbox has no network). Codes are PINNED — do not re-derive from labels.

## A. RBA commodity prices (roadmap 1.1)

- File `i2-data.csv` (existing `FetchRBATable` client), monthly, index
  2024/25=100, adjustment `original`, licence CC-BY-4.0.
- Topic `commodities`, metric `price_index`, region aus/national, source_key
  `rba-commodity-prices` (new registry entry: "RBA Index of Commodity Prices",
  https://www.rba.gov.au/statistics/tables/ table I2).
- A$ series only (skip SDR/USD). Pinned Series IDs (probed 2026-07-22):

| series_key | RBA Series ID | Title |
|---|---|---|
| `commodities.price_index.all_items.aus` | GRCPAIAD | Commodity prices – A$ |
| `commodities.price_index.rural.aus` | GRCPRCAD | Rural |
| `commodities.price_index.non_rural.aus` | GRCPNRAD | Non-rural |
| `commodities.price_index.base_metals.aus` | GRCPBMAD | Base metals |
| `commodities.price_index.bulk.aus` | GRCPBCAD | Bulk commodities |
| `commodities.price_index.bulk_spot.aus` | GRCPBCSAD | Bulk commodities spot |

- NOTE (parked): individual iron-ore/coal/LNG/gold component series are
  XLSX-only upstream — the bulk index is the iron-ore+coal proxy. Documented,
  not built.
- Magnitude cross-check: all indices near 100 (base 2024/25=100); values
  outside 20–500 = drift.

## B. RBA credit aggregates (roadmap 1.2)

- File `d1-data.csv`, monthly, unit percent, adjustment `seasadj` (D1 is
  seasonally adjusted), topic `credit`, metric `growth_yoy`, region aus,
  source_key `rba-credit-aggregates` ("RBA Growth in Selected Financial
  Aggregates", table D1). 12-month-ended growth series only:

| series_key | RBA Series ID | Title |
|---|---|---|
| `credit.growth_yoy.housing.aus.seasadj` | DGFACH12 | Housing credit |
| `credit.growth_yoy.owner_occupier_housing.aus.seasadj` | DGFACOH12 | Owner-occupier |
| `credit.growth_yoy.investor_housing.aus.seasadj` | DGFACIH12 | Investor |
| `credit.growth_yoy.personal.aus.seasadj` | DGFACOP12 | Other personal |
| `credit.growth_yoy.business.aus.seasadj` | DGFACBNF12 | Business (non-financial; DGFACB12 discontinued 2019) |

- Magnitude cross-check: housing credit YoY in −2..+25% band; typical ~4–7%.
- `rba.go` currently hardcodes Topic/SourceKey/Adjustment in the def — the
  table struct must grow per-table `topic`, `sourceKey`, `adjustment`, and
  per-spec `product` fields. Keep the existing rates/fx tables byte-identical
  in output (same keys, same dims).

## C. ABS Job Vacancies (roadmap 1.4)

- SDMX flow `JV` version **1.0** (NOT 1.0.0 — 404s; probed), quarterly since
  2009-Q3 (with a known gap 2008–2009 upstream), source_key
  `abs-job-vacancies` (ABS Job Vacancies, Australia).
- Filters (fail-closed, strict `sdmx.go` helpers): MEASURE=`M1`, SECTOR=`7`
  (private+public), INDUSTRY=`TOT`, TSEST=`10` (**states have NO
  seasadj/trend — original only, probed**), all 9 REGION values (1–8 + AUS).
- UNIT_MULT=3 (thousands) → store persons (×1000), unit `persons`, topic
  `labour`, metric `job_vacancies`, adjustment `original`.
- Keys: `labour.job_vacancies.{aus|nsw|vic|qld|sa|wa|tas|nt|act}` (9 series).
  Region code map 1→nsw … 8→act, AUS→aus — same map as labour.go/retail.go.
- Magnitude cross-check (2026-Q2 probe): AUS 324,000 · NSW 96,100.

## D. ABS Wage Price Index (roadmap 1.5)

- SDMX flow `WPI` version **1.2.0**, quarterly, source_key
  `abs-wage-price-index`.
- Filters: INDEX=`THRPEB` (total hourly rates of pay excl. bonuses — the
  headline), SECTOR=`7`, INDUSTRY=`TOT`, TSEST=`10` (states original-only,
  probed), MEASURE ∈ {`1` (index), `3` (YoY %)}, 9 regions.
- Topic `wages`; 18 series:
  - `wages.wpi.{region}` — MEASURE=1, unit `index` (2008-09=100 base…
    whatever BASE_PERIOD says; store as index).
  - `wages.wpi_yoy.{region}` — MEASURE=3, unit `percent`.
- Magnitude cross-check (2026-Q1/Q2 probe): AUS index ~160.3, AUS YoY ~3.2%.

## E. Derived: per-industry short interest (roadmap 1.3)

- Clone the `-mode markets` derivation shape (set-based SQL, DISTINCT-ON
  monthly-last per stock) but group by `company-metadata`.industry instead of
  the exposure MV. **Simple average** (not cap-weighted) per roadmap:
  metric `short_interest_avg`.
- Keys: `markets.short_interest_avg.{industry-slug}.aus` — region_type
  `national`, region aus; the industry goes in the `product` segment and a
  `dimensions.industry` provenance entry (raw GICS name).
- Industry slugs from a PINNED static map (iron rule — DB probe 2026-07-22,
  GICS industry groups, 25 real values): materials, energy,
  software-services, financial-services, health-care-equipment-services,
  pharmaceuticals-biotechnology-life-sciences, capital-goods,
  commercial-professional-services, media-entertainment,
  food-beverage-tobacco, consumer-discretionary-distribution-retail,
  consumer-services, equity-real-estate-investment-trusts-reits (matches web slugify — the identity contract), technology-hardware-equipment,
  transportation, real-estate-management-development, utilities,
  telecommunication-services, consumer-durables-apparel, banks,
  household-personal-products, insurance, automobiles-components,
  consumer-staples-distribution-retail,
  semiconductors-semiconductor-equipment. EXCLUDE `Not Applic`, `Class Pend`,
  NULL/empty. Unknown industry values: skip + count, warn; error if unmapped
  stocks exceed 10% of matched rows (vocabulary drift tripwire).
- Only emit industries with ≥5 constituent stocks in a month (noise floor).
- Source_key `derived-shorted-markets` (existing), licence `derived`,
  monthly, since 2015. `basis` dimension: `equal-weight,current-membership`
  (industry classification is present-day — same caveat family as markets).
- Runs inside `-mode markets` (one derived-markets family, one transaction).

## F. Derived: real wages + trade balance (roadmap 4.1 + 4.2)

New `-mode derived` (DB-derived like markets; runs LAST in `all`, after wages
and cpi land). Source_key `derived-shorted-economy` (new registry entry,
method `derived`, licence `derived`).

- **Real wages** `wages.real_wpi_yoy.{region}` (9 regions, quarterly, percent):
  `wpi_yoy(region, q) − cpi_yoy_national(q)` where the national CPI YoY is
  computed from the quarterly `cpi.index` series
  (`(idx/idx[-4] − 1) × 100` — do NOT use the monthly annual_change series;
  quarterly index exists 1948→ and aligns exactly).
  Honest caveat in notes + `dimensions.deflator=cpi-national`: no state CPI
  exists; the deflator is national.
- **Trade balance** `trade.balance.total.{region}` (9 regions, monthly, aud):
  `export_value.total − import_value.total` per region/month from
  `economic_observations` (join on period; only months where BOTH sides
  exist). Removes the client-side double-fetch for the map's diverging
  metric (leave the client derivation in place this round; migrating the map
  metric to the stored series is a follow-up).
- Both fail-loud on 0 obs.

## G. Chat tool (roadmap 5.4)

`services/chat-service/tools.go` + `tool_executor.go`: ONE new tool
`get_economic_series` following the existing 8-tool pattern (public API via
the shorts service base URL, Connect JSON POST):
- Params: `series_keys` (string[], ≤10 — the tool description embeds a
  compact cheat-sheet of key families: rates.cash_rate_target.aus,
  cpi.annual_change.aus, labour.unemployment_rate.{state}.seasadj,
  labour.job_vacancies.{state}, wages.wpi_yoy.{state},
  wages.real_wpi_yoy.{state}, commodities.price_index.bulk.aus,
  credit.growth_yoy.housing.aus.seasadj, markets.short_interest_wavg.{state},
  markets.short_interest_avg.{industry}.aus, trade.balance.total.{state}) +
  optional `limit` (obs per series, default 12, max 60 — the LLM needs recent
  history, not 600 points).
- Calls `EconomyService/GetEconomicSeries`; response trimmed to
  key/name/unit/frequency + last-N (period, value) pairs.
- System prompt: add one line telling the model the tool exists for macro
  context. Unit tests per existing tool-test pattern.

## H. Industry-intel economy context strip (roadmap 1.6)

`/industry-intelligence` per-industry panel (client component alongside
`industry-channel-dashboards.tsx`): when an industry is selected, show
- the industry's derived short-interest series (`markets.short_interest_avg.
  {slug}.aus`) as the anchor line;
- a switchable overlay from a small national candidate set (commodities bulk +
  all_items, credit business growth, labour.job_vacancies.aus,
  wages.wpi_yoy.aus, cpi.annual_change.aus) reusing the state-page dual-axis
  overlay + rolling-Pearson chips (`state-correlations.tsx` /
  `correlation.ts` machinery — extract/generalize, don't fork);
- graceful empty state when the industry has no derived series (slug map miss
  or <5 constituents).
- The industry slug ↔ series-key bridge must use the SAME slugify the
  industry pages already use (`getIndustryData.ts`) — verify the collector's
  static map produces identical slugs (test both directions in a unit test).

## I. State-page correlation candidates (part of the flagship story)

Add to the state-correlations candidate list (national series are valid
overlay candidates vs state short interest): commodities.price_index.bulk.aus
+ all_items.aus, credit.growth_yoy.business.aus.seasadj + housing.aus.seasadj,
labour.job_vacancies.{state}, wages.wpi_yoy.{state},
wages.real_wpi_yoy.{state}. Availability from the registry pattern (no
hardcoded per-state lists). WA/QLD vs bulk commodities is THE flagship chip.

## J. Deploy-workflow revalidate sweep (roadmap 6.1)

`.github/workflows/terraform-deploy.yml`, immediately after the "Promote
smoked Vercel deployment to production" step: a step that POSTs
`/api/revalidate?secret=…&path=<all ISR pages>` with a **browser UA** (curl
default UA is edge-blocked) + `flush=shorts,housing`. Secret from GH secrets
(`REVALIDATION_SECRET` — verify name with `gh secret list` before wiring).
Paths: /economy, /economy/{nsw,vic,qld,sa,wa,tas,nt,act}, /housing,
/price-drops, /market, /compare, /scans, /statistics. Non-fatal
(`continue-on-error: true`) — a failed sweep must not fail the deploy. Kills
the recurring manual post-promote step in the ops runbook (update the docs
§7 note).

## Explicitly out of scope this round

Map-metric migration to stored trade balance; commodity component series
(XLSX); industry-level chips vs trade/commodity beyond the H candidate set;
5.7 export/API-catalog page; monthly scheduler changes (new modes ride the
existing `-mode all`).
