# House-Price Tracking System (design + build log)

**Date:** 2026-06-23 · **Branch:** `feat/house-price-tracker`
**Decisions (user-approved):** Build the **full system incl. crawl**. Multi-tier data: ABS/RBA official backbone + state-government bulk sales (granular) + Domain API + a supplementary **stealth crawl** of realestate/Domain. First surface: **live-feed the Widow-Maker feature charts + a new `/housing` dashboard**.

## Tiered data model (endpoints verified live, 2026-06-23)

| Tier | Source | Access | Granularity | Licence |
|---|---|---|---|---|
| T1 backbone | **ABS `RES_DWELL_ST`** | `data.api.abs.gov.au/rest/data/ABS,RES_DWELL_ST/1+5..Q` (CSV `labels=both`, **`User-Agent` required**) | national+state mean price + total value, quarterly | CC BY 4.0 |
| T1 backbone | **ABS `RES_DWELL`** | `.../ABS,RES_DWELL/3+4..Q` | capital-city (GCCSA) + rest-of-state medians (established/attached), quarterly | CC BY 4.0 |
| T1 backbone | **ABS `RPPI`** (frozen 2021-Q4) | `.../ABS,RPPI/1.3.100.Q` | historical 8-capital stratified **index** | CC BY 4.0 |
| T1 backbone | **RBA** stat tables | E2 CSV download | household debt-to-income (national) | open |
| T2 granular | **VIC VPSR** / **SA metro** | data.vic / data.sa XLS·CSV | suburb medians | CC BY 4.0 |
| T2 granular | **NSW Valuer-General PSI** | weekly `.DAT` bulk | **address-level** sales | **CC BY-NC-ND** ⚠️ legal-gated |
| T3 crawl | **Domain Developer API** (preferred) | `/v2/suburbPerformanceStatistics` (OAuth2, free tier, quota unknown) | suburb medians/percentiles | ToS |
| T3 crawl | realestate.com.au / domain.com.au | stealth crawl of embedded JSON | suburb medians | **ToS-breach, fragile** |

**Crawl reality (first-hand probes):** REA = **Kasada** (429, PoW JS, **serves false data to bots** — must cross-validate against ABS), Domain = **Akamai** (403). Native uTLS won't pass REA → needs Chromium. Non-load-bearing gap-filler only.

## Schema (migration 000053 — APPLIED)
`house_price_regions` (dimension) + `house_prices` (narrow EAV fact: region×measure×dwelling×period×source, idempotent UNIQUE key, `source_licence` gates NC-ND) + `house_price_ingest_runs` (cursor) + `mv_housing_headline` (latest + QoQ/YoY) + `refresh_housing_materialized_views()` (decoupled from the daily shorts refresh).

## Feature-series go-live matrix
National real/nominal index, capital-city medians, debt-to-income, price-to-income → **LIVE**. Investor-share + Japan/China/US indices → **stay baked** (no AU source).

## Build sequence & progress
1. ✅ **Migration 000053** (schema + MV + refresh fn) — applied to local DB. [commit 4de330f6]
2. ✅ **Go collector `services/house-price-collector/`** — ABS backbone (RES_DWELL_ST / RES_DWELL / RPPI). Verified: 2,486 real obs, MV QoQ/YoY correct. [4de330f6]
3. ✅ **RBA debt-to-income** (`rba.go`) — 151 obs, peak 2018-Q2 187.7. [cbda99a4]
4. ✅ **RPC `GetHousingOverview` + `GetHousePriceSeries`** (proto → handler → 4-layer store + regenerated Go/TS). **Verified end-to-end over Connect-RPC** (Sydney $1.485M +2.4%YoY, national mean $490.8k→$1.11M). [d6f3fdfb] — NOTE: shorts API has a bot-detection interceptor; clients need a browser-ish User-Agent + `Connect-Protocol-Version: 1`.
5. ⬜ Web: `getHousing` server/client actions + `/housing` dashboard page (reuse housing-feature chart components).
6. ⬜ Wire the Widow-Maker feature charts to live data (baked SSR fallback).
7. ⬜ State-govt granular (VIC VPSR / SA metro medians; NSW gated) + Domain API.
8. ⬜ Stealth crawl tier (`crawl.go` via `stealthhttp`, Chromium for REA's Kasada, ABS cross-validation).
9. ⬜ Terraform `house-price-collector` Cloud Run Job + Scheduler (copy `short-data-sync`).
10. ⬜ Collector Dockerfile (`FROM scratch AS stealth` pattern, golang:1.26.0) — needed for #7/#8/#9.

**Status:** the full **data backbone + API is built, verified end-to-end, and committed** (branch `feat/house-price-tracker`, off the widow-maker branch). Remaining = web surface (#5/#6) + granular/crawl tiers (#7/#8) + deploy (#9/#10).

## Open decisions (carry from research)
- NSW PSI **CC BY-NC-ND** → legal sign-off before surfacing computed medians commercially (ingest gated via `source_licence`).
- Domain API: create a project to measure the free quota before depending on it.
- 8-capital index continuity: RPPI frozen 2021-Q4 → accept methodology break (ABS GCCSA medians post-2021, annotated) vs buy Cotality. **Recommend accept break for MVP.**
- Crawl: prefer Domain API; scrape only as cross-validated, non-load-bearing gap-filler.
