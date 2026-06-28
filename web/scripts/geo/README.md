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

## Attributes used
- STE: `STE_CODE21`, `STE_NAME21`
- SAL: `SAL_CODE21`, `SAL_NAME21`, `STE_NAME21`, `STE_CODE21`
