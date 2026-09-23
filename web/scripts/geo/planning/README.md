# Planning layer build

Produces two derived artifacts from the statewide planning schemes (all
CC-BY-family; licences and exclusions in `docs/feature/housing/data-sources.md`,
"Planning layer"):

- `services/house-price-collector/data/suburb-planning.json` — per-SAL zoning
  family shares, coverage, dominant family, heritage share + item count, NSW
  development standards and instrument names. **Not under `web/public`** (critic
  P26: collector-only JSON must not be a public URL). It is embedded in the
  collector binary (`//go:embed`), so `-mode planning` works inside the image;
  `PLANNING_FILE` overrides it.
- `web/public/geo/planning/<ST>-zoning.topojson` (categorical: one dissolved
  feature per family, `properties.family`) and `<ST>-heritage.topojson` (binary),
  ≤ 1.2 MB each, stamped `source` / `licence` / `asOf`. Fetched by the map only
  when the overlay is toggled on.

Nothing here fetches. The source layers were fetched once (2026-09-23) to the
external volume by the hazards fetcher (`../hazards/fetch-layer.mjs`) and the
bulk-zip converter kept beside them; `manifest.json` there records every
layer's URL, licence, counts and distinct codes.

```bash
P=/Volumes/gamma-systems-2/shorted-planning        # vector/<layer>/page-*.geojsonl + .done
PY=/Volumes/gamma-systems-2/shorted-dem/venv/bin/python   # geopandas, shapely 2, pyproj
cd web/scripts/geo/planning
```

## 1. Vocabulary

`zone_codes.json` is a snapshot of every distinct zone code in the manifest
(`code_families`). `zone_families.py` maps each onto the ten harmonised
families; an unknown code raises `UnknownZoneCode` and aborts the build. After
a re-fetch, refresh the snapshot and run the tests — a new code fails them until
someone places it:

```bash
$PY -m unittest test_planning.py -v
```

## 2. Shares (per state → merge)

```bash
for st in ACT TAS QLD SA VIC NSW; do
  $PY planning_share.py state --state $st --root $P \
      --suburbs ../../../public/geo/suburbs/$st.topojson --out $P/out/$st.json --workers 10
done
$PY planning_share.py merge --in-dir $P/out --out ../../../../services/house-price-collector/data/suburb-planning.json
```

Measured 2026-09-23 on a 12-core Mac: ACT 12 s, TAS 36 s, QLD 1 s, SA 22 s,
VIC 26 s, NSW 2.5 min; peak RSS 1.8 GB (TAS). Per state it streams the NDJSON
pages, projects to EPSG:3577, snaps to 1 cm, then per suburb: clips each zone
polygon, resolves overlaps by precedence (NSW SEPP over LEP; TAS TPS over the
Kingborough interim scheme), unions per family and divides by the suburb's
area. `GDAL_CACHEMAX` is capped at 256 MB. WA and NT get no rows; QLD rows
carry only the heritage item count.

## 3. Overlays

```bash
for st in ACT TAS SA VIC NSW; do
  $PY planning_overlays.py --state $st --root $P --out-dir $P/overlays
done
node build-overlays.mjs $P/overlays            # → web/public/geo/planning/
```

`planning_overlays.py` burns each state's zone polygons onto a grid in
precedence order (`ZONING_CELL_M`: NSW 90 m, VIC/SA 80 m, TAS 50 m, ACT 25 m),
sieves regions under `SIEVE_CELLS` (40) into their largest neighbour and
polygonises per family. Two vector dissolves were tried first and measured
out: simplifying each family separately pulls shared boundaries apart (TAS:
10k unrepairable intersections, stuck at 1.7 MB at 1.5% retention), and a
snap-only dissolve keeps every parcel sliver (VIC: 53k arcs, 2.6 MB at 3%;
NSW never finished). Heritage is one sparse feature and stays a vector
dissolve. `build-overlays.mjs` then simplifies topologically with mapshaper,
stepping retention down until the file is ≤ 1.2 MB. Measured 2026-09-24:
planning_overlays.py NSW 73 s / 4.0 GB peak, VIC 39 s, SA 33 s, TAS 50 s,
ACT 4 s. The web registry
(`web/src/@/lib/housing/overlays.ts`) declares which states have which layer,
and `planning-overlays.test.ts` fails if the committed files disagree with it.

## 4. Load and verify

```bash
# migration first (prod: hand-applied on the 5432 session pooler — see the report)
psql "$DATABASE_URL" -f services/migrations/000125_add_suburb_planning.up.sql
cd services/house-price-collector
DATABASE_URL=… GOWORK=off go run . -mode planning
```

Then check coverage per state (WA/NT 0 rows; QLD zoning NULL; NSW controls
only where there is residential land):

```sql
SELECT d.state_code, count(p.sal_code) rows, count(p.dominant_zone_family) zoned,
       count(p.heritage_share_pct) heritage, count(p.nsw_height_median_m) nsw_height
FROM suburb_demographics d LEFT JOIN suburb_planning p USING (sal_code) GROUP BY 1 ORDER BY 1;
```
