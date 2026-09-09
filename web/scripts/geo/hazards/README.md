# Hazard exposure build

Produces two committed artifacts from three open sources, all CC-BY-4.0:

- `web/public/geo/insights/suburb-hazards.json` — per-SAL area shares, loaded by
  `house-price-collector -mode hazards` into `suburb_hazard_exposure` (000122).
- `web/public/geo/hazards/<STATE>-<layer>.topojson` — the drawable overlays
  (`flood_planning`, `water_observed`, `bushfire_prone`), ≤ 600 KB each.

Wording rules for anything derived from these live in
`docs/feature/housing/data-sources.md` ("Hazard layers — what the words mean").
The short version: the satellite layer is **observed** water, never flood risk;
statutory layers are planning-control boundaries, not flood extents; and a
state with no source is NULL, not zero.

Everything heavy runs on the external volume (`/Volumes/gamma-systems-2/
shorted-hazards/`) with the DEM pipeline's venv
(`/Volumes/gamma-systems-2/shorted-dem/venv`: rasterio, geopandas, shapely,
pyproj). Every step is idempotent and per-state.

## 1. Sources

```bash
H=/Volumes/gamma-systems-2/shorted-hazards

# DEA Water Observations, multi-year frequency v2.1.0 — 1,037 COG tiles, 17 GB
aws s3 sync --no-sign-request --exclude "*" --include "*_final_frequency.tif" \
  s3://dea-public-data/derivative/ga_ls_wo_fq_myear_3/2-1-0/ $H/wofs/

# Statutory layers → newline-delimited GeoJSON pages (+ a .done marker)
node fetch-layer.mjs --kind arcgis --name nsw-flood --out $H/vector --page 100 --orderBy OBJECTID \
  --url "https://mapprod3.environment.nsw.gov.au/arcgis/rest/services/Planning/Hazard/MapServer/1/query" \
  --where "LAY_CLASS IN ('Flood Planning Area','Flood Prone and Major Creeks Land','1 in 100 AEP Flood Extent')" \
  --fields "OBJECTID,EPI_NAME,LGA_NAME,LAY_CLASS,EPI_TYPE,CURRENCY_DATE"
node fetch-layer.mjs --kind arcgis --name nsw-bushfire --out $H/vector --page 2000 --orderBy fid \
  --url "https://portal.spatial.nsw.gov.au/server/rest/services/Hosted/NSW_BushFire_Prone_Land/FeatureServer/0/query" \
  --fields "fid,category,d_category,guideline"
node fetch-layer.mjs --kind wfs --name vic-flood --out $H/vector --page 2000 \
  --url "https://opendata.maps.vic.gov.au/geoserver/wfs" --type open-data-platform:plan_overlay \
  --cql "(zone_code LIKE 'LSIO%' OR zone_code LIKE 'FO%' OR zone_code LIKE 'SBO%') AND zone_status='g'"
node fetch-layer.mjs --kind wfs --name vic-bushfire --out $H/vector --page 2000 \
  --url "https://opendata.maps.vic.gov.au/geoserver/wfs" --type open-data-platform:plan_overlay \
  --cql "zone_code LIKE 'BMO%' AND zone_status='g'"
```

The fetcher is resumable at page granularity and refuses to write the `.done`
marker unless the count matches; `vector_share.py` refuses a directory without
it. NSW's `Planning/Hazard` layer mixes classes — the `where` keeps the three
flood classes and drops the probable-maximum-flood lines and a handful of
misfiled heritage polygons. VIC `zone_status='g'` is gazetted; `p` (proposed)
has no rows today but would be wrong to include.

## 2. Shares

```bash
PY=/Volumes/gamma-systems-2/shorted-dem/venv/bin/python
SUB=web/public/geo/suburbs

$PY wofs_vrt.py --tiles $H/wofs --out $H/wofs.vrt
for st in ACT NT TAS SA WA VIC QLD NSW; do
  mkdir -p $H/statedirs/$st && cp $SUB/$st.topojson $H/statedirs/$st/
  $PY wofs_zonal_stats.py --vrt $H/wofs.vrt --suburbs-dir $H/statedirs/$st --out $H/out/wofs/$st.json
done
$PY vector_share.py --layer-dir $H/vector/nsw-flood    --suburbs $SUB/NSW.topojson --out $H/out/vector/nsw-flood.json
$PY vector_share.py --layer-dir $H/vector/nsw-bushfire --suburbs $SUB/NSW.topojson --out $H/out/vector/nsw-bushfire.json
$PY vector_share.py --layer-dir $H/vector/vic-flood    --suburbs $SUB/VIC.topojson --out $H/out/vector/vic-flood.json
$PY vector_share.py --layer-dir $H/vector/vic-bushfire --suburbs $SUB/VIC.topojson --out $H/out/vector/vic-bushfire.json
$PY merge_hazards.py --wofs-dir $H/out/wofs --vector-dir $H/out/vector --out web/public/geo/insights/suburb-hazards.json
```

Thresholds and the quality floor are constants in `wofs_zonal_stats.py`
(`OBSERVED_MIN_FREQUENCY = 0.01`, `PERMANENT_MIN_FREQUENCY = 0.90`,
`MINIMUM_VALID_CELL_COUNT = 25`) and pinned by `test_hazards.py`. Suburb
polygons are read in row bands so the Coral Sea SAL does not need 8 GB. The
vector shares union the overlapping overlay polygons inside each suburb before
dividing, so a floodway inside a flood-planning area counts once. Every geometry
is snapped to 1 cm and repaired after projection — parcel-precision overlays
routinely self-touch in Albers and GEOS refuses to overlay them otherwise.

Ground-truth checks worth running on the merged artifact:

- ACT: `floodPlanningSharePct` and `bushfireProneSharePct` are `null` for all 136
  suburbs (no source), never 0.
- The "No usual address" pseudo-SALs and offshore islands report null water
  shares (below the cell floor), not 0.
- Lake suburbs (e.g. SAL for Lake Eildon / Lake Hume) show a large
  `permanentWaterSharePct` and a small observed share; the Hawkesbury floodplain
  suburbs show the reverse.

## 3. Overlays

```bash
$PY overlay_geometry.py vector --layer-dir $H/vector/nsw-flood --layer flood_planning --suburbs $SUB/NSW.topojson --out $H/overlays/NSW-flood_planning.geojson
# … likewise nsw-bushfire → NSW-bushfire_prone, vic-flood → VIC-flood_planning, vic-bushfire → VIC-bushfire_prone
for st in ACT NT TAS SA WA VIC QLD NSW; do
  $PY overlay_geometry.py wofs --vrt $H/wofs.vrt --suburbs $SUB/$st.topojson --out $H/overlays/$st-water_observed.geojson
done
node build-overlays.mjs $H/overlays
```

`build-overlays.mjs` quantizes each GeoJSON with mapshaper, lowers simplification
until the file is under `MAX_BYTES`, and stamps `source` / `licence` / `asOf`
onto the topology. The web registry (`web/src/@/lib/housing/overlays.ts`)
declares which states have which layer, and `overlays.test.ts` fails if the
committed files disagree with it in either direction.

`overlay_geometry.py vector --raster-m 60` is the path for NSW bushfire prone
land: a GEOS union of its 235,000 parcel polygons exhausts memory, so it is
burnt onto a 60 m grid over the state and polygonised instead. The satellite
overlays get `WATER_MAX_BYTES` (1.2 MB) rather than the 600 KB statutory budget
because a polygonised raster is speckle by nature and the file is fetched only
when the layer is toggled on.

## 4. Load and verify

```bash
cd services/house-price-collector
DATABASE_URL="${PROD/:6543/:5432}" PGOPTIONS="-c statement_timeout=0" \
CENSUS_GEO_DIR="$PWD/../../web/public/geo/suburbs" GOWORK=off go run . -mode hazards
```

Then verify through the RPC, not the table:

```bash
curl -sS -X POST -A "Mozilla/5.0" -H "Content-Type: application/json" \
  -d '{"stateCode":"ACT","metricKeys":["water_observed_share_pct","flood_planning_share_pct"]}' \
  https://api.shorted.com.au/shorts.v1alpha1.HousingService/GetSuburbMetricColumns
```

ACT's `flood_planning_share_pct` null mask must be all ones.
