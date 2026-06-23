# Housing Architecture

The "housing" surface on Shorted is two products plus a speculative data tier, all sharing one chart system and one data model:

1. **The Widow-Maker editorial feature** (`/features/the-widow-maker`) — a hand-built investigative long-read with embedded interactive dashboards. Data is **baked** (curated research arrays).
2. **The House Prices Tracker** (`/housing`) — a **live** dashboard fed by a real ABS/RBA ingest pipeline through Connect-RPC.
3. **A Tier-3 stealth crawl** of REA/Domain suburb medians — present in the collector, **opt-in**, anti-poisoning, licence-gated, and **not yet actually scraping**.

This document is an extension guide. Read the section matching what you're building, then the matching "Future extensions" recipe at the end.

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

`featured-story.tsx` is a two-column card: left = 16:9 visual using the OG image route as a **CSS `background-image`** layered over a base gradient + an amber `radial-gradient` bloom; right = kicker/headline/standfirst/meta/CTA, hover scale 1.02x. (The browser-side `radial-gradient` bloom here is unrelated to the OG-image satori limitation in §6.)

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

## 5. The Tier-3 stealth crawl

`services/house-price-collector/crawl*.go` adds an **opt-in, supplementary** suburb-median crawl of realestate.com.au (Kasada) and domain.com.au (Akamai). It is fail-safe by design — it never blocks the ABS/RBA backbone and never stores an unvalidated value.

### Anti-poisoning trust model (the core invariant)

Every crawled candidate must pass **four** independent gates before storage:
1. **Absolute bounds** — floor `$100k`, ceiling `$50M`, reject NaN/Inf/≤0.
2. **Capital-band** — against `mv_housing_headline` GCCSA established-house medians: suburb median must be ≥15% and ≤8× the capital median (catches Kasada fixed/garbage values). Skipped only if no baseline.
3. **Robust median outlier rejection** — extract all candidate medians from a page's JSON blobs, filter each through gates 1+2, return the **median of survivors**; if none survive → `(0, false)`, nothing stored.
4. **Cross-source agreement** — if both REA and Domain return medians, require divergence `(hi-lo)/hi ≤ 0.30`; disagreement → reject **both**. Single source → stored `is_preliminary=true`; both agree → confirmed.

Stored as `source='crawl_rea'|'crawl_domain'`, `source_licence='proprietary-tos-restricted'` (the republish gate — these rows must never reach commercial/republished surfaces; gate on `source_licence` in any new public query).

### Schema-agnostic extraction (`crawl_extract.go`)

REA uses `window.ArgonautExchange`, Domain uses `__NEXT_DATA__`, Kasada serves different DOM to bots — so **never bind to selectors**. Walk every `<script>` JSON blob (raw `{…}`/`[…]` and `x = {…}` assignment forms) with a balanced-brace parser that respects string literals, recursively harvest keys matching `(median|sold|sale)` + `price` (excluding `rent`), parse money strings (`$1.25m`, `1,250,000`, `$985k`). Hand the unconstrained candidate list to the validator.

### Fetch engine (`crawl.go`)

Native→Chromium **waterfall**: try the cheap native `stealthhttp` engine (TLS spoofing, realistic browser headers automatically — **do not hand-set a UA**), escalate to Chromium only on a hard block (403/429/401). Per-fetch retry with quadratic backoff (attempt² seconds) for transient failures; hard blocks return immediately. Jittered 5–15s sleep between suburbs. Per-site circuit breaker trips after `CRAWL_MAX_CONSEC_BLOCKS` (default 3).

Env: `CRAWL_MAX_SUBURBS`, `CRAWL_MIN_DELAY_MS`/`CRAWL_MAX_DELAY_MS`, `CRAWL_PROXY`, `CRAWL_DISABLE_CHROMIUM`, `CRAWL_DRY_RUN`, `CRAWL_MAX_CONSEC_BLOCKS`, `CRAWL_FETCH_RETRIES`, `CRAWL_FETCH_TIMEOUT_S`. Seed targets in `crawl_targets.go` (~10 suburbs).

### Current reality

REA (Kasada) actively serves **false** medians to suspected bots; Domain (Akamai) returns 403 to non-browsers. The defenses are rock-solid (DB will never be poisoned) but the crawl is **blind to active attacks** — to actually scrape you need a Kasada solver + residential proxy rotation (`CRAWL_PROXY` is already plumbed into both engines) or a Domain API agreement. See "Future extensions".

---

## 6. Data model & licensing summary

| Source | Measure(s) | Region | Live/Baked | Licence | Gate |
|--------|-----------|--------|-----------|---------|------|
| ABS RES_DWELL_ST | mean_price, total_value | national + states | LIVE | CC-BY-4.0 | none |
| ABS RES_DWELL | median_price (est. house / attached) | GCCSAs + rest-of-state | LIVE | CC-BY-4.0 | none |
| ABS RPPI | price_index | national | LIVE (frozen 2021-Q4 upstream) | CC-BY-4.0 | none |
| RBA E2 | debt_to_income | national | LIVE | CC-BY-4.0 | none |
| BIS/FRED HPI | price_index (2010=100) | AUS/JPN/USA/CHN | BAKED (`series.ts`, never fetched) | public domain | none |
| OECD | price_to_income (2015=100) | AUS | BAKED | OECD open | none |
| ABS Lending Indicators | investor_share | national | BAKED | CC-BY-4.0 | none |
| ATO Tax Stats | neg_geared_count | AUS | BAKED | CC-BY-4.0 | none |
| REA/Domain crawl | median_price | suburb | crawl (blocked) | proprietary-tos-restricted | **no republish** |

All `source_licence` values are stored on every `house_prices` row for audit. The feature's baked arrays are **not** in the DB — they live only in `series.ts`.

### Satori OG limitation

`web/src/app/features/the-widow-maker/opengraph-image.tsx` renders a 1200×630 `ImageResponse`. **satori (next/og) cannot parse sized `radial-gradient`** — the bloom uses a `linear-gradient` instead, on a `#0C0C0C` background with Georgia/system fonts (no webfont dependency). Any new feature OG image must follow the same constraint.

---

## 7. Deployment

### Collector container

`services/house-price-collector/Dockerfile` — multi-stage distroless (`gcr.io/distroless/static-debian12`), static `CGO_ENABLED=0` build. Uses the project's **stealth bind-mount/PAT pattern**: secret-mount a GitHub token (CI) or bind-mount local stealth (`--mount=type=bind,from=stealth`) with `go.mod` replace, `GOPRIVATE=github.com/skunkworq/*`. Default `ENTRYPOINT` runs `-mode all`. No GCS — it fetches HTTPS and writes Postgres directly.

### Terraform module (built, NOT yet wired)

`terraform/modules/house-price-collector/` exists (`main.tf`, `variables.tf`, `outputs.tf`): collector service account, Secret Manager IAM read on `DATABASE_URL`, `google_cloud_run_v2_job.collector` (1 task, 1800s timeout, 1 vCPU / 512Mi, DATABASE_URL from Secret Manager), a scheduler-invoker SA with `run.invoker`, and `google_cloud_scheduler_job.monthly` (`0 16 5 * *` = 5th of month 16:00 UTC ≈ 2-3 AM AEST, `scheduler_region` must be `australia-southeast1`). Variable: `image_url`. Outputs: `job_name`, `service_account_email`, `scheduler_job_name`.

**Not yet done** (verified — no references in `terraform/environments/` or the CI matrix): the module is not instantiated in `environments/dev` or `environments/prod`, there is no `house_price_collector_image` variable, and `house-price-collector` is absent from the `terraform-deploy.yml` build matrix. See the wiring recipe below.

### Prod DDL procedure

Apply `000053` against prod Supabase via the **session pooler port 5432** (not txn pooler 6543) with `PGOPTIONS="-c statement_timeout=0"`:

```bash
PGOPTIONS="-c statement_timeout=0" psql "postgresql://…@…:5432/postgres" \
  < services/migrations/000053_add_house_prices.up.sql
```

Manual collector run: `cd services/house-price-collector && DATABASE_URL="…" go run . -mode=all` (~2 min for official ingest). `-mode=refresh` for MV-only.

---

## 8. Future extensions (concrete recipes)

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

### E. Make the **crawl actually scrape**
The architecture is defensively complete; what's missing: (1) a **Kasada solver** for REA (integrate into the Chromium escalation; goes stale within weeks as Kasada updates); (2) **residential proxy rotation** — already plumbed via `CRAWL_PROXY` into both engines (`export CRAWL_PROXY="socks5://…"`); (3) a **Domain developer API** path as a legitimate alternative (`source='domain_api'`, trusted, skips the paranoia — `upsertObservations` handles any `source` string); (4) scale `crawl_targets.go` from ~10 seed suburbs to the full ABS gazetteer (8000+ → 5–10h at 5–15s jitter; parallelize per-state). The four validation gates stay intact regardless. Never relax the `source_licence='proprietary-tos-restricted'` republish gate.

### F. Finish the **Terraform wiring**
The module is built; to schedule the collector in prod:
1. **CI matrix** — add to `.github/workflows/terraform-deploy.yml` `build-docker-images` matrix: `{name: house-price-collector, dockerfile: services/house-price-collector/Dockerfile, context: services}` (it pushes `…/shorted/house-price-collector:${tag}`, needs the stealth `github_token` secret-mount like other services).
2. **Variable** — add `house_price_collector_image` to `terraform/environments/{dev,prod}/variables.tf`.
3. **Module** — instantiate `module "house_price_collector"` in `environments/{dev,prod}/main.tf` (`source = "../../modules/house-price-collector"`, `scheduler_region = "australia-southeast1"`, `image_url = var.house_price_collector_image`).
4. **Plan var** — add `-var="house_price_collector_image=…:${image-tag}"` to the `terraform-plan` step.
Follow the existing `short_data_sync` module/variable/image-tag flow as the template. Confirm `min_instance_count` stays 0 per the project cost guardrail (Cloud Run **Jobs** scale to zero by nature, but keep the rule in mind for any added service).
