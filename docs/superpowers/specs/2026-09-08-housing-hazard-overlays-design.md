# Housing map uplift: hazard overlays, terrain insights, columnar exploration

Date: 2026-09-08. Status: design, being implemented on `feat/housing-hazard-overlays`.

## What this is

Three things the suburb map and suburb pages cannot do today, and the data
that makes them possible:

1. **Overlays** — a second visual layer drawn on top of the choropleth, toggled
   independently of "Colour by": flood planning areas, land observed under
   water by satellite, bushfire-prone land. Today `ChoroplethMap` has one fill
   per feature and no layer concept at all.
2. **Terrain and hazard exposure per suburb** — the elevation pipeline already
   populates six columns for 15,307 suburbs and returns them on
   `GetSuburbProfile`, but nothing renders them. This adds measured
   flood-planning / observed-water / bushfire land shares beside them, and a
   card on the suburb page plus rows on the map tooltip.
3. **Columnar metric delivery on the web** — `GetSuburbIndex`,
   `GetSuburbMetricColumns` and `FilterSuburbs` are built server-side (#505)
   and have zero web callers. The map still pulls a 3.6 MB `ListStateSuburbs`
   payload for NSW to colour one number. New metrics go through the columnar
   path, and "Colour by" + overlays sync to the URL so a view is shareable.

## What was extracted before, and how this pushes it further

The prior round downloaded the Geoscience Australia 1-second DEM-S (36.5 GB
GeoTIFF on `/Volumes/gamma-systems-2/shorted-dem/`) and ran per-SAL zonal
statistics through `web/scripts/geo/ga_dem_zonal_stats.py` (elevation min /
median / max, land share below 1 / 2 / 5 m). That rig — a raster, the committed
SAL TopoJSON, area-weighted zonal stats per suburb, a JSON artifact, a
collector `-mode` that loads it — is reused here for a second national raster
and extended with vector overlay shares.

## Sources (verified 2026-09-08, all CC-BY-4.0)

| Layer | Source | Coverage | Access |
|---|---|---|---|
| `water_observed` | DEA Water Observations Statistics, multi-year frequency `ga_ls_wo_fq_myear_3` v2.1.0 (1987–2025, Landsat, 30 m) | national | `s3://dea-public-data/derivative/ga_ls_wo_fq_myear_3/2-1-0/` — 1,037 COG tiles, 17 GB, anonymous read |
| `flood_planning` | NSW Environmental Planning Instrument — Flood (`Planning/Hazard` MapServer layer 1, 622 polygons); VIC Vicmap Planning overlays `LSIO`/`FO`/`SBO` (WFS `open-data-platform:plan_overlay`, 23,560 polygons across the four hazard codes) | NSW, VIC | ArcGIS REST geoJSON paging (1,000/req); WFS GeoJSON paging |
| `bushfire_prone` | NSW Bush Fire Prone Land (`Hosted/NSW_BushFire_Prone_Land` FeatureServer); VIC Bushfire Management Overlay `BMO` | NSW, VIC | as above |

Ruled out this round, recorded in `data-sources.md`: the insurer-only NFID;
QLD's statewide flood services (`FloodCheck/BasinOnePercentAEP` is a raster
map-index footprint, not a flood extent; QFAO is a 2013 interim product behind
a custom-order download); per-council flood studies (hundreds of portals);
any commercial risk score. QLD, WA, SA, TAS, NT and ACT get the national
observed-water layer only, and the UI says so.

### What the numbers mean, and the words that go with them

- `water_observed_share_pct` — share of a suburb's land where Landsat saw
  surface water in **at least 1% of clear observations since 1987**, excluding
  cells that are water in ≥ 90% of observations (those are lakes, rivers, the
  sea: `permanent_water_share_pct`). The 8–16 day revisit under-observes flood
  peaks, so this is a floor on inundation, never a risk estimate. Copy:
  "observed under water", never "flood risk".
- `flood_planning_share_pct` — share of land inside a statutory flood planning
  overlay. It is a planning-control boundary, council-owned since July 2021 in
  NSW, and may lag the latest flood study. Copy names the instrument.
- `bushfire_prone_share_pct` — share of land designated bushfire prone for
  development-control purposes.

All three are area shares in [0, 100] computed in GDA2020 Australian Albers
(EPSG:3577), NULL when the source does not cover the state or the suburb has
no usable cells. A genuine 0 is stored as 0. Nothing here models hydrology,
and the existing `SuburbElevation` disclaimer is kept.

## Architecture

### Offline pipeline (`web/scripts/geo/hazards/`)

Runs on the external volume, outputs committed artifacts. Every step is
idempotent and per-state so a failure isolates.

1. `fetch-nsw-flood-planning.mjs`, `fetch-nsw-bushfire.mjs`,
   `fetch-vic-overlays.mjs` — page the services into
   `/Volumes/gamma-systems-2/shorted-hazards/vector/<layer>-<STATE>.geojson`.
   Sends the `shorted-housing/1.0` UA; refuses to write a partial page set.
2. `wofs_zonal_stats.py` — builds a VRT over the synced frequency tiles, then
   per state computes the two water shares per SAL with the same
   area-weighted, nodata-excluded, ≥ 25 valid cells rule as the DEM script.
3. `vector_share.py` — for each vector layer, dissolves to one geometry per
   state, intersects with SAL polygons in EPSG:3577, writes share per SAL.
4. `merge-hazards.py` — merges into
   `web/public/geo/insights/suburb-hazards.json`, keyed by `sal_code`:
   `{waterObservedSharePct, permanentWaterSharePct, floodPlanningSharePct,
   bushfireProneSharePct, sampledCellCount, sources:{...}}`. Missing layer =
   `null`. Refuses a partial state set.
5. `build-overlays.mjs` — mapshaper simplification of each vector layer and a
   polygonised, downsampled (120 m) ≥ 5% water-frequency mask into
   `web/public/geo/hazards/<STATE>-<layer>.topojson`, budgeted ≤ 600 KB per
   file, quantized, with `source`/`asOf` in the topology's `properties`.

### Database (`000118_add_suburb_hazard_exposure`)

New table rather than more `suburb_demographics` columns — it has its own
provenance and refresh cadence:

```sql
suburb_hazard_exposure (
  sal_code TEXT PRIMARY KEY REFERENCES suburb_demographics(sal_code),
  water_observed_share_pct DOUBLE PRECISION,
  permanent_water_share_pct DOUBLE PRECISION,
  flood_planning_share_pct DOUBLE PRECISION,
  bushfire_prone_share_pct DOUBLE PRECISION,
  water_source TEXT, flood_source TEXT, bushfire_source TEXT,
  source_licence TEXT NOT NULL DEFAULT 'CC-BY-4.0',
  computed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK bounds 0..100 on every share
)
```

Replay-safe (`IF NOT EXISTS` everywhere) so it can sit on the deploy
allowlist; hand-applied to prod on the session pooler first, recorded in
`PROD_APPLIED.md`.

### Collector `-mode hazards`

`services/house-price-collector/hazards.go` mirrors `elevation.go`: load the
artifact, validate bounds and the cell floor, upsert in batches, exit non-zero
on failure through `ingestExit`. Operator-run, not in `-mode all`.

### API

- `SuburbHazardExposure` message, `GetSuburbProfileResponse.hazards = 10`,
  reflection-mapped like elevation.
- Metric registry gains `water_observed_share_pct`, `permanent_water_share_pct`,
  `flood_planning_share_pct`, `bushfire_prone_share_pct` via a new
  `suburbMetricJoinHazards` LEFT JOIN. Keys stay a closed registry.
- No new RPC, so no legacy `ShortedStocksService` dual-add.

### Web

- `lib/housing/suburb-columns.ts` — client for `GetSuburbIndex` +
  `GetSuburbMetricColumns` decoding packed floats and the LSB-first null mask
  into `Map<sal_code, number|null>`; react-query keyed by
  `[state, metric, index_version]`. A `ColumnMetric` variant in
  `highlight-metrics.ts` (`source: "column"`) means the map fetches ~18 KB for
  that metric instead of reading `SuburbDatum`. First column metrics:
  `elevation_median_m`, `land_share_below_5m`, the four hazard shares.
- `lib/housing/overlays.ts` — closed registry of overlay layers: id, label,
  which states have an asset, fill/pattern, legend swatch, source line, caveat.
- `ChoroplethMap` gains `overlays?: OverlayLayer[]` rendered in a second
  `<g>` above the choropleth (pointer-events none, shares the zoom transform)
  using per-layer SVG patterns so overlays remain legible over any colour ramp.
- `state-suburb-map.tsx` gains an "Overlays" popover (checkbox per available
  layer, greyed with "not available for QLD" when absent) and syncs
  `?metric=` and `?overlays=` to the URL the way `economy-map-explorer.tsx`
  syncs its metric.
- Tooltip gains a "Terrain & hazards" block from the column data when the
  relevant metric or overlay is active.
- Suburb page gains a **Terrain & hazard exposure** card after SEIFA:
  elevation range, land below 5 m, the three shares with per-source caveats,
  and a locator inset that draws the active overlays.

### Testing

- Pipeline: pure-function tests for the share and threshold rules (Python), and
  a Node test that every committed overlay TopoJSON is under budget and carries
  `source`/`asOf`.
- Migration: `suburb_hazard_exposure.test.mjs` — replay safety and bounds.
- Go: loader validation, registry expression coverage
  (`suburb_columns_proto_source_test.go` pattern), profile mapping.
- Web: null-mask decoding, overlay registry availability, URL sync, the card
  with and without data, visual story for the overlay patterns.
- Verification through the RPC and in the running app, as the housing skill
  requires; ACT must show 0% water and no flood-planning layer.
