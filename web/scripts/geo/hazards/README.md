# Hazard exposure build

Produces two committed artifacts from open sources (CC BY 4.0, except SA's
Planning and Design Code and TAS's theLIST layers, CC BY 3.0 AU):

- `web/public/geo/insights/suburb-hazards.json` — per-SAL area shares, loaded by
  `house-price-collector -mode hazards` into `suburb_hazard_exposure` (000122).
- `web/public/geo/hazards/<STATE>-<layer>.topojson` — the drawable overlays
  (`flood_planning`, `water_observed`, `bushfire_prone`), ≤ 600 KB each.

Wording rules for anything derived from these live in
`docs/feature/housing/data-sources.md` ("Hazard layers — what the words mean").
The short version: the satellite layer is **observed** water, never flood risk;
statutory layers are planning-control boundaries, not flood extents (ACT flood,
a modelled extent, is the labelled exception); and a suburb no source covers is
NULL, not zero — per state AND, through the coverage masks below, per suburb.

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
# NSW flood coverage mask: the Land Application boundary of every instrument in nsw-flood
node fetch-layer.mjs --kind arcgis --name nsw-flood-epi-application --out $H/vector --page 20 --orderBy OBJECTID \
  --url "https://mapprod3.environment.nsw.gov.au/arcgis/rest/services/Planning/EPI_Primary_Planning_Layers/MapServer/6/query" \
  --where "EPI_NAME IN (<the 12 distinct EPI_NAMEs in vector/nsw-flood>)" --fields "OBJECTID,EPI_NAME"
# VIC bushfire: the Building Regulations designation (like-for-like with NSW BFPL), not the BMO
node fetch-layer.mjs --kind wfs --name vic-bpa --out $H/vector --page 2000 --sortBy lga_code \
  --url "https://opendata.maps.vic.gov.au/geoserver/wfs" --type open-data-platform:bushfire_prone_area
# SA: one 872 MB bulk shapefile — download once, then stage filtered slices locally
curl -A "shorted-housing/1.0 (+https://shorted.com.au)" -o $H/raw/sa-pdcode/PDCodeOverlays_shp.zip \
  https://www.dptiapps.com.au/dataportal/PDCodeOverlays_shp.zip && unzip -d $H/raw/sa-pdcode $H/raw/sa-pdcode/PDCodeOverlays_shp.zip
SHP=$H/raw/sa-pdcode/PDCodeOverlays_GDA2020.shp
$PY extract_layer.py --src $SHP --out $H/vector --name sa-flood --fields id,name,value,legalstart \
  --where "name IN ('Hazards (Flooding)','Hazards (Flooding - General)')"
$PY extract_layer.py --src $SHP --out $H/vector --name sa-flood-unassessed --fields id,name \
  --where "name = 'Hazards (Flooding - Evidence Required)'"
$PY extract_layer.py --src $SHP --out $H/vector --name sa-bushfire --fields id,name,value,legalstart \
  --where "name IN ('Hazards (Bushfire - High Risk)','Hazards (Bushfire - Medium Risk)','Hazards (Bushfire - General)','Hazards (Bushfire - Urban Interface)')"
$PY extract_layer.py --src $SHP --out $H/vector --name sa-bushfire-unassessed --fields id,name \
  --where "name IN ('Hazards (Bushfire - Regional)','Hazards (Bushfire - Outback)')"
# TAS: Tasmanian Planning Scheme code overlays + council boundaries as coverage masks
TAS=https://services.thelist.tas.gov.au/arcgis/rest/services/Public/PlanningOnline/MapServer
node fetch-layer.mjs --kind arcgis --name tas-flood --out $H/vector --page 2000 --orderBy OBJECTID \
  --url "$TAS/14/query" --where "CODE='Flood-prone Hazard Areas Code'" --fields "OBJECTID,LPS,OV_NAME,LPSDATE"
node fetch-layer.mjs --kind arcgis --name tas-bushfire --out $H/vector --page 25 --orderBy OBJECTID \
  --url "$TAS/14/query" --where "CODE='Bushfire-prone Areas Code'" --fields "OBJECTID,LPS,OV_NAME,LPSDATE"
node fetch-layer.mjs --kind arcgis --name tas-lps-flood-mapped --out $H/vector --page 1 --orderBy OBJECTID \
  --url "$TAS/8/query" --where "NAME IN (<the 21 councils whose LPS appears in tas-flood>)" \
  --fields "OBJECTID,NAME" --extra "maxAllowableOffset=0.00005"
node fetch-layer.mjs --kind arcgis --name tas-lps-in-effect --out $H/vector --page 1 --orderBy OBJECTID \
  --url "$TAS/8/query" --where "NAME <> 'Kingborough'" --fields "OBJECTID,NAME" --extra "maxAllowableOffset=0.00005"
# QLD: 2.56M polygons; offset paging dies past ~1M rows, so page by fid window
node fetch-layer.mjs --kind arcgis --name qld-bushfire --out $H/vector --page 2000 --rangeField fid --fields class \
  --url "https://utility.arcgis.com/usrsvcs/servers/3ec80e95fa084ef9901205df0a7a74ec/rest/services/Hosted/BPA/FeatureServer/0/query" \
  --extra "maxAllowableOffset=0.0001&geometryPrecision=5"
node fetch-layer.mjs --kind arcgis --name wa-bushfire --out $H/vector --page 5 --orderBy objectid \
  --url "https://public-services.slip.wa.gov.au/public/rest/services/SLIP_Public_Services/Bush_Fire_Prone_Areas/MapServer/23/query"
ACT=https://services1.arcgis.com/E5n4f1VY84i0xSjy/arcgis/rest/services
node fetch-layer.mjs --kind arcgis --name act-bushfire --out $H/vector --page 5 \
  --url "$ACT/Bushfire_Prone_Area_Overview_2026/FeatureServer/0/query"
node fetch-layer.mjs --kind arcgis --name act-flood --out $H/vector --page 1 --fields OBJECTID \
  --url "$ACT/ACTGOV_FLOOD_EXTENT/FeatureServer/0/query"
```

The fetcher is resumable at page granularity and refuses to write the `.done`
marker unless the count matches; `vector_share.py` refuses a directory without
it. NSW's `Planning/Hazard` layer mixes classes — the `where` keeps the three
flood classes and drops the probable-maximum-flood lines and a handful of
misfiled heritage polygons. VIC `zone_status='g'` is gazetted; `p` (proposed)
has no rows today but would be wrong to include. `extract_layer.py` writes the
same page set + `.done` contract from a local bulk file, recording the file and
filter in the marker, so nothing downstream can tell the two apart.

## 2. Shares

```bash
PY=/Volumes/gamma-systems-2/shorted-dem/venv/bin/python
SUB=web/public/geo/suburbs

$PY wofs_vrt.py --tiles $H/wofs --out $H/wofs.vrt
for st in ACT NT TAS SA WA VIC QLD NSW; do
  mkdir -p $H/statedirs/$st && cp $SUB/$st.topojson $H/statedirs/$st/
  $PY wofs_zonal_stats.py --vrt $H/wofs.vrt --suburbs-dir $H/statedirs/$st --out $H/out/wofs/$st.json
done
V=$H/vector; O=$H/out/vector; C=$H/out/coverage   # C must NOT be the merge's --vector-dir
$PY vector_share.py --layer-dir $V/nsw-flood    --suburbs $SUB/NSW.topojson --out $O/nsw-flood.json \
  --coverage-dir $V/nsw-flood-epi-application --coverage-out $C/nsw-flood.json
$PY vector_share.py --layer-dir $V/nsw-bushfire --suburbs $SUB/NSW.topojson --out $O/nsw-bushfire.json
$PY vector_share.py --layer-dir $V/vic-flood    --suburbs $SUB/VIC.topojson --out $O/vic-flood.json
$PY vector_share.py --layer-dir $V/vic-bpa      --suburbs $SUB/VIC.topojson --out $O/vic-bushfire.json
$PY vector_share.py --layer-dir $V/sa-flood     --suburbs $SUB/SA.topojson  --out $O/sa-flood.json \
  --unassessed-dir $V/sa-flood-unassessed --coverage-out $C/sa-flood.json
$PY vector_share.py --layer-dir $V/sa-bushfire  --suburbs $SUB/SA.topojson  --out $O/sa-bushfire.json \
  --unassessed-dir $V/sa-bushfire-unassessed --coverage-out $C/sa-bushfire.json
$PY vector_share.py --layer-dir $V/tas-flood    --suburbs $SUB/TAS.topojson --out $O/tas-flood.json \
  --coverage-dir $V/tas-lps-flood-mapped --coverage-out $C/tas-flood.json
$PY vector_share.py --layer-dir $V/tas-bushfire --suburbs $SUB/TAS.topojson --out $O/tas-bushfire.json \
  --coverage-dir $V/tas-lps-in-effect --coverage-out $C/tas-bushfire.json
$PY vector_share.py --layer-dir $V/act-flood    --suburbs $SUB/ACT.topojson --out $O/act-flood.json \
  --coverage-hull --coverage-out $C/act-flood.json
$PY vector_share.py --layer-dir $V/act-bushfire --suburbs $SUB/ACT.topojson --out $O/act-bushfire.json
$PY vector_share.py --layer-dir $V/wa-bushfire  --suburbs $SUB/WA.topojson  --out $O/wa-bushfire.json
$PY vector_share.py --layer-dir $V/qld-bushfire --suburbs $SUB/QLD.topojson --out $O/qld-bushfire.json --raster-m 30
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

**Coverage masks** (see data-sources.md for the per-state table): a suburb
outside `--coverage-dir`, or wholly inside `--unassessed-dir`, is `null`; one
less than 10% covered is `null`; a partly covered one is the share of its
covered land, and `--coverage-out` records that denominator. `--coverage-hull`
uses the layer's own convex hull, for a modelled extent published without its
study area (ACT flood). Run one state at a time with `GDAL_CACHEMAX=512`: the
SA flood share peaks at ~3.7 GB RSS (150,000 parcel polygons plus a 119,000-
polygon unassessed mask).

**QLD bushfire uses `--raster-m 30`**: 2.56 million polygonised-raster
fragments do not fit a per-suburb GEOS union in memory, so the pages are
streamed onto a 30 m grid (4 GB for QLD) in 100,000-geometry batches and each
suburb reads its share of burnt cells (every touched cell for a suburb under 25
cells). Measured 2026-09-24: 12 minutes, 10 GB peak RSS.

Ground-truth checks worth running on the merged artifact:

- NT: `floodPlanningSharePct` and `bushfireProneSharePct` are `null` for every
  suburb (no source), never 0; QLD and WA flood likewise.
- NSW flood: Lismore, Windsor, Maitland, Kempsey and Ballina are `null` (no
  lodged map), Grafton, Tamworth and Bathurst carry shares.
- The "No usual address" pseudo-SALs and offshore islands report null water
  shares (below the cell floor), not 0.
- Lake suburbs (e.g. SAL for Lake Eildon / Lake Hume) show a large
  `permanentWaterSharePct` and a small observed share; the Hawkesbury floodplain
  suburbs show the reverse.

## 3. Overlays

```bash
$PY overlay_geometry.py vector --layer-dir $H/vector/nsw-flood --layer flood_planning --suburbs $SUB/NSW.topojson --out $H/overlays/NSW-flood_planning.geojson
# … likewise for every <st>-flood / <st>-bushfire layer above (VIC bushfire from vic-bpa);
# the raster path for the parcel-scale or statewide ones:
$PY overlay_geometry.py vector --layer-dir $H/vector/nsw-bushfire --layer bushfire_prone --suburbs $SUB/NSW.topojson --out $H/overlays/NSW-bushfire_prone.geojson --raster-m 60
$PY overlay_geometry.py vector --layer-dir $H/vector/qld-bushfire --layer bushfire_prone --suburbs $SUB/QLD.topojson --out $H/overlays/QLD-bushfire_prone.geojson --raster-m 60
$PY overlay_geometry.py vector --layer-dir $H/vector/wa-bushfire  --layer bushfire_prone --suburbs $SUB/WA.topojson  --out $H/overlays/WA-bushfire_prone.geojson  --raster-m 60
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
land, QLD's bushfire prone area and WA's OBRM-026: a GEOS union of 235,000
parcel polygons (or 2.56 million fragments, or 24 million vertices) exhausts
memory, so the pages are burnt one at a time onto a 60 m grid over the state and
polygonised instead. The satellite
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
  -d '{"stateCode":"NT","metricKeys":["water_observed_share_pct","flood_planning_share_pct"]}' \
  https://api.shorted.com.au/shorts.v1alpha1.HousingService/GetSuburbMetricColumns
```

NT's `flood_planning_share_pct` null mask must be all ones; NSW's must match
the artifact's null count (3,833), not be all zeros.
