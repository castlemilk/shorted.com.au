# Economy Platform — Phase 3+ Roadmap (Exhaustive Backlog)

Drafted 2026-07-22 against the live 11-source / 472-series platform
(`docs/economy-architecture.md`). Effort keys: **S** = clone-an-importer /
UI-only day-scale · **M** = new machinery or multi-layer, few days ·
**L** = own workstream/spec. Value = leverage for Shorted's core identity
(short-interest intelligence with macro context). Every SDMX/CSV item follows
the established probe-truth-wins discipline; every XLSX item follows the
petroleum/govfin machinery.

## Tier 1 — highest leverage (recommend: next round)

| # | Item | Method | Effort | Why / notes |
|---|------|--------|--------|-------------|
| 1.1 | **RBA Index of Commodity Prices** (table I2: headline + iron ore, coking/thermal coal, LNG, gold, base metals components) | RBA CSV (existing client) | S | THE missing series for the flagship correlations — iron-ore price vs WA miners' short interest; feeds dossier overlays + chips immediately. Topic `commodities`. |
| 1.2 | **RBA credit aggregates** (D1/D2: business credit, housing credit owner-occupier vs investor, personal) | RBA CSV | S | Credit growth vs financials short interest; investor-housing credit joins the housing surface too. Topic `credit`. |
| 1.3 | **Per-industry short-interest series** (`markets.short_interest_avg.{industry-slug}` from own DB — the `-mode markets` pattern over industry instead of state) | derived SQL | S/M | Unlocks phase-3 industry-intel: the workspace's crowding views gain the same correlation machinery for free; also enables industry-level chips vs trade/commodity series. Slug from the existing industry registry (stable codes). |
| 1.4 | **ABS Job Vacancies** (SDMX, quarterly, by state) + **Weekly Payroll Jobs** (SDMX, weekly index, by state) | SDMX | S each | Leading labour indicators (unemployment is lagging); payrolls is the highest-frequency ABS series available — good for chips. Topics `labour` (new metrics) or `vacancies`. |
| 1.5 | **ABS Wage Price Index** (SDMX, quarterly, by state) | SDMX | S | Pairs with CPI → real-wage series (derived: `wpi_yoy − cpi_yoy`) — a tile-worthy number. |
| 1.6 | **Industry-intel "economy context" strip** (phase-3 UI: per-industry panel of the mapped trade/commodity/markets series + correlation chips inside /industry-intelligence) | UI only (RPCs exist) | M | The original Option-3 promise; blocked on 1.3 for the industry-level short series. |

## Tier 2 — macro completeness & forward-looking

| # | Item | Method | Effort | Notes |
|---|------|--------|--------|-------|
| 2.1 | **Resources & Energy Quarterly** (Dept. of Industry) — export volumes/values + FORECASTS per commodity | XLSX (petroleum-style) | M | Only forward-looking official series on offer; forecast-vs-actual chart potential. Check workbook stability across issues. |
| 2.2 | **ABS Business Indicators** (company gross operating profits, sales — by industry, quarterly) | SDMX | S | Profits vs short interest by sector (needs 1.3's industry mapping to shine). |
| 2.3 | **ABS Lending Indicators** (new loan commitments by state/purpose) | SDMX | S | Housing-credit lead indicator; joins housing + economy surfaces. Coordinate with housing collector's existing partial pull to avoid dupes. |
| 2.4 | **ABS overseas arrivals & departures** (SDMX, monthly, by state) | SDMX | S | Tourism/migration flows; complements ERP components; strong for QLD/NT dossiers. |
| 2.5 | **ABS Taxation Revenue annual (5506.0)** — per-state tax mix: payroll, stamp duty, land tax | XLSX (likely; probe SDMX first) | M | Stamp-duty revenue vs the housing price-drops surface = novel cross-surface correlation; deepens the finances breakdown. |
| 2.6 | **State budget forward estimates** (net debt/deficit projections from each treasury's budget-paper tables) | 8× bespoke XLSX | L | Turns State finances forward-looking; feasibility varies per state (NSW/VIC publish clean data tables; some are PDF-first). Start with the 2-3 cleanest states. |
| 2.7 | **ABS Engineering/Building Construction Activity** (work done, by state) | SDMX | S | Completes the approvals→activity lead/lag pair; the lead/lag chip almost writes itself. |
| 2.8 | **ABS Household Spending Indicator** (monthly, by state — the modern retail-trade successor) | SDMX | S | Broader than retail turnover; probe overlap before shipping both. |

## Tier 3 — energy (own workstream)

| # | Item | Method | Effort | Notes |
|---|------|--------|--------|-------|
| 3.1 | **AEMO NEM**: regional spot prices, demand, generation mix (fuel-type shares), interconnector flows | AEMO CSV/API (NEMWEB) | L | Biggest untapped set. 5-min data → aggregate to daily/monthly at ingest; new `region_type` values (NEM regions ≈ states). Licence: AEMO data OK with attribution — verify current terms. Enables: electricity price vs energy-sector shorts, renewables-share trend per state. |
| 3.2 | **AEMO gas** (Gas Bulletin Board: flows, prices) | API | M/L | Pairs with STO/WDS short stories. |
| 3.3 | **OpenNEM as an alternative ingestion path** for 3.1 | JSON API | M | Cleaner API over the same data; check licensing/attribution + durability before depending on it. |
| 3.4 | **Fuel retail prices** (state schemes: FuelWatch WA API, NSW FuelCheck API; ACCC quarterly reports) | per-scheme APIs | M | Pairs with DCCEEW volumes; WA/NSW have real APIs, others patchy — ship the two clean ones. |

## Tier 4 — derived & analytical series (no new external data)

| # | Item | Effort | Notes |
|---|------|--------|-------|
| 4.1 | Real wages (`wpi_yoy − cpi_yoy`) per state | S | After 1.5. |
| 4.2 | Trade balance as a stored series (currently client-derived) | S | Removes the double-fetch on the map's diverging metric. |
| 4.3 | Per-capita variants (SFD, retail, approvals ÷ ERP) | S | After population landed — honest state comparisons; map metric candidates. |
| 4.4 | Approvals→completions lead/lag + rolling-correlation chip surfacing on housing pages | M | Cross-surface: economy series consumed by /housing. |
| 4.5 | **Exposure-weighted sector indices beyond short interest**: market-cap-weighted price return per state (needs stock_prices join) | M | "WA equity performance" series; strong dossier overlay vs commodities. |
| 4.6 | Correlation matrix endpoint/page (all-pairs per state, precomputed server-side or nightly into a small table) | M | Powers "interesting correlations" discovery instead of a fixed candidate list. |

## Tier 5 — product surfaces & polish

| # | Item | Effort | Notes |
|---|------|--------|-------|
| 5.1 | LLM state insight panels (compose the state's series + companies into 3-sentence briefs, weekly-report-generator pattern with quality gate) | M/L | The narrative layer; cache per state per month. |
| 5.2 | Commodity-level drill: state → commodity → series + exposed companies | M | RPCs support it; pure UI. |
| 5.3 | State OG images (banner + headline stats composited — satori constraints per housing OG memory) | M | Social sharing for state pages. |
| 5.4 | /economy in the chat-service toolset (new tool: GetEconomicSeries wrapper so Shorted AI can answer macro questions) | S/M | High-visibility integration; chat service already has 8 tools. |
| 5.5 | Economy data in weekly reports (macro-context section fed from the series layer) | M | Generator json-contract rules apply. |
| 5.6 | Alerts on economic series (threshold/change monitors — reuse alert_monitors) | M | Premium surface. |
| 5.7 | CSV/JSON export + a documented public-API page for the economy endpoints | S | The data is CC-BY-derived; an export button + api-catalog entry drives API-tier signups. |
| 5.8 | Approvals map metric + chip-row overflow UI (the "More metrics" disclosure that unblocks unlimited map metrics) | S | Currently at capacity by design. |

## Tier 6 — platform/ops hardening

| # | Item | Effort | Notes |
|---|------|--------|-------|
| 6.1 | Revalidate sweep as a deploy-workflow step (kills the recurring post-promote placeholder manual step) | S | Secret already in GH secrets; add after the promote step. |
| 6.2 | Collector freshness monitoring (jobmonitor integration: alert when a source's max(period) goes stale beyond cadence) | M | The jobs dashboard exists (PR #206 pattern). |
| 6.3 | Full-universe state-exposure enrichment (the ~4,200-company tail, batched) | S runs | ~$60 total LLM spend at current pricing; do in tranches. |
| 6.4 | Exposure refresh cadence (re-run top-300 quarterly; weights drift with M&A) | S | Scheduler or checklist entry. |
| 6.5 | `mv_company_state_exposure` staleness guard (markets mode warns if MV older than N days) | S | Protects the derived series' honesty. |
| 6.6 | Backfill BA_SA2's predecessor cube (BA_SA2_201116) + bridge 2016-2021 gap if a middle cube exists | M | Longer approvals history for correlations. |

## Explicitly evaluated and rejected/parked

- **Westpac-MI Consumer Sentiment, NAB Business Survey**: licensed/proprietary — no.
- **GrantConnect**: CloudFront-blocked (do-not-bypass posture stands).
- **State-level GDP (real GSP)**: annual-only, Excel 5220.0 — SFD proxy retained; revisit only if users ask for annual GSP explicitly.
- **ERP_COMP_SA (sub-state population)**: belongs to the housing/suburb surface, not economy.
- **Third-party market-data correlations (FRED, Yahoo)**: keep the platform AU-official-sources + own-DB derived; external market feeds are a different trust class.

## Suggested next-round cut (if starting tomorrow)

1.1 + 1.2 + 1.3 + 1.4(vacancies) + 1.5 + 4.1 + 4.2 + 5.4 + 6.1 — roughly one
session at the established cadence: five S-importers/derived series, one UI
bridge task (1.6 following 1.3), the chat tool, and the deploy-workflow
revalidate step. Delivers the flagship commodity-vs-shorts correlation story
end-to-end.

> **SHIPPED 2026-07-22** as phase-3 round 1 (branch
> `feat/economy-phase3-round1`; spec
> `docs/superpowers/specs/2026-07-22-economy-phase3-round1-design.md`):
> 1.1 ✓ (A$ aggregate indices; iron-ore/coal components are XLSX-only —
> parked) · 1.2 ✓ (DGFACBNF12 for business; DGFACB12 discontinued 2019) ·
> 1.3 ✓ (`markets.short_interest_avg.{slug}.aus`, equal-weight, slug map ==
> web createSlug) · 1.4 ✓ vacancies (payrolls still open) · 1.5 ✓ · 1.6 ✓
> (economy-context strip in /industry-intelligence) · 4.1 ✓ (national-CPI
> deflator caveat) · 4.2 ✓ (stored series; map metric still client-derived)
> · 5.4 ✓ (`get_economic_series`) · 6.1 ✓ (workflow step, browser UA,
> continue-on-error).
