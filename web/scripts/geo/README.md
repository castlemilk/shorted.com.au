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
