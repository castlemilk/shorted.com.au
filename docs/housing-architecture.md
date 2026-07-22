# Housing Architecture

The "housing" surface on Shorted is three products plus a speculative data tier, all sharing one chart system and one Connect-RPC service:

1. **The Widow-Maker editorial feature** (`/features/the-widow-maker`) — a hand-built investigative long-read with embedded interactive dashboards. Data is **baked** (curated research arrays). — §1
2. **The House Prices Tracker** (`/housing`) — a **live** national/state/GCCSA price dashboard fed by a real ABS/RBA/Valuer-General ingest pipeline. — §4
3. **The suburb explorer** (`/housing` national map → `/housing/[state]` → `/housing/[state]/[suburb]`) — a national → state → suburb **choropleth drilldown** over real ABS boundaries, with a "Colour by" toggle across house price, ABS Census demographics + culture (religion, language, born-overseas), and **electoral representation** (federal + state member/party + two-party-preferred). — §5
4. **A Tier-3 residential real-estate crawl** of REA/Domain — **LIVE**: suburb medians (`-mode crawl`) and individual for-sale listings (`-mode listings` / queue-distributed `-mode agent`), distributed across residential Macs via a brandbrain-hosted job queue and a warm host-Chrome CDP fetch that clears REA's Kasada challenge; still anti-poisoning-gated and licence-gated. A 115-suburb catalog (25 seed + 90 ABS-population metro) has crawled ~22k listings across the 5 mainland capitals. — §6
5. **The price-drops flagship** (`/price-drops`) — **LIVE**: asking-price cuts from the listings crawl rolled up by **state, suburb, individual address and agency**, on a crawl-aligned caching architecture (static ISR + KV, busted by a collector ping the moment a crawl lands). `/housing/drops` 308-redirects into it. — §10

Products 2 + 3 share one fact/dimension data model (`house_prices` + `house_price_regions` + `suburb_demographics`) and one collector (`house-price-collector`, `-mode official|census|electorates|amenities|crawl|refresh|all`).

> **Local Insights (in progress).** A program to enrich the suburb explorer with amenities (schools/supermarkets/pubs/parks/transport/health), council/LGA context, NBN connectivity, federal funding, and a geographic knowledge graph. New tables `lga`, `suburb_lga`, `suburb_amenities`, `suburb_connectivity`, `suburb_funding` (migrations **000061–000064**); a reusable spatial-join harness at `web/scripts/geo/geo-index.mjs` (grid point-in-polygon + haversine nearest); collector `-mode amenities`. Full design: `docs/superpowers/specs/2026-06-30-local-insights-design.md`; W0 plan: `docs/superpowers/plans/2026-06-30-local-insights-w0-foundation.md`.

This document is an extension guide. Read the section matching what you're building, then the matching "Future extensions" recipe at the end (§9).

---

## 1. The editorial feature (`/features/the-widow-maker`)

### Page shape

`web/src/app/features/the-widow-maker/page.tsx` is a server component (`export const revalidate = 3600`). It renders an `<article>` of six numbered `<Section>`s of prose, with editorial primitives (`<PullQuote>`, `<Cite>`, `<StatStrip>`) interleaved, and four interactive dashboards wrapped in `<ScrollReveal><FeatureChartFrame>…</FeatureChartFrame></ScrollReveal>`. It also emits Article JSON-LD (inline `<script type="application/ld+json">`), `<LLMMeta>`, OpenGraph/Twitter metadata, and a `<SourcesList>` bibliography at the end.

### Editorial primitives

All live in `web/src/@/components/features/housing/`:

| Component | File | Role |
|-----------|------|------|
| `Hero` | `hero.tsx` | Full-bleed masthead (amber bloom + grid, serif title, byline, `<StatStrip stats={HERO_STATS}>`) |
| `Section` | `section.tsx` | `{ numeral, kicker?, title, children }` numbered section header |
| `PullQuote` | `pull-quote.tsx` | `{ children, attribution? }` attributed blockquote; `<Cite>` allowed inside |
| `Cite` | `cite.tsx` | `{ id }` inline superscript `[n]` linking to `#source-<id>`; resolves via `getSource(id)`, renders **nothing** if id is unknown (typo-safe) |
| `StatStrip` | `stat-strip.tsx` | `{ stats: FeatureStat[] }` row of headline figures, tones up/down/neutral |
| `FeatureChartFrame` | `feature-chart-frame.tsx` | `{ eyebrow?, title, subtitle?, children, sourceIds?, note? }` figure wrapper for a dashboard, footer links sources |
| `ScrollReveal` | `scroll-reveal.tsx` | IntersectionObserver fade+translate entrance; honors `prefers-reduced-motion` |
| `SourcesList` | `sources-list.tsx` | Bibliography grouped by `SourceGroup`; entry anchors at `#source-<id>` |

### Data layer (`data/`)

- `types.ts` — `SourceGroup`, `Source`, `YearValue`, `MarkerEvent`, `CountrySeries`, `FeatureStat`.
- `sources.ts` — the **27-source** `SOURCES[]` bibliography grouped into 5 `SourceGroup`s (`short-thesis`, `negative-gearing`, `cgt`, `bank-credit`, `international`); `getSource(id)` O(1) lookup via a by-id map; `SOURCES_BY_GROUP` for `SourcesList`. Citations are bidirectional: `<Cite id="…">` forward-links to `#source-<id>`.
- `series.ts` — all **baked** timeseries: `AUS_REAL_HPI`, `INVESTOR_SHARE`, `NEG_GEARED_LANDLORDS`, `DEBT_TO_INCOME`, `PRICE_TO_INCOME`, `COUNTRY_SERIES` (AUS/JPN/USA/CHN with `peakYear`/`color`/`crashNote`), the marker arrays `POLICY_MARKERS`/`APRA_MARKERS`/`DTI_PEAK`, and `RATE_ELASTICITY` constants. **No RPC** — these are transcribed from the research dossier and change only when the dossier is refreshed.
- `stats.ts` — `HERO_STATS`, `NEGATIVE_GEARING_STATS`, `BANK_POWER_STATS` (`FeatureStat[]`, each carrying a `sourceId` + `tone`).

### Dashboards & the SSR-safe pattern

The server page cannot render interactive charts. The indirection is **`dashboards.tsx`** (`web/src/@/components/features/housing/dashboards.tsx`):

```tsx
"use client";
import dynamic from "next/dynamic";
const skeleton = (h: number) => () => (
  <div className="w-full animate-pulse rounded-lg bg-muted" style={{ height: h }} />
);
export const PolicyPriceChart = dynamic(
  () => import("./charts/policy-price-chart").then((m) => m.PolicyPriceChart),
  { ssr: false, loading: skeleton(400) },
);
// …BuyingPowerChart, BorrowingPowerSlider, InternationalCorrectionsChart,
//   BankShortBasket (re-exported from news/mdx)
```

The server page imports the dashboards from `dashboards.tsx` (never the chart files directly). Each is `dynamic(ssr:false)` so connect-web / measure-on-client code never executes during SSR, with a pulse skeleton sized to the chart height. The feature reuses the live **BankShortBasket** (`news/mdx/bank-short-basket`) as Dashboard ① — the only "live" chart on the feature, pulling ASIC short positions.

---

## 2. The chart system

All feature charts live in `web/src/@/components/features/housing/charts/`. They share `@visx` conventions, theme tokens, and reusable UI.

### Conventions (universal across all charts)

- **Responsive**: each chart wraps its inner component in `<ParentSize>` (`@visx/responsive`) and receives `{ width }`. Inner guards: `if (innerWidth <= 0) return null`. Margins subtracted: `innerWidth = Math.max(width - MARGIN.left - MARGIN.right, 0)`.
- **Scales**: `scaleLinear` for numeric, `scaleTime` for dates (`@visx/scale`). y-range is **inverted**: `range: [innerHeight, 0]`. Call `.nice()` for readable ticks; `.invert()` in move handlers.
- **Tooltip**: `useTooltip` + `bisector<T>(accessor).left` (d3-array, requires sorted data) + `localPoint(event)` (`@visx/event`) → `TooltipWithBounds` (stays on-canvas) styled with `TOOLTIP_STYLE`. A transparent `<Bar fill="transparent">` overlay drives `onMouseMove`/`onTouchMove`.
- **Curve**: `curveMonotoneX` everywhere.
- **Responsive text**: `const small = width < 520;` then size fonts/ticks off `small`.

### Theme & UI

`charts/chart-theme.ts` — all tokens reference CSS variables so light/dark track automatically:
`AXIS_TEXT`, `AXIS_LINE`, `GRID`, `AMBER` (`--primary`), `OLIVE` (`--secondary`), `RUST` (`--accent`), `MARKER`, and `TOOLTIP_STYLE`.

`charts/chart-ui.tsx`:
- `SegmentedToggle<T>` — compact mode/window toggle (`options`, `value`, `onChange`, `ariaLabel`).
- `LegendDot` — interactive legend swatch (`color`, `label`, `active?`, `onClick?`), dims to opacity-40 when inactive.

### The five patterns (copy the closest one when building a new chart)

1. **Dual-axis + marker annotations** — `policy-price-chart.tsx` (Dashboard ②). Left axis = `AUS_REAL_HPI` (amber AreaClosed+LinePath); right axis = toggleable secondary (`INVESTOR_SHARE` or `NEG_GEARED_LANDLORDS`); `POLICY_MARKERS` as vertical dashed lines+labels. Two scales both map to `[innerHeight, 0]`.
2. **Multi-series w/ per-series scales** — `buying-power-chart.tsx` (Dashboard ③). `DEBT_TO_INCOME` (left) vs `PRICE_TO_INCOME` (right), staggered data uses a 2-year nearest-point tolerance; `DTI_PEAK` flagged at 2018.
3. **Interactive slider w/ live calc** — `borrowing-power-slider.tsx`. **No visx** — HTML range input + CSS bars; `level = 100 * (1 + elasticity*(baselineRate-rate)/100)`; `SegmentedToggle` flips `RATE_ELASTICITY` aggressive (28%/pp) vs conservative (17%/pp).
4. **Multi-line w/ view toggle + dynamic domain** — `international-corrections-chart.tsx` (Dashboard ④). 4 `COUNTRY_SERIES`; "aligned" (peak=100, x=years-from-peak) vs "calendar"; per-country visibility toggle (never all-off); domain recomputed over visible series only; end-of-series country labels.
5. **Generic live series + format-key** — `news/mdx/article-series-chart.tsx`, consumed by `housing/housing-series-chart.tsx`. The reusable template; see §4 for the RSC-boundary format-key gotcha. (A sixth pattern — the morphing stacked-to-line **short-basket-core.tsx** — backs the BankShortBasket.)

### Recipe: a new feature dashboard

1. **Create** `charts/your-chart.tsx` (`"use client"`). Copy the closest pattern above. `MARGIN`, `HEIGHT`, `ParentSize`, `useTooltip`, transparent `<Bar>` overlay, `chart-theme` tokens, `SegmentedToggle`/`LegendDot` from `chart-ui`.
2. **Data** — either add a baked array to `data/series.ts` (cite via `sources.ts`), or fetch live (see §4 + the format-key gotcha).
3. **Register** in `dashboards.tsx`:
   ```tsx
   export const YourChart = dynamic(
     () => import("./charts/your-chart").then((m) => m.YourChart),
     { ssr: false, loading: skeleton(360) }, // match HEIGHT
   );
   ```
4. **Embed** in `page.tsx` inside `<ScrollReveal><FeatureChartFrame eyebrow="Dashboard ⑤ · …" title="…" sourceIds={[…]}><YourChart/></FeatureChartFrame></ScrollReveal>`.

---

## 3. The `/news` featured card

`web/src/@/components/news/masthead/featured.ts` exports `FEATURED: FeaturedItem[]` — curated, hand-built feature investigations that live **outside** the DB-driven `editorial_takes` pipeline. Shape: `{ href, kicker, headline, standfirst, image?, meta? }`. `href` points at a bespoke `/features/*` page (not `/news/[slug]`).

The masthead renders `FEATURED[0]` only (`web/src/app/news/page.tsx`, ~line 230: `{FEATURED[0] ? <FeaturedStory item={FEATURED[0]} /> : null}`), after `<MastheadHeader/>` + `<MarketPulse/>`, before the lead story. **Newest first** — to publish a new flagship feature, unshift one entry to the top of `FEATURED`; it auto-pins.

`featured-story.tsx` is a two-column card: left = 16:9 visual using the OG image route as a **CSS `background-image`** layered over a base gradient + an amber `radial-gradient` bloom; right = kicker/headline/standfirst/meta/CTA, hover scale 1.02x. (The browser-side `radial-gradient` bloom here is unrelated to the OG-image satori limitation in §7.)

---

## 4. The live price-tracker pipeline

End to end: **ABS/RBA → collector → `house_prices` → MV → RPC → action → dashboard**.

### Schema (`services/migrations/000053_add_house_prices.up.sql`)

- `house_price_regions` — location dimension. `region_code` PK (`'AUS'`, state codes, `'1GSYD'` GCCSA, `'SUBURB:RICHMOND-3121'`); `region_type` (`national|state|gccsa|rest_of_state|suburb|lga`); `region_name`, `state_code`, `postcode`.
- `house_prices` — narrow **EAV fact** table: one row per region × measure × dwelling × period × source. `measure` (`mean_price|median_price|total_value|price_index|transfer_count|median_rent|debt_to_income|price_to_income`), `dwelling_type` (default `all`), `period` (period-end DATE), `period_freq` (`Q|M|A`), `value`, `unit`, `is_preliminary`, `source`, `source_licence` (default `CC-BY-4.0`, carried for republish gating), `content_hash`, `fetched_at`. **UNIQUE (region_code, measure, dwelling_type, period, source)**. Indexes: `idx_house_prices_series`, `idx_house_prices_measure_period`, `idx_house_prices_source`.
- `house_price_ingest_runs` — per-source cursor (mirrors `stock_signals_runs`): `source` PK, `last_period`, `last_fetched_at`, `rows_upserted`, `status`, `detail`.
- `mv_housing_headline` — latest row per (region, measure, dwelling) for quarterly series with `qoq_abs/pct` (LAG 1) and `yoy_abs/pct` (LAG 4). UNIQUE index `idx_mv_housing_headline_key` enables `REFRESH … CONCURRENTLY`.
- `refresh_housing_materialized_views()` — dedicated PL/pgSQL refresh (decoupled from daily shorts refresh), called by the collector post-ingest.

### Collector (`services/house-price-collector/`)

- `main.go` — `-mode official|crawl|refresh|all` (default `all` = official ingest + MV refresh). `runOfficial()` runs a `jobs` slice: `{abs_res_dwell_st: ingestRESDWELLST}`, `{abs_res_dwell: ingestRESDWELL}`, `{abs_rppi: ingestRPPI}`, `{rba: ingestRBADebtToIncome}`; for each: fetch → `upsertRegions` → `upsertObservations` → `updateRun` cursor. 15-minute context timeout. `crawl` mode is opt-in and never in the default schedule.
- `abs.go` — generic ABS Data API (SDMX-CSV) parser. Base `https://data.api.abs.gov.au/rest/data`; **mandatory** `User-Agent: shorted-housing/1.0 (+https://shorted.com.au)` + `Accept: application/vnd.sdmx.data+csv;labels=both` (WAF-gated). Utilities: `fetchABSCSV`, `absColIndex`, `absCode`/`absLabel` (split `"code: label"` cells), `quarterEnd`, `applyMult` (UNIT_MULT power-of-10), `isPrelim`. `absStateAbbrev` maps `1..8` → `NSW..ACT`. Dataflow keys (exact): `RES_DWELL_ST` = `"1+5..Q"` (1=total_value, 5=mean_price), `RES_DWELL` = `"3+4..Q"` (3=established_house, 4=attached), `RPPI` = `"1.3.100.Q"` (8-cap index, frozen 2021-Q4 upstream).
- `rba.go` — RBA Table E2 CSV (`https://www.rba.gov.au/statistics/tables/csv/e2-data.csv`), series `BHFDDIT`, measure `debt_to_income`, unit `ratio`, national; parses `DD/MM/YYYY` or legacy `Mon-YYYY` → quarter-end.
- `store.go` — `connect()` uses **port 6543 + `pgx.QueryExecModeSimpleProtocol`** (Supabase txn pooler), `MaxConns=4`. `contentHash` = `sha1(region|measure|dwelling|period|source|value)`. `upsertRegions`/`upsertObservations` are idempotent batch INSERT…ON CONFLICT; `updateRun` upserts the cursor; `refreshHousingMV` calls the refresh function.

### RPC layer

- Proto (`proto/shortedapi/shorts/v1alpha1/shorts.proto`): `GetHousingOverview(region_type)` → `repeated HousingMetric + as_of`; `GetHousePriceSeries(region_code, measure, dwelling_type)` → series of `HousePricePoint`.
- Handlers `services/shorts/internal/services/shorts/house_prices.go`; queries `store/shorts/postgres_house_prices.go`. `GetHousingOverview` reads `mv_housing_headline` JOIN `house_price_regions` filtered by `region_type` (`$1='' OR r.region_type=$1`), cached via `s.cache.GetHousingOverviewKey`. `GetHousePriceSeries` reads `house_prices` ASC by period, cached via `GetHousePriceSeriesKey`.

### Frontend

- SSR action `web/src/app/actions/getHousing.ts` — `getHousingOverview`, `getHousePriceSeries`; `createClient(ShortedStocksService, transport)` to `SHORTS_API_URL`, wrapped in `cache()` + `withRetryAndNotFound()`.
- Client action `web/src/app/actions/client/getHousingClient.ts` — `getHousePriceSeriesClient`; session in-memory cache, `retryWithBackoff` (≤3, 500–5000ms).
- `web/src/app/housing/page.tsx` — server page (`revalidate: 3600`): `getHousingOverview("")`, picks national `mean_price`/`debt_to_income`/`price_index` → 3 `BigStat`s; GCCSA `median_price` established_house sorted desc → `HousingTiles`; two `HousingSeriesChart`s; Dataset JSON-LD; `<LLMMeta dataSource="ABS, RBA">`.
- `web/src/@/components/housing/` — `housing-tiles.tsx`, `housing-charts.tsx` (`dynamic(ssr:false)` wrapper of `HousingSeriesChart`), `housing-series-chart.tsx`.

### The RSC format-key gotcha (load-bearing)

`housing-series-chart.tsx` cannot receive a formatter **function** as a prop from the server page (functions can't cross the server→client boundary). Instead the server passes a serializable string `format="aud"|"percent"|"index"` and the client looks it up:

```tsx
const FORMATTERS: Record<string, (v: number) => string> = {
  aud: (v) => v >= 1e6 ? `$${(v/1e6).toFixed(2)}M` : v >= 1e3 ? `$${Math.round(v/1e3)}k` : `$${Math.round(v)}`,
  percent: (v) => `${v.toFixed(0)}%`,
  index: (v) => v.toFixed(0),
};
// …formatValue={FORMATTERS[format]}
```

Always add a new key to this map, never thread a function through props. The same component maps proto `period.seconds` (bigint) → `Date` before charting.

---

## 5. The suburb explorer (national → state → suburb map)

The third live product: a choropleth drilldown over real ABS boundaries. `/housing` shows a national **states** map (click a state to drill in); `/housing/[state]` shows a **suburb** choropleth + searchable list + a **"Colour by" metric toggle**; `/housing/[state]/[suburb]` is a rich profile. One table — `suburb_demographics`, keyed by ABS `sal_code` (SAL_CODE21) — holds three data families.

### 5.1 The suburb data model (`suburb_demographics`)

Migrations **000055** (base) + **000057** (culture) + **000058/000059/000060** (electoral). Every column is keyed by `sal_code`. (Full column inventory in §7.)

| Family | Migration | Columns | Source |
|--------|-----------|---------|--------|
| **Census demographics** | 000055 | `population`, `median_age`, `median_weekly_hhd_income`, `median_weekly_per_income`, `median_weekly_rent`, `median_monthly_mortgage`, `pct_owned_outright`, `pct_owned_mortgage`, `pct_rented`, `dwelling_count`, `census_year` | ABS Census 2021 GCP (CC-BY-4.0) |
| **Census culture** | 000057 | `pct_born_overseas`, `pct_english_only`, `top_religion`, `pct_top_religion`, `pct_no_religion`, `top_language`, `pct_top_language` | ABS Census 2021 G01/G13/G14 |
| **Federal electoral** | 000058 | `federal_division`, `federal_member`, `federal_party`, `federal_party_ab`, `federal_tpp_alp` | AEC 2025 election (CC-BY-4.0) |
| **State electoral** | 000059 + 000060 | `state_district` (000059); `state_member`, `state_party`, `state_party_ab` (000060) | ABS SED_2025 + each state parliament |

The `sal_code` **bridge** links priced regions to demographics: `house_price_regions.sal_code` (added 000055, backfilled 000056 by normalized name + state) → `suburb_demographics.sal_code`. So a suburb's median price joins its census/electoral data. `state_member/party/party_ab` are **NULL for TAS/ACT** (Hare-Clark multi-member — no single member per area).

### 5.2 Boundaries

Real ABS ASGS 2021 boundaries as TopoJSON: `web/public/geo/states.topojson` (8 states/territories) + `web/public/geo/suburbs/<STATE>.topojson` (~15k SAL suburbs), built once by `web/scripts/geo/build-boundaries.mjs` (mapshaper simplify; ~3% metro states, 8–12% sparse). Rendered by the shared `ChoroplethMap` (d3-geo `geoMercator`/`geoPath` + d3-zoom); SAL feature `id` is the bare code.

### 5.3 Census ingest (`-mode census`)

`runCensus` (collector) reads the **ABS 2021 Census GCP SAL DataPack ZIP** (`CENSUS_DATAPACK_PATH`, else downloaded) + the boundary TopoJSON (`CENSUS_GEO_DIR`) for the authoritative `sal_code → {name, state}` registry. DataPack tables read:

- **G01** — population (`Tot_P_P`) + `Birthplace_Australia/Elsewhere_P` (→ `pct_born_overseas`) + `Lang_used_home_Eng_only/Oth_Lang_P` (→ `pct_english_only`).
- **G02** — `median_age`, `median_weekly_hhd_income/per_income`, `median_weekly_rent`, `median_monthly_mortgage`.
- **G13A–E** (5 parts) — language at home. `top_language` = argmax over individual-language `MOL_<lang>_Tot` columns, **excluding** `_UOLSE_Tot` (proficiency sub-totals), `_Tot_Tot` (group rollups) and `_Oth` catch-alls; short codes mapped to names via `langDisplay`.
- **G14** — religion. `top_religion` = argmax over {Catholic, Anglican, **Other Christian** (= `Christianity_Tot_P` − Catholic − Anglican), No religion (`SB_OSB_NRA_NR_P`), Islam, Hinduism, Buddhism, Judaism, Other}; `pct_no_religion` from `SB_OSB_NRA_NR_P / Tot_P`.

ABS-suppressed (blank/0) values bind as `NULL`. `upsertDemographics` (store.go) writes the identity + demographics + culture columns.

### 5.4 Electoral ingest (`-mode electorates`) + the data-prep pipeline

The boundary→suburb spatial join + member/party roll-up are **precomputed once** (committed JSON under `web/public/geo/electorates/`); the collector then just loads + upserts — no GIS at ingest time.

**Data prep (one-time, `web/scripts/geo/`):** AEC 2025 federal division boundaries (`AUS-March-2025-esri.zip`) + ABS `SED_2025` state-district boundaries → mapshaper → GeoJSON → **spatial join** (centroid point-in-polygon ray-casting): `join-electorates.mjs` (suburbs → federal division, 99.9% matched) and `join-sed.mjs` (suburbs → state district). Federal members + two-party-preferred from the **AEC tally-room event 31496** CSVs (`HouseMembersElectedDownload-31496.csv`, `HouseTppByDivisionDownload-31496.csv`). State members from the **Wikipedia "Members of the X Legislative Assembly" tables** (`fetch-state-members.py`, value-matched to the SED districts + party names; 6 single-member states only).

**Committed derived files** (`web/public/geo/electorates/`):
| File | Shape |
|------|-------|
| `federal-divisions.json` | `{ division: { member, party, partyAb, state, tppAlp, swing } }` (~150) |
| `suburb-federal-division.json` | `{ salCode: division }` (~15.3k) |
| `suburb-sed.json` | `{ salCode: { state, district } }` (~15.3k) |
| `state-members.json` | `{ stateCode: { district: { member, party, partyAb } } }` (~404, 6 states) |

`ingestElectorates` unions the two suburb mappings; `upsertElectorates` (store.go) UPDATEs the `federal_*` + `state_*` columns by `sal_code`.

**Landmines:**
- **AEC name-casing** — boundary file has `O'connor`/`Mcpherson`, results CSV has `O'Connor`/`McPherson`; match **case-insensitively**, keep the canonical (CSV) name. Skipping this drops ~950 suburbs.
- **ABS SED `District (Region)` qualifier** — VIC/TAS seats are named `Bass (Launceston)` / `Melbourne (Northern Metropolitan)`; `join-sed.mjs` strips the trailing `(...)` so TAS resolves to its 5 Hare-Clark divisions and VIC to its 88 assembly seats.
- **Party-abbreviation substring matching** — short codes (`on`, `ind`, `nat`) substring-match member surnames ("Aitchis**on**"); the substring fallback is restricted to full party names (len > 4), abbreviations are exact-only. QLD/NT tables use the abbreviation (`LNP`/`CLP`) so those are added as exact keys.
- **Hare-Clark TAS/ACT** — multi-member, no single party per area → `state_member/party` stay NULL (the state **district** still shows).
- **SA 2025 redistribution** — SA's `SED_2025` districts were renamed vs its 2022-term member list, so ~7% of SA suburbs show the state district but no state MP.

### 5.5 RPCs

- `ListStateSuburbs(state_code, query, limit)` → `SuburbSummary[]` — the 24-field summary (identity + latest price + headline demographics + culture + federal + state) that powers the state choropleth + list.
- `GetSuburbProfile(sal_code)` → `{ SuburbSummary, SuburbDemographics, ComparisonBaselines }` — the profile page (full demographics + state/national comparison bars).
- `ListHousingRegions(region_type, state_code, query, limit)` → `HousingRegion[]` — a **parallel, older** regions-based explorer (merged from `main` before the suburb map landed). Kept alongside the suburb map (which supersedes it for the UI; `/housing/suburbs` 301-redirects to `/housing`). New work should use `ListStateSuburbs`/`GetSuburbProfile`.

Handlers in `house_prices.go`, queries in `postgres_house_prices.go`. The suburb queries LEFT-JOIN the latest median via a LATERAL subquery (covers VIC annual + national quarterly), with YoY vs the obs ~1yr prior; baselines are the avg latest median per priced suburb (state + national). All cached via `s.cache.Get<Name>Key`.

### 5.6 Frontend: the choropleth + highlight metrics

- **`ChoroplethMap`** (`choropleth-map.tsx`, `"use client"`) — one shared map at every level. Continuous mode (`valueById` + `colorScale`) or categorical mode (`categoryById` + `categoryColor`); `fill` (flex height), `focusId` (smoothly zoom to a feature + ease back), `fitValueById` (stable framing kept independent of the toggled metric so zoom persists), `fitToData`/`fitToId`, `MAX_SCALE=48`, **`vector-effect: non-scaling-stroke`** (so the 1.6u emphasis stroke stays a crisp outline at deep zoom rather than swallowing small suburbs). No-data → hatch.
- **`HIGHLIGHT_METRICS`** (`lib/housing/highlight-metrics.ts`) — the "Colour by" toggle:
  - **Continuous → amber sequential** (`amberScale`, sqrt for long-tail): `price`, `population`, `age`, `income`, `born_overseas`.
  - **Continuous → diverging**: `federal_lean` (Labor 2PP, `politicalLeanScale()` = `scaleDiverging([0,50,100], t ⇒ interpolateRdBu(1-t))`, fixed `domain:[0,100]`, `makeScale` override).
  - **Categorical → qualitative palette + swatch legend**: `religion` (`RELIGION_COLORS`), `language` (`LANGUAGE_COLORS`, English-neutral base below `LANGUAGE_MIN_PCT=5` so non-English pockets pop), `federal_party` + `state_party` (`PARTY_COLORS`, `party_ab → label` via `PARTY_LABEL`).
  - `ContinuousMetric` carries optional `domain` + `makeScale`; `CategoricalMetric` carries `category`/`colorFor`/`order`.
- **Component tree**: `NationalHousingMap` (states drilldown) → `StateSuburbExplorer` (search/sort/filter list ⟷ `StateSuburbMap` → `ChoroplethMap`, two-way hover/select, `?sal=` deep-link) → `SuburbTooltip` (hover/selected card: stats + lazy price sparkline + Culture + federal MP + State seat + "Open profile →") / `SuburbProfile` (People · Housing · **Culture & community** · **Representation** [federal division + MP + 2PP + state seat + state MP] · compare bars · locator inset · nearby rail).
- **SSR**: every map/chart is `dynamic(ssr:false)` from a `"use client"` module; metrics are dispatched by a serializable `MetricKey` (never a function prop across the RSC boundary; see §4's format-key gotcha).

To add a metric, demographic measure, or electoral source, see §9.

---

## 6. The residential real-estate crawl (Tier-3)

`services/house-price-collector/crawl*.go` runs a **live, supplementary** crawl of realestate.com.au (Kasada) and domain.com.au (Akamai): suburb-aggregate medians (`-mode crawl`) and individual for-sale listings (`-mode listings`, which diffs asking prices across runs into price-drop events in `property_listings`/`property_price_events`). It is fail-safe by design — it never blocks the ABS/RBA backbone and never stores an unvalidated value — but unlike earlier iterations of this doc, it **does now actually scrape**: verified live, e.g. a South Yarra sweep returned 132 REA + 110 Domain listings with `blocked=0`.

Two things make that possible where the original stealth-engine attempt failed: (1) a real, user-profile Chrome driven over CDP is the only client empirically proven to survive Kasada/Akamai from a residential IP (§6.3), and (2) that Chrome's REA session has to be *warmed* in a specific way, which is now proven and self-healed rather than left to an operator to remember (§6.5 — the reliability mechanism this section leads with).

### 6.1 Anti-poisoning trust model (the core invariant)

Every crawled candidate must pass **four** independent gates before storage:
1. **Absolute bounds** — floor `$100k`, ceiling `$50M`, reject NaN/Inf/≤0.
2. **Capital-band** — against `mv_housing_headline` GCCSA established-house medians: suburb median must be ≥15% and ≤8× the capital median (catches Kasada fixed/garbage values). Skipped only if no baseline.
3. **Robust median outlier rejection** — extract all candidate medians from a page's JSON blobs, filter each through gates 1+2, return the **median of survivors**; if none survive → `(0, false)`, nothing stored.
4. **Cross-source agreement** — if both REA and Domain return medians, require divergence `(hi-lo)/hi ≤ 0.30`; disagreement → reject **both**. Single source → stored `is_preliminary=true`; both agree → confirmed.

Stored as `source='crawl_rea'|'crawl_domain'`, `source_licence='proprietary-tos-restricted'` (the republish gate — these rows must never reach commercial/republished surfaces; gate on `source_licence` in any new public query). The listings tier (`-mode listings`) reuses the same **capital-band gate** (1+2) per listing before writing a `property_price_events` row, and carries the same `source_licence` on `property_listings`.

### 6.2 Schema-agnostic extraction (`crawl_extract.go` / `crawl_listings_extract.go`)

REA uses `window.ArgonautExchange`, Domain uses `__NEXT_DATA__`, Kasada serves different DOM to bots — so **never bind to selectors**. Walk every `<script>` JSON blob (raw `{…}`/`[…]` and `x = {…}` assignment forms) with a balanced-brace parser that respects string literals. The median-crawl extractor recursively harvests keys matching `(median|sold|sale)` + `price` (excluding `rent`) and parses money strings (`$1.25m`, `1,250,000`, `$985k`); the listings extractor walks the same blobs for individual listing records (REA's `ArgonautExchange → urqlClientCache` embeds each GraphQL query's `data` as a JSON *string*, requiring a second parse pass). Both hand their unconstrained candidate lists to the gates in §6.1.

### 6.3 Fetch engine — a real host Chrome over CDP, not the stealth engine

The tier originally tried the project's native `stealthhttp` engine (TLS spoofing, then Chromium escalation on a hard block) — that waterfall is **reliably detected and blocked/poisoned by Kasada/Akamai from a residential IP**, so it's no longer the operative path for REA/Domain. A brandbrain-hosted "residential fetch gateway" (POST each URL to a macOS agent, `fetcherModeGateway`/`CRAWL_GATEWAY_URL`) was also built and tried, then **superseded** in favour of the simpler option below (see `docs/superpowers/specs/2026-07-13-*` design docs) — the code path still exists but isn't the recommended one.

The production fetch is **Playwright's `ConnectOverCDP`** (`crawl_cdp.go`) attached to an already-running, **dedicated-profile** (never personal) host Chrome on the residential Mac doing the crawl — `browser.Contexts()[0]` is that Chrome's live, warm, persistent context, so the Kasada clearance cookie set on the host survives across runs without re-triggering the JS challenge every time. `newCrawlFetcher` selects this mode whenever `CRAWL_CDP_URL` is set (the default for the residential launcher); a self-launched persistent Chromium (`crawl_playwright.go`) remains as a native/launchd fallback when no CDP endpoint is configured.

Per-fetch retry with quadratic backoff (attempt² seconds) for transient failures; hard blocks return immediately. Jittered delay between suburbs (20–45s for the headed browser — heavier than the old stealth-tier pacing, to look human). Per-site circuit breaker trips after `CRAWL_MAX_CONSEC_BLOCKS` (default 3) and signals a re-warm is needed (see §6.5).

Env: `CRAWL_MAX_SUBURBS`, `CRAWL_MIN_DELAY_MS`/`CRAWL_MAX_DELAY_MS`, `CRAWL_CDP_URL`, `CRAWL_FETCH_MODE` (`gateway|cdp|playwright` override), `CRAWL_DRY_RUN`, `CRAWL_MAX_CONSEC_BLOCKS`, `CRAWL_FETCH_TIMEOUT_S`, `CRAWL_LISTINGS_SOURCES` (allowlist, e.g. run Domain-only while REA is being re-warmed). Smart-pagination + trace add `CRAWL_RESUME_WINDOW_H` and `CRAWL_TRACE`/`CRAWL_TRACE_DIR`/`CRAWL_TRACE_SUBURB` (§6.6/§6.7). Suburb catalog in `crawl_targets.go` — **115 suburbs** (25 hand-seeded + 90 ABS-population metro, 18 per mainland capital; see §6.8).

### 6.4 The brandbrain crawl-jobs queue (distributed residential agents)

Rather than each residential Mac iterating a static, hand-partitioned suburb list, the collector fans work out through a **`crawl_jobs` queue owned by brandbrain** (`api.brandbrain.dev`) — merged and deployed, endpoints under `/api/v1/agent/crawl-jobs`: `POST` (enqueue), `POST …/claim`, `POST …/submit`, `GET` (list) plus a server-side GROUP-BY summary for the queue state. brandbrain owns **only** the queue + tracking; **no listing rows or PII ever cross to brandbrain** — jobs carry suburb/state/postcode/source/tier, and results carry a **counts-only** `result_summary` (`crawlJobSummary`: suburbs, listings, events, blocked_sweeps, needs_rewarm).

- **`-mode enqueue`** (`runEnqueue`, `crawl_agent.go`) posts the curated suburb catalog (`crawlTargets`) to the queue as `listings`-tier jobs; brandbrain skips pending duplicates so re-running is idempotent.
- **`-mode agent`** (`runAgent`) polls the queue on a residential Mac: `claim` one job at a time (brandbrain fans suburbs out across multiple pollers via `SELECT … FOR UPDATE SKIP LOCKED`), run the **same per-suburb listings sweep** as `-mode listings` (§6.1–6.3) against the claimed suburb, upsert `property_listings`/`property_price_events` + link `sal_code`, then `submit` the counts-only summary back to brandbrain. Up to `CRAWL_AGENT_MAX_JOBS` (default 20) per run; MV refresh + sal-code linking happen once at the end of the run, not per job. Requires `BRANDBRAIN_AGENT_URL`; **`BRANDBRAIN_AGENT_TOKEN` is now optional** (token auto-refresh, below) — absent both a token and a co-located agent to borrow one from, the mode is a safe no-op. The suburb-*median* tier (`-mode crawl`) is not yet wired into agent mode; a `medians`-tier job fails clearly rather than silently.
- **Token auto-refresh** (`crawl_agent.go`: `roundtrip`/`refreshToken`/`canRefresh`) — the "better way" that **replaces hand-minting** a scoped agent token, so `BRANDBRAIN_AGENT_TOKEN` is now optional. On a `401` the collector re-fetches the **co-located macOS agent's current access token** from its loopback control API (reads `~/.brandbrain/diag-port` + `~/.brandbrain/control_secret`; `BRANDBRAIN_CONTROL_PORT`/`BRANDBRAIN_CONTROL_SECRET` override) and retries the request once. Because the agent rotates its ~15-minute token off a 30-day refresh token, that loopback endpoint is an always-fresh, durable credential source — no hand-minted secret, no mid-run expiry. (Unattended batches used to `401` ~11–16 min in once a static token aged out; they now self-heal.) Live-verified running with an empty `BRANDBRAIN_AGENT_TOKEN`.

The brandbrain **macOS agent app** (**v1.7.0**, shipped via Sparkle; appcast `brandbrain.dev/appcast.xml`) surfaces this queue to a human operator. The menu-bar UI now splits into **`Brands | Real-estate` segmented tabs** (previously an inline ≤3-row section); the **`RealEstateView`** shows an aggregate header (totals: suburbs / listings / events / blocked / rewarm) over **25 per-suburb rows**, each carrying that suburb's `result_summary` (listings / events / status / blocked / rewarm, tap-to-expand). This required widening the agent's `crawl_jobs_view.go` to **carry** `result_summary` + a totals aggregate through `/control/v1/status` (it used to strip them). It remains a **viewer only** — the shorted collector (`-mode agent`) does the actual fetching and writing; the app just renders brandbrain's GROUP-BY summary. Shipped as brandbrain **PR #169** (merged) + release **v1.7.0**. Design docs: `docs/superpowers/specs/2026-07-13-brandbrain-native-crawl-queue-design.md` (queue design) and `2026-07-13-brandbrain-crawl-run-tracking-design.md` (visibility).

### 6.5 Residential crawl reliability — the REA/Kasada warm mechanism

This is the load-bearing fact the whole listings tier depends on, so it's encoded twice: once as a **preflight check** the collector can run standalone, and once as **self-healing behaviour** in the launcher that wraps every scheduled run.

**The fact itself.** REA fronts Kasada, which fingerprints *how* a page was navigated to, not just what fetched it. A **Playwright-driven** navigation to a REA URL — even through a real, warm-profile Chrome — gets detected and served an ~870-byte KPSDK challenge **stub** (0 listings; the sweep silently reports "blocked"). But Chrome's own **native startup navigation** (the URL passed on the command line when the browser process launches, not a page opened by automation afterwards) passes the KPSDK proof-of-work and sets a session clearance cookie on the profile. Once that cookie exists, the *same* Playwright/CDP fetch path that was blocked now returns the real ~1.17MB `ArgonautExchange` listings page fine — Kasada only distrusts the navigation that set the cookie, not the client fetching afterwards. Warming **Domain** (Akamai) does not clear REA's Kasada cookie; Domain works cold regardless. No human clicking is required — only that the dedicated Chrome's *startup* URL is a REA page:

```bash
/Applications/Google\ Chrome.app/Contents/MacOS/Google\ Chrome \
  --remote-debugging-port=9222 \
  --user-data-dir="$HOME/.shorted-housing-crawl-chrome" \
  "https://www.realestate.com.au/"
```

**`-mode warmcheck`** (`crawl_warmcheck.go`) proves this rather than trusting an operator to remember it: it fetches one REA search page through the **exact fetcher a real crawl uses** (CDP to the host Chrome) and classifies the result — warm only if the response both exceeds a size floor (`reaWarmMinBytes = 5000`, well above the ~870B stub) **and** contains `ArgonautExchange`. It never touches the database.

**The launcher** (`deploy/run-housing-crawl.sh`) is self-healing end to end, invoked by launchd before every scheduled run:
1. **Chrome reachable?** If the dedicated Chrome's CDP port isn't up, auto-launch it with the REA startup URL above (`warm_chrome`), wait ~12s, re-check.
2. **Session actually warm?** A reachable CDP port is *not* the same thing as a warm REA session (the profile's clearance cookie can simply have expired) — run `-mode warmcheck` as a preflight. If it reports cold, relaunch Chrome (`warm_chrome` again) and retry, **up to 2 re-warm attempts**.
3. Only once warm does it run the real crawl (`-mode listings` then `-mode crawl`).

**Now self-contained in the binary (C1, 2026-07).** The same warm → warmcheck → recover-wedged loop has been ported into the collector itself (`crawl_chrome.go`) as a preflight inside `-mode agent`: it auto-launches the dedicated Chrome (dedicated `--user-data-dir` only, never the personal profile), proves warmth via the `-mode warmcheck` classifier, and hard-recovers a wedged Chrome — all in-process, before claiming any job. The residential/scheduled path therefore no longer depends on the shell launcher for warming; the launcher's warm steps remain a belt-and-braces fallback for older binaries and non-collector schedulers. This self-warm is the foundation for bundling the crawl into the brandbrain macOS agent, which just spawns `-mode agent` and lets the binary manage Chrome (see `docs/superpowers/specs/2026-07-19-agent-bundled-housing-crawl-design.md`).

**Exit codes** (mirrored by `main.go`, the launcher, and `deploy/README.md`):

| Code | Meaning |
|------|---------|
| `0` | ok |
| `3` | the crawl itself tripped its circuit breaker mid-run and needs a re-warm (fires a macOS notification) |
| `4` | Chrome still unreachable even after the launcher's own auto-launch attempt |
| `5` | `-mode warmcheck` still fails (REA still cold) after the launcher's 2 auto re-warm retries |

**Beyond warming — the block → status → circuit-break chain.** Warming prevents most blocks; two more mechanisms make the residual ones self-correcting rather than silently poisoning a batch:
- **Events-based terminal status** (`agentJobOutcome`, `crawl_agent.go`) — the queue status is gated on **events actually written**, not the raw `seen` count (poison inflates `seen > 0` with `0` events written). A blocked sweep that produced `0` events submits **`failed`**, not a misleading success.
- **Consecutive-block circuit-break** — after **2 consecutive blocked jobs** the agent stops claiming and flags a re-warm (exit `3`), so a cold session can't burn the whole batch before the launcher re-warms it (the job-level counterpart to §6.3's per-fetch `CRAWL_MAX_CONSEC_BLOCKS` breaker).

### 6.6 Smart pagination & sweep sizing

Earlier sweeps walked a fixed page budget and always came back `partial`; the listings sweep (`crawl_listings.go` `sweepSuburbSource` + `crawl_listings_extract.go` `extractPageMeta`) now **sizes and terminates each walk from the portal's own result counts**.

- **Result-count sizing (the key idea).** `extractPageMeta` reads the counts the SRP blob already carries. **REA exposes the exact on-target count** (`listings_total`, e.g. New Farm `63`) **separately** from its broadened `totalResultsCount` (`969` = the suburb *plus* surrounding suburbs). REA sweeps are sized to the **on-target** count, so a small suburb stops after ~1 page while a dense one is sized to its real inventory (bounded by the `maxPages` hard ceiling). **Domain** exposes only a broadened total (`surroundingSuburbs:"On"`), so it keeps the broadening-detection path. A clean walk that reaches the on-target page count now returns **`sweepComplete`** (delist-safe), where before it was always `sweepPartial` at the cap.
- **Broadening fix (`sweepPoisonVerdict`).** Small suburbs (esp. Greater Brisbane) run out of on-target inventory within 1–2 SRP pages, after which REA/Domain **broaden** to nearby stock. The `>0.30` off-target poison gate (§6.1) used to read that broadened tail as poison and **discard every confirmed early-page listing**. Now a *late* high-mismatch page **after** a healthy on-target set → **`sweepPartial`** (write the events, delist nothing); only an *early* high-mismatch page (genuine page-1 poison) → **`sweepBlocked`**.
- **Yield-decay stop.** End the walk when a page adds **no new on-target IDs** — catches reordered/overlapping tail pages the per-page duplicate-signature check misses.
- **Cross-page `fieldScore`-max dedup.** A thin page-1 row is upgraded in place by a richer later copy of the same listing (keep the max-`fieldScore` version).
- **Adaptive page cap.** Seeded from the ABS size hint (`CrawlTarget.Dwellings`).
- **Adaptive pacing.** The inter-page delay jitter **widens** after a blocked/high-mismatch page and **tightens** after clean pages.
- **Checkpoint/resume.** `CRAWL_RESUME_WINDOW_H` (default `0` = disabled) skips a `(source, suburb)` already swept within the window, so an interrupted batch resumes without re-crawling.

### 6.7 Debug trace mode (local-only)

`crawl_trace.go` adds an opt-in, zero-overhead-when-off trace. Enable with `CRAWL_TRACE=1` (or set `CRAWL_TRACE_DIR`; optionally scope to one suburb with `CRAWL_TRACE_SUBURB=<Display>`). For each swept `(suburb, source)` it writes to `<CRAWL_TRACE_DIR>/<runId>/<suburb>-<source>/`:

- `p{N}.png` — per-page SRP **screenshot** (captured through the same CDP fetcher the crawl uses),
- `p{N}.html` — the raw page blob,
- `trace.jsonl` — one record per page: `page, url, ms, bytes, extracted, matched, mismatch, total_results, on_target_results, want_pages, new_ids, outcome, status, decision`,
- `summary.json` — the per-`(suburb, source)` roll-up.

Because these artifacts contain portal HTML **and screenshots**, they are **local-only** — gitignored, never uploaded to brandbrain (same PII/licence posture as §6.1/§6.4).

### 6.8 Current status

The suburb-median tier (`-mode crawl`, `crawl_targets.go`) and the listings tier (`-mode listings`, plus the queue-distributed `-mode agent`) are both live and share the fetch/reliability/anti-poisoning machinery above. Domain (Akamai) has always worked cold; REA (Kasada) now works reliably too, given the warm-Chrome mechanism in §6.5 — the earlier "REA actively serves false data to bots" characterization no longer holds now that the warm-session fact is understood and automated.

**Corpus.** ~**12,151** `property_listings` across **67** suburbs (up from ~2,654 across 25 earlier this cycle); the most recent 40-suburb `-mode agent` batch returned 40/40 clean.

**Catalog.** `crawl_targets.go` was expanded **25 → 115** suburbs: the 25 hand-seeded plus **90 top-metro suburbs** (18 each across Sydney / Melbourne / Brisbane / Adelaide / Perth), generated from the ABS SAL gazetteer (population, from `suburb_demographics`) joined to Australia Post postcodes, filtered to Greater-Capital-City postcode ranges, and **deduped globally by slug** (the brandbrain queue keys on suburb *name*, so same-named cross-state suburbs would collide). Each entry carries `{Suburb slug, Display, Postcode, State, Capital (GCCSA code), Dwellings (ABS size hint, 0 until backfilled)}` — `Dwellings` seeds the adaptive page-cap (§6.6).

**Remaining scope-out.** The median tier isn't yet agent/queue-distributed (still a single static `crawlTargets` list per rig); scaling past 115 to the full ABS gazetteer (8000+) is future work — see §9 recipe E.

**Open follow-up (unmerged).** brandbrain **PR #168** makes a submitted **`failed`** job **re-pend while `attempts < max_attempts`** (auto-retrying a blocked suburb across warm runs) instead of terminal-failing. Until it merges, a blocked suburb terminal-fails and must be re-enqueued (`-mode enqueue`).

---

## 7. Data model & licensing summary

Two tables hold the live data: **`house_prices`** (narrow EAV: one row per region × measure × dwelling × period × source) + **`house_price_regions`** (location dimension), and **`suburb_demographics`** (wide, one row per ABS SAL suburb). Source/licence per row:

| Source | Measure(s) / data | Region | Live/Baked | Licence | Gate |
|--------|-----------|--------|-----------|---------|------|
| ABS RES_DWELL_ST | mean_price, total_value | national + states | LIVE | CC-BY-4.0 | none |
| ABS RES_DWELL | median_price (est. house / attached) | GCCSAs + rest-of-state | LIVE | CC-BY-4.0 | none |
| ABS RPPI | price_index | national | LIVE (frozen 2021-Q4 upstream) | CC-BY-4.0 | none |
| RBA E2/F1/F6/D1/E1 | debt_to_income, cash/mortgage rates, housing credit, balance sheet | national | LIVE | CC-BY-4.0 | none |
| ABS WPI / CPI / Lending | wage_index, rents_index, loan commitments, price_to_income | national | LIVE | CC-BY-4.0 | none |
| State Valuer-General (SA CKAN, VIC XLSX) | median_price | suburb (SA, VIC) | LIVE | CC-BY-4.0 | none |
| **ABS Census 2021 GCP SAL** (G01/G02/G13/G14) | population, medians, tenure, religion, language, born-overseas | suburb (SAL) | LIVE (`-mode census`) | CC-BY-4.0 | none |
| **AEC 2025 election** (boundaries + event 31496 CSVs) | federal division, member, party, two-party-preferred | suburb (SAL via spatial join) | LIVE (`-mode electorates`) | CC-BY-4.0 | none |
| **ABS SED_2025** | state electoral district | suburb (SAL via spatial join) | LIVE (`-mode electorates`) | CC-BY-4.0 | none |
| **State parliaments** (via Wikipedia members tables) | state member + party (6 single-member states) | suburb (SAL) | LIVE (`-mode electorates`) | CC-BY-SA (attribute) | none |
| BIS/FRED HPI | price_index (2010=100) | AUS/JPN/USA/CHN | BAKED (`series.ts`, never fetched) | public domain | none |
| OECD / ABS Lending / ATO | price_to_income, investor_share, neg_geared_count | AUS | BAKED (`series.ts`) | open | none |
| REA/Domain crawl (`-mode crawl`) | median_price | suburb | **LIVE** (brandbrain queue + warm-Chrome CDP) | proprietary-tos-restricted | **no republish** |

`source_licence` is stored on every `house_prices` row for audit; `mv_housing_headline` and the public read paths **exclude `proprietary-tos-restricted`**. The feature's baked arrays (§1) are **not** in the DB — they live only in `series.ts`.

The listings tier (`-mode listings` / `-mode agent`) is the same **LIVE** (brandbrain queue + warm-Chrome CDP) crawl but writes individual for-sale listings + price-drop events to a separate pair of tables (`property_listings`, `property_price_events`), not `house_prices` — see §6.

### `suburb_demographics` column inventory

Keyed by `sal_code` (ABS SAL_CODE21, PK). Indexed on `(state_code)` and `(sal_name)`.

| Migration | Columns |
|-----------|---------|
| **000055** (identity + census base) | `sal_code`, `sal_name`, `state_code`, `postcode`, `population`, `median_age`, `median_weekly_hhd_income`, `median_weekly_per_income`, `median_weekly_rent`, `median_monthly_mortgage`, `pct_owned_outright`, `pct_owned_mortgage`, `pct_rented`, `dwelling_count`, `census_year`, `source`, `source_licence`, `fetched_at` |
| **000057** (culture) | `pct_born_overseas`, `pct_english_only`, `top_religion`, `pct_top_religion`, `pct_no_religion`, `top_language`, `pct_top_language` |
| **000058** (federal) | `federal_division`, `federal_member`, `federal_party`, `federal_party_ab`, `federal_tpp_alp` |
| **000059** (state district) | `state_district` |
| **000060** (state member) | `state_member`, `state_party`, `state_party_ab` *(NULL for TAS/ACT)* |
| **000084** (suburb banners) | `banner_archetype`, `banner_blurb`, `banner_landmarks`, `banner_bg_key`, `banner_bg_url`, `banner_generated_at` — populated by `-mode banners` (deterministic classifier over the committed `web/public/geo/insights/suburb-archetypes.json`; 15,329 suburbs classified on prod) + the optional `web/scripts/housing-banners/blurb.mjs` LLM blurbs (templated fallback in the RPC until then). Surfaced ONLY on `GetSuburbProfile` (`banner` field) → `<SuburbBanner>` composites an archetype AVIF (`web/public/housing-banners/bg/<key>.{light,dark}.avif`) + d3-geo locator snapshot + blurb. |

> Note: `pct_owned_*` / `pct_rented` / `dwelling_count` columns exist (000055) but `-mode census` does **not** populate them (tenure tables G33/G37 aren't parsed) — they're reserved/NULL.

### Satori OG limitation

`web/src/app/features/the-widow-maker/opengraph-image.tsx` renders a 1200×630 `ImageResponse`. **satori (next/og) cannot parse sized `radial-gradient`** — the bloom uses a `linear-gradient` instead, on a `#0C0C0C` background with Georgia/system fonts (no webfont dependency). Any new feature OG image must follow the same constraint.

---

## 8. Deployment

### Collector container

`services/house-price-collector/Dockerfile` — multi-stage distroless (`gcr.io/distroless/static-debian12`), static `CGO_ENABLED=0` build. Uses the project's **stealth bind-mount/PAT pattern**: secret-mount a GitHub token (CI) or bind-mount local stealth (`--mount=type=bind,from=stealth`) with `go.mod` replace, `GOPRIVATE=github.com/skunkworq/*`. Default `ENTRYPOINT` runs `-mode all`. No GCS — it fetches HTTPS and writes Postgres directly.

### Terraform module (built, NOT yet wired)

`terraform/modules/house-price-collector/` exists (`main.tf`, `variables.tf`, `outputs.tf`): collector service account, Secret Manager IAM read on `DATABASE_URL`, `google_cloud_run_v2_job.collector` (1 task, 1800s timeout, 1 vCPU / 512Mi, DATABASE_URL from Secret Manager), a scheduler-invoker SA with `run.invoker`, and `google_cloud_scheduler_job.monthly` (`0 16 5 * *` = 5th of month 16:00 UTC ≈ 2-3 AM AEST, `scheduler_region` must be `australia-southeast1`). Variable: `image_url`. Outputs: `job_name`, `service_account_email`, `scheduler_job_name`.

**Not yet done** (verified — no references in `terraform/environments/` or the CI matrix): the module is not instantiated in `environments/dev` or `environments/prod`, there is no `house_price_collector_image` variable, and `house-price-collector` is absent from the `terraform-deploy.yml` build matrix. See the wiring recipe below.

### Prod DDL procedure

Housing migrations are applied **manually** against prod Supabase via the **session pooler port 5432** (not txn pooler 6543) with `PGOPTIONS="-c statement_timeout=0"` (needed for `REFRESH … CONCURRENTLY`). The full housing migration set:

| Migration | Adds |
|-----------|------|
| `000053` | `house_prices`, `house_price_regions`, `house_price_ingest_runs`, `mv_housing_headline`, refresh fn |
| `000054` | licence gate (excludes `proprietary-tos-restricted` from the MV) |
| `000055` | `suburb_demographics` + `house_price_regions.sal_code` bridge column |
| `000056` | backfill `house_price_regions.sal_code` (name+state match) — run **after** census ingest |
| `000057` | culture columns (religion, language, born-overseas) |
| `000058` / `000059` / `000060` | federal electoral / state district / state member+party |

```bash
PGOPTIONS="-c statement_timeout=0" psql "postgresql://…@…:5432/postgres" \
  -f services/migrations/000057_add_suburb_culture_demographics.up.sql
```

### Manual ingest runs

The collector ingest is manual (the Cloud Run Job is built but not yet wired — see below). DDL on `:5432`, bulk upserts on the **txn pooler `:6543`** (the collector's `store.go` forces `SimpleProtocol` for it):

```bash
cd services
DATABASE_URL="…:6543/postgres" go run ./house-price-collector -mode official     # ABS/RBA/VG price ingest (~2 min) + MV refresh
DATABASE_URL="…:6543/postgres" \
  CENSUS_DATAPACK_PATH=/path/2021_GCP_SAL_for_AUS_short-header.zip \
  CENSUS_GEO_DIR=$(pwd)/../web/public/geo/suburbs \
  go run ./house-price-collector -mode census                                     # ABS Census → suburb_demographics
DATABASE_URL="…:6543/postgres" \
  ELECTORATES_DIR=$(pwd)/../web/public/geo/electorates \
  go run ./house-price-collector -mode electorates                                # federal + state representation
```

`-mode refresh` = MV-only. After a **census** re-run, also re-apply `000056` (the sal_code backfill reads the now-populated `suburb_demographics`).

---

## 9. Future extensions (concrete recipes)

### A. Wire the **feature** charts to live data
The feature's 4 charts are baked. To make (say) `policy-price-chart` live: ingest the underlying series into `house_prices` (new ABS measures — recipe C), expose them via `GetHousePriceSeries`, and fetch client-side **using the format-key pattern from `housing-series-chart.tsx`** (string `format`, never a function prop). Keep the `dashboards.tsx` `dynamic(ssr:false)` wrapper. The cleanest path is to generalize `housing-series-chart.tsx` rather than rewrite each `@visx` feature chart.

### B. Add a **new feature dashboard**
See §2 "Recipe". Pick the closest of the five patterns, add baked data to `series.ts` + a source to `sources.ts` (sequential `n`, a `group`), register in `dashboards.tsx` (`ssr:false`, skeleton height = chart HEIGHT), embed in `page.tsx`.

### C. Add a **new ABS dataflow / measure**
1. In `abs.go`, add `ingestNEWFLOW(ctx) ([]Observation, error)` calling `fetchABSCSV(ctx, "DATAFLOW_ID", "key", "startPeriod")`; map MEASURE codes to canonical measure names; emit normalized `Observation`s (new `region_type`/`absStateAbbrev` entries if a new region granularity).
2. Add `{"abs_new", ingestNEWFLOW}` to the `runOfficial()` jobs slice in `main.go`.
3. No schema change — `house_prices` is EAV; just document the new `measure` string. New `region_type`s flow through `GetHousingOverview`'s `region_type` filter with no RPC change.

### D. Add a **new RPC / new dashboard panel**
Follow the project's 4-layer store pattern + Connect-RPC handler convention. Proto in `shorts.proto`, handler in `house_prices.go` (cache via `s.cache.GetXKey`), query in `postgres_house_prices.go`, SSR action in `getHousing.ts` (`cache()`+`withRetryAndNotFound`), client action in `getHousingClient.ts` (session cache + backoff), then a `web/src/@/components/housing/*` panel and an entry in `housing/page.tsx`'s `ChartCard` grid.

### E. Scale the **residential crawl** beyond the curated catalog

The crawl is live (§6) — a real host Chrome over CDP, warmed via a native REA startup URL and kept warm by `-mode warmcheck` + the self-healing launcher. What's left is scale, not defenses: (1) grow `crawl_targets.go` from its current **115** suburbs (25 seed + 90 ABS-population metro, 18 per mainland capital) toward the full ABS gazetteer (8000+) — enqueue in batches via `-mode enqueue`, let more `-mode agent` residential pollers (one per Mac, identified by `CRAWL_AGENT_ID`) drain the brandbrain queue concurrently (`SKIP LOCKED` already handles the fan-out safely); (2) wire the suburb-**median** tier (`-mode crawl`) into agent/queue mode — today only the listings tier is queue-distributed, medians still run off the static per-rig `crawlTargets`/`CRAWL_SHARD_INDEX`/`CRAWL_SHARD_COUNT` partition; (3) a **Domain developer API** path as a legitimate, trusted alternative (`source='domain_api'`, skips the paranoia — `upsertObservations` handles any `source` string) — Domain already works cold so this is a nice-to-have, not a blocker. The four validation gates (§6.1) stay intact regardless of scale. Never relax the `source_licence='proprietary-tos-restricted'` republish gate.

### F. Finish the **Terraform wiring**
The module is built; to schedule the collector in prod:
1. **CI matrix** — add to `.github/workflows/terraform-deploy.yml` `build-docker-images` matrix: `{name: house-price-collector, dockerfile: services/house-price-collector/Dockerfile, context: services}` (it pushes `…/shorted/house-price-collector:${tag}`, needs the stealth `github_token` secret-mount like other services).
2. **Variable** — add `house_price_collector_image` to `terraform/environments/{dev,prod}/variables.tf`.
3. **Module** — instantiate `module "house_price_collector"` in `environments/{dev,prod}/main.tf` (`source = "../../modules/house-price-collector"`, `scheduler_region = "australia-southeast1"`, `image_url = var.house_price_collector_image`).
4. **Plan var** — add `-var="house_price_collector_image=…:${image-tag}"` to the `terraform-plan` step.
Follow the existing `short_data_sync` module/variable/image-tag flow as the template. Confirm `min_instance_count` stays 0 per the project cost guardrail (Cloud Run **Jobs** scale to zero by nature, but keep the rule in mind for any added service).

### G. Add a **new suburb-map highlight metric** (§5.6)

1. Ensure the field reaches the client: add it to `suburb_demographics` (migration) → `census`/`electorates` ingest → `SuburbSummary` proto + the store `SELECT`/`Scan` + the RPC mapping → `SuburbDatum` (`state-suburb-map.tsx`) + the explorer mapping → `SuburbMetricInput` (`highlight-metrics.ts`).
2. Add the metric to `HIGHLIGHT_METRICS`:
   - **Continuous** → `{ kind:"continuous", value, format, sqrt? }`; for a fixed-range or non-amber scale add `domain` + `makeScale` (e.g. a diverging scale like `politicalLeanScale`).
   - **Categorical** → `{ kind:"categorical", category, colorFor, order }`; add a palette + a `*_LABEL`/`*_COLORS` map. `category` returns `null` for no-data (→ hatch).
3. The selector, legend (gradient vs swatch), and `ChoroplethMap` continuous/categorical dispatch are automatic — `state-suburb-map.tsx` reads `metric.kind`.

### H. Add a **new ABS Census measure** (`-mode census`, §5.3)

1. In `census.go`/`census_culture.go`, parse the new GCP table (find the exact `_AUST_SAL.csv` entry + the short-header column codes by inspecting the DataPack ZIP — the codes are non-obvious). Add fields to `CensusRow` + the relevant `parseGNN`.
2. Add the column(s) to `suburb_demographics` (migration) + the `upsertDemographics` INSERT/`ON CONFLICT`.
3. Thread to the API only if the map/profile needs it (proto + store + RPC + frontend, per recipe G). Re-run `-mode census` then re-apply the `000056` sal_code backfill.

### I. Finish the **state member + party** layer / refresh electoral data

- **State party** currently covers the 6 single-member states (NSW/VIC/QLD/WA/SA/NT) via `fetch-state-members.py` scraping the Wikipedia members tables. TAS/ACT are Hare-Clark multi-member — to surface them you'd model multiple members/parties per district (not a single `state_party`), so the map would need a different (e.g. dominant-party or "mixed") treatment.
- **Refresh after an election / redistribution**: re-run the data-prep (new AEC boundaries + tally-room event id, new ABS `SED` edition, re-scrape `fetch-state-members.py` for the new term), re-commit the `web/public/geo/electorates/*.json`, then `-mode electorates`. No schema change. Watch the `fetch-state-members.py` page-title year ranges + the party-abbreviation map.

---

## 10. The price-drops surface (`/price-drops`) & crawl-aligned caching

The flagship rollup over the §6 listings corpus (PRs #315 flagship, #318 caching, #320
provenance, #322 empty-shell guard; spec: `docs/superpowers/specs/2026-07-21-price-drops-design.md`).
Four boards on one page: **national pulse tiles → drops by state → suburbs cutting hardest →
biggest individual drops (with agency attribution) → agencies cutting hardest**, plus a
methodology footer. `/housing/drops` 308-redirects here; `/housing`, `/housing/[state]` and
suburb profiles cross-link in.

### 10.1 Derived-aggregate data model (migration `000086_price_drops_rollups`)

> Migration-number history: authored as 000083, renumbered twice after collisions with
> concurrently-merged branches (state-exposure took 000083; banners hold 000084) — the
> CONTENT was applied to prod manually under its original number, which is fine because
> prod DDL is applied by hand (schema_migrations tracker is not advanced on prod).

| MV | Grain | What it holds |
|----|-------|---------------|
| `mv_suburb_price_drops` (rebuilt) | `region_code` | 30-day drop signal: dropped count, avg/median/max pct, max abs, `dropped_value`; n≥3 floor |
| `mv_state_price_drops` | `state_code` + an `AU` national row (GROUPING SETS) | drop stats + asking/sold aggregates + tracked counts per state |
| `mv_agency_stats` | (`source`, `agency_id`, `state_code`) | per-portal agency footprint: active/priced listings, median asking, suburbs covered, 30-day drop stats, ≤6 sample `agent_names` |

**Data-quality rules baked into every drop aggregate** (calibrated on prod):
- **40% sanity cap** — `drop_pct > 0.40` events are listing typo corrections (e.g. $7.5M→$750k
  extra-zero fixes), excluded everywhere (MVs AND the per-listing board queries).
- **Cross-portal address dedup** — ~30% of listings are on both portals; every aggregate
  dedups by `COALESCE(NULLIF(address_key,''), source||':'||listing_id)` on **numerators AND
  denominators** (mixed units understated `dropped_share` up to 2× before).
- **Severest-portal dollar sums** — per address, `dropped_value` sums one portal's events
  (the portal that observed the most cutting), so a cut seen on both portals never
  double-counts while multiple real cuts do sum.
- **`AU` guard** — junk `state_code='AU'` rows are excluded (they'd collide with the national
  GROUPING SETS row and abort the whole MV refresh via the unique index).
- **Agency identifiability floor** — drop depth/value (`avg_drop_pct`, `total_drop_value`)
  are suppressed (NULL) below **3 dropped addresses** so no published figure reverses to a
  single listing's exact numbers; `active_listings >= 3` floor for the row itself.

All three MVs are folded into `refresh_housing_materialized_views()` (guarded CONCURRENTLY
fallback), refreshed by every collector post-run path.

### 10.2 RPCs & gating

| RPC | Gate | Notes |
|-----|------|-------|
| `GetPriceDropsOverview` | none (anonymous aggregates) | national + per-state rows |
| `ListSuburbPriceDrops` | none | drives /price-drops suburb board + the /housing panels; tolerant `to_jsonb(d)->>'dropped_value'` select so code-first deploys survive the pre-migration MV shape |
| `ListAgencyPriceStats` | **`HOUSING_DROP_LISTINGS_ENABLED`** | carries agency/agent NAMES from ToS-restricted rows → same kill switch as the per-listing surfaces; inputs normalized before the MemoryCache key |
| `ListSuburbDropListings` / `ListAddressPriceDrops` / `GetPropertyHistory` | `HOUSING_DROP_LISTINGS_ENABLED` | per-listing deep-link-out surfaces; now also return `agency_name` + `agent_names` |

Licence posture unchanged from §6/§7: raw listing rows never republished; aggregates are the
publishable surface; per-listing rows deep-link OUT to the live portal page.

### 10.3 Crawl-aligned caching (pay-per-crawl, not pay-per-visitor)

The corpus changes ~once/day (when a crawl batch lands), so freshness is EVENT-driven with
TTLs only as self-healing ceilings:

```
crawl batch (rig -mode agent / -mode listings / official refresh)
  └─ refreshHousingMV()  — SQL refresh of all housing MVs
      └─ pingRevalidate() — services/house-price-collector/revalidate.go
          POST $REVALIDATION_URL?secret=…&path=/price-drops,/housing&flush=housing
          (detached 45s ctx; warn-only; NO-OP when env unset)
              ├─ revalidatePath(/price-drops, /housing)   — busts the ISR route cache
              └─ flush=housing → deleteCachedByPrefix(cache:housing:*)  — busts KV
                     (flush= takes a comma list; `shorts` and `housing` families exist)
next visitor → ISR regen → server actions live-fetch → repopulate KV → HIT for everyone
```

Layer map for one `/price-drops` view:

| Layer | TTL | Notes |
|-------|-----|-------|
| Vercel route cache (static ISR) | 1h ceiling | `revalidate = 3600`; page is prerendered — **do not read `searchParams` in the server page** (forces dynamic); the `?state=` deep link is read client-side via `useSearchParams` under a `<Suspense>` boundary |
| Upstash KV (`cache:housing:drops:*`) | 24h ceiling | `getHousing.ts` actions: skipForBuild guard + toJson/fromJson projections + ISR-cacheable transport (`next:{revalidate}` — without it the no-store POST silently flips the route dynamic); **empty responses are never cached** |
| Backend MemoryCache | 5 min | per-Cloud-Run-instance L2, singleflight-deduped |
| Browser | 30 min TanStack / 5 min sessionStorage | address board only; default view is server-seeded via `initialAddresses` → `useQuery initialData` (never seed an EMPTY array — initialData suppresses the client fetch for the whole staleTime) |

**The empty-shell defenses** (all three are required — see
`web/src/app/actions/config.ts`):
1. **Build shell**: `skipForBuild()` prerenders an empty page → cleared by the post-deploy
   warm (`/api/static-pages/warm-cache`, `/price-drops` is in `STATIC_PAGES`; the CI re-prime
   needs the Cloudflare bypass).
2. **KV**: actions never cache an empty response.
3. **Route cache**: `bailOnEmptyRender()` — calls `unstable_noStore()` exactly when a page
   renders its data-empty fallback, so a failed regen fetch (cold min-instances=0 Cloud Run
   after a deploy) is served once UNCACHED instead of pinning "data is loading" for the full
   window. It NO-OPS during the build so routes STAY static ISR. Wired into
   `/housing /price-drops /economy /compare` — wire it into any new static data page.

Measured effect: 380–640ms force-dynamic TTFB → **40–58ms `x-vercel-cache: HIT`**, with
Cloud Run RPC volume for the page down to ~hourly worst case.

### 10.4 Ops

- **Rig env** (`~/.shorted-housing-crawl.env`): `REVALIDATION_URL` (Vercel-origin default —
  Cloudflare's managed challenge can block non-browser POSTs to the canonical host, though
  cloudflare-edge carries a skip rule for `/api/revalidate`) + `REVALIDATION_SECRET` (prod
  Secret Manager, shared with short-data-sync). Cloud Run job: Terraform
  `manage_revalidation_secret = true` (prod) mirrors the short-data-sync module.
- **Kill switch**: `HOUSING_DROP_LISTINGS_ENABLED` (default ON; falsey disables) empties the
  per-listing boards AND the agency leaderboard; the anonymous suburb/state aggregates stay up.
- **Blurb backfill** (optional): cost-lean runner pattern = target only the ~115 crawl-catalog
  suburbs (`property_listings` sal link) + shim `agy --effort low` (~7s/call) ≈ 15–20 min ≈ $1–2,
  vs ~18h/$30–60 for the full priced set. No overwrite flag; a valid LLM `archetype_hint`
  OVERWRITES the classifier's background choice.
- **Bundle-weight landmine**: protobuf-es schemas reference the WHOLE-FILE descriptor, so every
  message added to the monolithic `shorts.proto` adds ~1:1 first-load weight to EVERY route that
  imports anything from `shorts_pb.ts` (the arc cost ~+31kB × 6 routes; budgets re-based in
  `web/scripts/bundle-budget.mjs`). Reclaim: split `shorts.proto` into per-domain files.

### 10.5 Extension recipes

- **(J) New drops rollup metric** — add the column to the MV in a NEW migration (recreate MV +
  unique index + refresh fn), apply the same 40% cap + address dedup CTE shape, add the proto
  field (`buf generate`), select it in `postgres_house_prices.go` (keep the tolerant-select
  pattern if the existing suburb MV shape changes), map it in `house_prices.go`, render it in
  `web/src/@/components/housing/price-drops/*`. Remember prod DDL is manual (session pooler
  :5432) and DB-before-code.
- **(K) New cached housing page** — copy the `/price-drops` treatment end-to-end: `revalidate`
  export + KV'd actions (cacheable transport!) + `bailOnEmptyRender()` on the empty branch +
  add to warm-cache `STATIC_PAGES` + include its KV keys under `cache:housing:` so the crawl
  ping busts it for free.
