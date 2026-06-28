# Housing Map & Suburb Drilldown — Design

**Date:** 2026-06-28
**Branch:** `feat/housing-suburb-map` (off `feat/house-price-tracker`)
**Status:** Approved design → implementation planning

## 1. Summary

Replace the placeholder suburb map (a Voronoi tessellation of ~800 point
centroids on the unmerged `fix/housing-suburb-explorer` branch — no real
geographic boundaries) with a **real ABS boundary choropleth** and build a
proper **national → state → suburb** drilldown experience:

- A national map of states and a per-state map of real suburb polygons.
- Click-to-drill navigation (national → state → suburb) with breadcrumbs.
- Pinch-to-zoom / pan on the map.
- Rich hover tooltips (demographics + price sparkline) that deepen into a
  full per-suburb profile on click.
- New per-suburb demographic metadata sourced from **ABS Census 2021**.

The work lands on a fresh branch off `feat/house-price-tracker`. The clean,
reusable pieces from `fix/housing-suburb-explorer` (the `ListHousingRegions`
RPC + store query + `/housing/suburbs` scaffolding + proto) are **ported
selectively**; the Voronoi map and that branch's unrelated changes (admin
jobs, SEO, sitemap, kv-cache) are **left behind**.

## 2. Goals / Non-goals

**Goals**
- Real ABS ASGS 2021 boundaries: states (STE) nationally, suburbs (SAL) per state.
- Three URL-addressable levels, all SEO-indexable: `/housing`,
  `/housing/[state]`, `/housing/[state]/[suburb]`.
- Pinch-zoom + pan, implemented with `d3-zoom` over an SVG choropleth.
- Hover tooltip: name + postcode, median price + YoY, demographic stat block,
  lazy price sparkline. Click → per-suburb profile.
- Per-suburb profile with rich stats (price history, demographics, comparison
  to state/national).
- Demographics ingested from ABS Census 2021 (CC-BY), keyed by SAL code.

**Non-goals (v1)**
- Property-portal crawl (REA/Domain) for rent / yield / days-on-market — the
  WAF-blocked crawl is deferred; the profile page reserves a clearly-marked
  slot for it.
- A vector-tile basemap (MapLibre) — chosen against for infra/cost; no
  road/coastline basemap context in v1.
- Suburb price coverage beyond what exists (SA + VIC, via state Valuer-General).
  The map spans all of Australia for **demographics**; price is shown where
  available and a "no price data" treatment is used elsewhere.

## 3. Current state (what we build on)

| Layer | Today (`feat/house-price-tracker`) | Reusable from `fix/housing-suburb-explorer` |
|---|---|---|
| Page | `/housing` overview (tiles + 2 charts), no map | `/housing/suburbs` explorer page scaffold |
| Components | `housing-tiles.tsx`, `housing-series-chart.tsx`, `housing-charts.tsx` | `suburb-explorer.tsx` (search/list/detail shell — **map swapped out**) |
| Map | none | `suburb-map.tsx` (Voronoi — **discarded**), `suburb-centroids.json` (**discarded**) |
| RPC | `GetHousingOverview`, `GetHousePriceSeries` | `ListHousingRegions` (**port**) |
| Go store | `postgres_house_prices.go` | `ListHousingRegions` query (**port**) |
| Proto | housing messages | `ListHousingRegions` + `HousingRegion` (**port**) |
| Client action | `getHousingClient.ts` | `listHousingRegionsClient` (**port**) |
| DB | migration `000053_add_house_prices` | `suburb_demographics` stub (**replace with real schema**) |

Backend collector: `services/house-price-collector/` already ingests ABS
(`abs.go`) and RBA (`rba.go`) and has a (WAF-blocked) suburb crawl tier. We
extend it with a **Census** ingester.

## 4. Architecture

```
ABS ASGS 2021 boundaries ──► build-boundaries.mjs ──► web/public/geo/*.topojson (static, lazy per-state)
ABS Census 2021 GCP ───────► collector `census` mode ─► suburb_demographics (keyed by SAL code)
house_prices (existing) ────► ListHousingRegions / GetSuburbProfile RPC ─► server+client actions ─► pages
                                            join via region_code ↔ sal_code mapping
```

Rendering: one shared `<ChoroplethMap>` core (d3-geo projection + d3-zoom),
used at both the national (states) and state (suburbs) levels, loaded
`dynamic({ ssr:false })` per the repo's Connect-RPC/SSR safety convention.

## 5. Routes & navigation

| Level | Route | Content |
|---|---|---|
| National | `/housing` | Existing overview **+** national states choropleth. Click a state polygon **or a capital-city tile** → state view. |
| State | `/housing/[state]` | State suburb choropleth + state headline stats + searchable suburb list. Click suburb → suburb view. |
| Suburb | `/housing/[state]/[suburb]` | Rich per-suburb profile. |

- **State slug**: lowercased state code (`nsw`, `vic`, `qld`, `sa`, `wa`,
  `tas`, `nt`, `act`).
- **Suburb slug**: `kebab(name)-postcode` (e.g. `bondi-2026`) to disambiguate
  duplicate suburb names across postcodes. Resolved to a SAL code server-side.
- **Breadcrumb**: `Housing → NSW → Bondi`, on state + suburb levels.
- A search box (present on `/housing` and state pages) jumps straight to a
  suburb profile.
- The existing `/housing/suburbs` explorer route is **retired** — redirect to
  `/housing` (or repurpose as the all-AU suburb search entry).

"Top-level views drill down by state" is interpreted as: **both** the national
map regions **and** the capital-city tiles on `/housing` become clickable
drill-in affordances to `/housing/[state]`.

## 6. Map engine — shared `<ChoroplethMap>`

A single reusable component (mirrors the repo's shared `StockChart` core
pattern):

```ts
interface ChoroplethMapProps<F> {
  topology: Topology;            // TopoJSON
  objectName: string;           // object key within the topology
  valueAccessor: (id: string) => number | null;  // null → "no data" hatch
  colorScale: (v: number) => string;
  selectedId?: string;
  onFeatureClick: (id: string) => void;
  onFeatureHover: (id: string | null, evt?: PointerEvent) => void;
}
```

- **Projection**: `geoMercator` (or `geoConicConformal` tuned for AU) fit to the
  topology bounds via `projection.fitSize`.
- **Zoom/pan**: `d3-zoom` bound to the SVG, `scaleExtent([1, 12])`, applied as an
  SVG `transform` on the feature group; supports wheel, drag, **touch pinch**.
  Programmatic `zoomTo(featureBounds)` on selection.
- **Color**: sequential scale over median price; suburbs without price data get a
  neutral hatched fill and remain hoverable (demographics still show).
- **SSR**: wrapped by a `*-loader.tsx` using `dynamic(() => import(...), { ssr:false })`.
- Used at national level (8 state features) and state level (per-state suburb
  features) with different topology + accessors.

## 7. Geo data pipeline

Real boundaries from **ABS ASGS Edition 3 (2021)**, CC-BY 4.0:

- **States (STE 2021)** → `web/public/geo/states.topojson` (8 features; small).
- **Suburbs (SAL 2021)** → `web/public/geo/suburbs/{NSW,VIC,QLD,SA,WA,TAS,NT,ACT}.topojson`,
  **one file per state**, lazy-loaded on drilldown so we never ship ~15k
  polygons at once.
- Each suburb feature's `id` = **ABS SAL code** (the universal join key).

**Build script:** `web/scripts/geo/build-boundaries.mjs` (committed; outputs
committed). Uses `mapshaper` (or `topojson-server` + `topojson-simplify`) to:
1. Download ABS ASGS STE + SAL boundary files (documented source URLs).
2. Simplify (Douglas–Peucker) + quantize aggressively (target: states file
   < ~80 KB; each per-state suburb file ideally < ~1 MB).
3. Split SAL by state, write TopoJSON with SAL code as feature id and name +
   postcode in properties.

Static `public/` assets are CDN-gzipped/brotli'd; per-state files are fetched
once on entry to a state and React-Query cached.

## 8. Demographics data (ABS Census 2021)

**New collector mode:** `house-price-collector -mode census` (`census.go`).
Downloads the SAL-level **General Community Profile (GCP) DataPack**, parses the
curated columns, upserts into `suburb_demographics` keyed by SAL code.

Curated fields (v1):
- `population` (Tot_P_P)
- `median_age`
- `median_weekly_household_income`
- `median_weekly_personal_income`
- `median_weekly_rent`
- `median_monthly_mortgage`
- tenure mix: `pct_owned_outright`, `pct_owned_mortgage`, `pct_rented`
- `dwelling_count`

Census is 5-yearly → this is a **re-runnable backfill**, not a daily job (run
manually / one-off Cloud Run Job execution, not on the daily scheduler).

**Join bridge:** existing price regions use `region_code` like
`SUBURB:VIC-RICHMOND-3121`. A `region_code ↔ sal_code` mapping is built during
ingestion by normalizing (state, name, postcode) → SAL. Unmatched rows degrade
gracefully (price-only or demographics-only). The mapping is persisted (column
on `house_price_regions` or a small mapping table).

## 9. Data model / migrations

New migration `000054_add_suburb_demographics` (number TBD at implementation
time — must be the next free index):

```sql
CREATE TABLE suburb_demographics (
  sal_code       TEXT PRIMARY KEY,         -- ABS SAL 2021 code
  sal_name       TEXT NOT NULL,
  state_code     TEXT NOT NULL,
  postcode       TEXT,
  population               INTEGER,
  median_age               NUMERIC,
  median_weekly_hhd_income NUMERIC,
  median_weekly_per_income NUMERIC,
  median_weekly_rent       NUMERIC,
  median_monthly_mortgage  NUMERIC,
  pct_owned_outright       NUMERIC,
  pct_owned_mortgage       NUMERIC,
  pct_rented               NUMERIC,
  dwelling_count           INTEGER,
  census_year              INTEGER DEFAULT 2021,
  source                   TEXT DEFAULT 'abs_census_2021_gcp',
  source_licence           TEXT DEFAULT 'CC-BY-4.0',
  fetched_at               TIMESTAMPTZ DEFAULT now()
);

ALTER TABLE house_price_regions ADD COLUMN sal_code TEXT;  -- join bridge
CREATE INDEX idx_house_price_regions_sal ON house_price_regions(sal_code);
```

(Replaces the `fix/housing-suburb-explorer` stub table.)

## 10. API / proto

`proto/shortedapi/shorts/v1alpha1/shorts.proto`:

- **Port + extend `ListHousingRegions`** — add inline demographics so the map +
  hover tooltip need no per-hover round-trip:
  ```proto
  message HousingRegion {
    string region_code = 1;
    string region_name = 2;
    string region_type = 3;
    string state_code  = 4;
    string postcode    = 5;
    double latest_value = 6;            // latest median price
    google.protobuf.Timestamp latest_period = 7;
    string sal_code = 8;               // join key / map feature id
    int32  population = 9;
    double median_age = 10;
    double median_weekly_hhd_income = 11;
    double yoy_pct = 12;
  }
  ```
- **Add `GetSuburbProfile`**:
  ```proto
  rpc GetSuburbProfile(GetSuburbProfileRequest) returns (GetSuburbProfileResponse);
  message GetSuburbProfileRequest { string sal_code = 1; }  // or state+slug
  message GetSuburbProfileResponse {
    HousingRegion region = 1;          // identity + headline + demographics
    SuburbDemographics demographics = 2;  // full set
    ComparisonBaselines baselines = 3; // state + national medians for compare bars
  }
  ```
  Price **series** for the profile chart continues to use the existing
  `GetHousePriceSeries`.

Go: handler in `services/shorts/internal/services/shorts/house_prices.go`,
store query in `postgres_house_prices.go` (join `house_price_regions` +
`suburb_demographics` + latest from `mv_housing_headline`). Cache keys added to
the existing cache helper.

## 11. Frontend components

`web/src/@/components/housing/`:

| Component | Role |
|---|---|
| `choropleth-map.tsx` | Shared d3-geo + d3-zoom SVG map core (new). |
| `choropleth-map-loader.tsx` | `ssr:false` dynamic wrapper. |
| `use-topojson.ts` | Hook: lazy-fetch + cache a TopoJSON file (states / per-state). |
| `suburb-tooltip.tsx` | Rich hover tooltip: stats block + lazy sparkline. |
| `housing-breadcrumb.tsx` | `Housing → State → Suburb`. |
| `state-map-view.tsx` | State page: suburb choropleth + list + search. |
| `national-map-view.tsx` | National states choropleth on `/housing`. |
| `suburb-profile.tsx` | Per-suburb profile (stats + charts + comparison). |
| `suburb-search.tsx` | Typeahead jumping to a suburb profile. |

Reuse: `housing-series-chart.tsx` (price history + sparkline), `housing-tiles.tsx`
(made clickable → state). Port `suburb-explorer.tsx`'s list/search shell but
swap its map for `<ChoroplethMap>`.

Pages: `web/src/app/housing/page.tsx` (add national map),
`web/src/app/housing/[state]/page.tsx` (new),
`web/src/app/housing/[state]/[suburb]/page.tsx` (new).

Actions: port `listHousingRegionsClient`; add `getSuburbProfileClient` (client)
and `getSuburbProfile` (server, `cache()` + `withRetryAndNotFound()`), following
the established server/client action split.

## 12. Per-suburb profile (`/housing/[state]/[suburb]`)

- **Header**: suburb name, state, postcode, latest median house price, QoQ/YoY.
- **Price history**: `HousingSeriesChart` (median_price, established_house +
  attached where present).
- **Demographics card**: population, median age, median weekly household &
  personal income, median rent, median mortgage, tenure mix bars.
- **Comparison**: suburb vs state vs national bars (price + income).
- **Locator**: mini state map highlighting the suburb.
- **Deferred slot**: rental yield / days-on-market (crawl, later) — rendered as
  "coming soon" placeholder, not fabricated.

## 13. SEO

- Per-suburb + per-state pages added to `web/src/app/sitemap.ts`.
- `LLMMeta` / structured data on suburb pages (Place / Dataset where apt).
- Canonical URLs, OG/twitter images, server-rendered stat fallbacks for
  crawlers (consistent with the repo's SEO patterns). Suburb pages are a large
  new indexable surface — generate from the region set with the existing
  indexability gates.

## 14. Build phases

1. **Geo pipeline** — `build-boundaries.mjs`, committed TopoJSON (states +
   per-state), `use-topojson.ts`, shared `ChoroplethMap` + loader with
   pinch-zoom; national states map visible on `/housing`, clicking a state
   navigates (state page can stub first).
2. **Census demographics** — migration, collector `census` mode, SAL keying +
   `region_code ↔ sal_code` mapping, backfill run.
3. **API** — port/extend `ListHousingRegions`, add `GetSuburbProfile`, store
   queries, cache keys, client/server actions.
4. **Routes & UX** — `/housing/[state]` + `/housing/[state]/[suburb]`,
   breadcrumbs, rich tooltip (stats + sparkline), suburb profile page, clickable
   capital tiles, search typeahead.
5. **Polish** — SSR safety audit, sitemap/LLM-meta for new pages, retire
   `/housing/suburbs`, tests, verify in the running app via the production path.

## 15. Risks & decisions

- **SAL file sizes**: NSW/VIC have many suburbs; aggressive simplification +
  quantization required. Mitigation: per-state lazy load + a size budget in the
  build script (warn/fail if a file exceeds threshold).
- **Name/postcode → SAL matching**: imperfect; some Valuer-General suburbs won't
  map. Mitigation: graceful degradation + a logged unmatched report; SAL stays
  the demographic source of truth regardless.
- **SSR / Connect-RPC**: all map + Connect-importing components must be
  `dynamic({ssr:false})` (known repo failure mode). Verify in running app.
- **Census DataPack ingestion**: large ZIP/CSV; ingester must stream/parse only
  needed columns. One-off backfill, not on the daily scheduler (cost guardrails:
  no new always-on instances; min_instance_count stays 0).
- **Concurrent worktrees**: `fix/housing-suburb-explorer` and
  `feat/residential-housing-crawl` are separate worktrees possibly under active
  sessions — we do **not** edit them; we port files by reading from those refs.

## 16. Testing & verification

- Unit: geo build output shape, SAL-matching normalizer, store queries, slug
  resolution.
- Component/interaction: map click → navigation, tooltip content, zoom clamp.
- E2E (Playwright): national → state → suburb drilldown + breadcrumb + a
  pinch/zoom gesture; screenshots before/after.
- Full-stack verification through the **production render path** (not just unit
  tests / DB), with the LISTEN-pid check before trusting any running-app result.
