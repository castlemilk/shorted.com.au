# AU boundary build

Generates the TopoJSON the housing map renders, from ABS ASGS Edition 3 (2021),
CC-BY 4.0.

## Inputs (download once into `web/scripts/geo/src/`, gitignored)

From the ABS ASGS Edition 3 "Digital boundary files" page:
- "States and Territories - 2021 - Shapefile" → unzip → `src/STE_2021_AUST_GDA2020.shp` (+ siblings)
- "Suburbs and Localities - 2021 - Shapefile" → unzip → `src/SAL_2021_AUST_GDA2020.shp` (+ siblings)

## Build

    node web/scripts/geo/build-boundaries.mjs

Outputs committed TopoJSON to `web/public/geo/`. Re-run only when ABS releases a
new edition (rare).

## GA national elevation artifact

`ga_dem_zonal_stats.py` clips Geoscience Australia's **SRTM-derived 1 Second
Digital Elevation Model Version 1.0 (DEM-S)** to the committed SAL boundaries
and writes `web/public/geo/insights/suburb-elevation.json`, keyed by `sal_code`.
The dataset is © Commonwealth of Australia (Geoscience Australia), CC-BY-4.0,
and is obtained through [ELVIS](https://elevation.fsdf.org.au/). A national
1-second raster is approximately 40 GB uncompressed; ELVIS compressed/tiled
export size varies by format and extent.

DEM-S elevations are orthometric metres relative to the EGM96 geoid. They are
not AHD or ellipsoidal heights. Mosaic the real DEM-S tiles into one GeoTIFF,
install `numpy rasterio geopandas pyproj`, then run from the repository root:

    python3 web/scripts/geo/ga_dem_zonal_stats.py \
      --dem /absolute/path/to/DEM-S_1sec_GDA94_EGM96.tif \
      --suburbs-dir web/public/geo/suburbs \
      --out web/public/geo/insights/suburb-elevation.json

The script excludes DEM no-data cells from both sides of each share and emits
NULL metrics when fewer than 25 valid raster cells cover a suburb. It has not
been run in this repository; the committed artifact must be produced offline
with the real DEM before `house-price-collector -mode elevation` is used.

## Attributes used
- STE: `STE_CODE21`, `STE_NAME21`
- SAL: `SAL_CODE21`, `SAL_NAME21`, `STE_NAME21`, `STE_CODE21`

## Council (LGA) bridge

`join-lga-mb.py` writes `web/public/geo/insights/suburb-lga.json` (each
suburb's dominant council, its share, and every other council holding at least
1% of it) and `lga-facts.json` (council identity: name, display name, state
code, kind, area, Census 2021 dwellings, centroid). `house-price-collector -mode
lga` loads both.

It needs no geometry. SAL_2021 and LGA_2024 are both built from the same ASGS
2021 mesh blocks, so the bridge is the exact sum of each suburb's mesh blocks,
weighted by Census 2021 usual residents (dwellings, then area, when a suburb
has nobody living in it). It replaced a centroid-in-polygon join that put 224
suburbs in the wrong council and left 20 with none.

Inputs, all ABS CC BY 4.0, staged outside git (e.g.
`/Volumes/gamma-systems-2/shorted-council/abs/`):
- ASGS Ed.3 allocation files `SAL_2021_AUST.xlsx` and `LGA_2024_AUST.xlsx`
- Census 2021 `Mesh Block Counts, 2021.xlsx`
- `abs-lga.geojson` from `fetch-abs-lga.mjs` (only for centroids; optional)

    python3 -m pip install openpyxl
    python3 web/scripts/geo/join-lga-mb.py --staging /Volumes/gamma-systems-2/shorted-council/abs
    python3 -m unittest web/scripts/geo/test_join_lga_mb.py
    node --test web/scripts/geo/lga-bridge.test.mjs
