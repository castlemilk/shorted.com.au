---
name: housing-suburb-data
description: Operate and extend the per-suburb data layers behind the housing map — ABS Census, SEIFA, GA elevation, Valuer-General prices, amenities/LGA/connectivity — and the map metric registry that serves them. Use when a suburb metric is NULL or stale, when adding a new "Colour by" metric, when running or debugging a collector ingest mode, when a choropleth renders wrong, or before trusting any claim in the housing docs.
---

# Housing suburb data — ingest, verify, serve

Operating manual for the ~15,345 SAL suburb rows behind `/housing/[state]` and
`/housing/[state]/[suburb]`. Architecture and licence posture:
`docs/feature/housing/` (start at `README.md`). Pipeline modes:
`docs/feature/housing/pipeline.md`.

**Iron rules. Every one of these is a real incident, most of them recent.**

1. **Verify the source, not the document.** In one 2026-08 session the handover's
   Census table mapping was wrong in three places, `data-model.md` said live
   columns were "reserved, don't build on them", `CLAUDE.md` listed a fixed MV
   hazard as open, and six of eight "known-open" audit items were already
   closed. Status lines in this repo go stale faster than they get read. Check
   the DataPack, the DB, or the RPC — then update the doc.
2. **NULL-on-miss is only as strong as the column NAME is specific.** The parser
   resolves DataPack columns by exact header, so a wrong table normally yields
   NULL. It failed once: `dwelling_count` was read from G33 (household income)
   because `Tot_Tot` is a generic name that exists in many tables. It happened to
   be numerically right. Prefer specific headers; treat a generic one
   (`Tot_Tot`, `Total`) as unsafe to resolve across tables.
3. **Prod does not run `migrate up`.** The deploy applies a hardcoded allowlist
   and force-writes `schema_migrations` to 75, so the DB cannot tell you what it
   has. Hand-apply on the **session pooler (5432)** with
   `PGOPTIONS="-c statement_timeout=0"`, then record it in
   `services/migrations/PROD_APPLIED.md`. `scripts/tests/migration-drift.test.mjs`
   fails the build if you forget.
4. **Anything added to the deploy allowlist RE-RUNS ON EVERY DEPLOY.** It must be
   replay-safe: every statement `IF NOT EXISTS`/`CREATE OR REPLACE`, no bare
   `ADD COLUMN`, no `INSERT` without `ON CONFLICT`, no `DROP … CREATE` of a
   materialized view. `000083` was allowlisted and carried a `CREATE OR REPLACE`
   of `refresh_all_materialized_views()` with the PRE-hardening body — every prod
   deploy silently reverted the fix for a 19-day staleness incident. It was
   removed 2026-08-29.
5. **Gate every public read on `source_licence`.** Crawl-tier rows
   (`property_listings`, `property_valuations`, `property_price_events`) default
   to `proprietary-tos-restricted` — a column DEFAULT, so the unlicensed state is
   unstorable. That default means nothing unless the read path consults it.
   Only DERIVED AGGREGATES are a publishable surface.
6. **An operator ingest that fails must exit non-zero.** Eleven modes used to log
   and return, so wrappers and alerts read a failed run as healthy. They now
   dispatch through `ingestExit` in `main.go`, pinned by
   `TestOperatorIngestModesPropagateFailure`.
7. **A guard you have not seen FAIL is not a guard.** Two in one session passed
   against deliberately broken code: a licence test whose own explanatory comment
   satisfied its substring search, and a visual test run without rebuilding
   Storybook (it screenshotted the stale bundle). Always break the thing, watch
   the guard fail, then restore.

## 1. The layers, and how each is populated

All land in `suburb_demographics` (plus `suburb_amenities`, `lga`,
`suburb_connectivity`). All are **operator-run** — none is in `-mode all`, which
runs only the official ABS/RBA tier plus an MV refresh.

| Layer | Mode | Source | Prod count (2026-08-29) |
|---|---|---|---|
| Census core (G01/G02) | `census` | ABS GCP SAL DataPack | 15,345 |
| Census expanded (7 rates + tenure) | `census` | same DataPack, tables below | 8,931–8,952 |
| SEIFA | `seifa` | ABS SEIFA by SAL | 14,355 |
| Elevation (6 cols) | `elevation` | GA 1 Second DEM-S | 15,307 |
| VG suburb medians | `vg-nsw` / `vg-vic` / `vg-sa` | state Valuer-General | NSW 2,433 · VIC 766 · SA 426 |
| Amenities / LGA / NBN / banners | `amenities` `lga` `connectivity` `banners` | precomputed offline JSON | — |

**QLD and WA have no VG tier and will not get one** — both sell sales data
through brokers. See `data-sources.md`; do not re-open, and do not substitute the
LGA-level percentage-change layer as a price proxy.

## 2. Census expanded — the verified table mapping

Every table number was wrong before 2026-08-27. Do not re-derive these from
table titles; they were established by extracting header lines from the real
`2021_GCP_SAL_for_AUS_short-header.zip`.

| Metric | Table | Numerator / denominator |
|---|---|---|
| tenure ×3 + `dwelling_count` | **G37** | `O_OR_Total`, `O_MTG_Total`, `R_Tot_Total` / `Total_Total` |
| unemployment, participation | **G43** | `lfs_Unmplyed_lookng_for_wrk_P` / `lfs_Tot_LF_P`; `lfs_Tot_LF_P` / `P_15_yrs_over_P` |
| bachelor-or-higher | **G43** | `non_sch_qual_{PostGrad_Dgre,Gr_Dip_Gr_Crt,Bchelr_Degree}_P` / `P_15_yrs_over_P` |
| separate house / flat | **G36** | `OPDs_Separate_house_Dwellings`, `OPDs_Flt_apart_Tot_Dwgs` / `OPDs_Tot_OPDs_Dwellings` |
| couple-with-children, lone-person | **G42** | `Tot_FHs_CF_C`, `Tot_Lone_P_H` / `Tot_Tot` |
| low / high personal income | **G17B + G17C** | `P_1_149_Tot`…`P_400_499_Tot` (G17B) and `P_2000_2999_Tot`…`P_3500_more_Tot` (G17C) / `P_Tot_Tot` (**G17C**) |

Traps: wide tables are **lettered splits** (a bare `G17` entry does not exist);
G33 is household income, G32 family income, G25 unpaid assistance, G26 unpaid
child care; **no age × sex summing is needed for anything** — G43 and G17B/C
carry direct totals. The income metric spans two files, so `combineG17Rows`
unions them on `SAL_CODE_2021` and **omits any header present in both**, leaving
the dependent metric NULL rather than picking one.

Run it:

```bash
cd services/house-price-collector
DATABASE_URL="${PROD/:6543/:5432}" PGOPTIONS="-c statement_timeout=0" \
CENSUS_GEO_DIR="$PWD/../../web/public/geo/suburbs" \
CENSUS_DATAPACK_PATH=/path/to/gcp_sal.zip \
GOWORK=off go run . -mode census
```

`CENSUS_GEO_DIR` is required — it defaults to a repo-relative path absent from
the container image, which is why this mode never once succeeded in Cloud Run.

**Expect ~8,950 of 15,345, not all.** 6,393 suburbs sit below
`censusDerivedRateMinPopulation = 100` (Census randomisation makes tiny-cell
rates misleading) and 21 more are zero-denominator: the "No usual address
(State)" pseudo-SALs and Acton ACT have population but no occupied private
dwellings. A full 15,345 would mean the suppression broke.

## 3. Elevation — GA DEM-S

**ELVIS is not required.** Direct, resumable HTTP:

```
https://data.dea.ga.gov.au/projects/elevation/ga_srtm_dem1sv1_0/dems1sv1_0.tif
38,304,075,388 bytes (35.7 GiB) · accept-ranges: bytes
```

Its siblings `dem1sv1_0.tif` (DEM) and `demh1sv1_0.tif` (DEM-H) sit beside it
under near-identical names — the `s` is the product, and the script wants DEM-S.
A 20.4 GiB NetCDF of the same product is on NCI THREDDS if space is tight; read
`.../DEM-S/catalog.xml` and take `urlPath` (the path needs an `http/` segment and
the file is **not** `dems1sv1_0.nc`).

Everything lives on the **`gamma-systems-2` external volume** — the internal disk
cannot hold it. `venv/` there has rasterio/geopandas/pyproj (system `python3` is
Homebrew-managed and refuses `pip install` under PEP 668).

**Run per state, not in one pass.** Eight independent runs give progress from a
script that only prints at the end, and isolate failure.
`/Volumes/gamma-systems-2/shorted-dem/run-zonal.sh` does this and skips completed
states; `merge-states.py` merges and **refuses a partial set**. Measured peak RSS:
ACT 0.3 GiB → QLD **16.0 GiB** (Coral Sea's bbox is 1.9e9 cells). Peak does not
scale with the largest polygon — ~3.2 GiB is GDAL's block cache
(`GDAL_CACHEMAX` defaults to 5% of RAM); cap it on a smaller machine.

Load with `-mode elevation` (`ELEVATION_FILE` points at the merged JSON).

**`elevation_min_m` is a single-cell extremum and noise-sensitive**: 44 suburbs
(0.29%) report a minimum below −15 m, Australia's lowest natural point, from SRTM
void fill. Medians are unaffected. A suburb showing −86 m is the source data.

## 4. Verify through the RPC, not the table

Writing rows proves nothing about what users see. The map consumes
`GetSuburbMetricColumns`, so verify there:

```bash
curl -sS -X POST --max-time 90 -A "Mozilla/5.0 …" -H "Content-Type: application/json" \
  -d '{"stateCode":"NSW","metricKeys":["unemployment_rate","elevation_median_m"]}' \
  https://api.shorted.com.au/shorts.v1alpha1.HousingService/GetSuburbMetricColumns
```

The registry is **closed** — an unknown key returns `invalid_argument`. Values
are packed floats with an explicit `null_mask` bitset (LSB-first: position `i` is
byte `i/8`, bit `i%8`; 1 = NULL), so a genuine zero survives.

**Ground-truth checks that actually catch datum and unit errors** (a plausible
range does not):

- Highest elevation should land ~2,224 m in a Kosciuszko-massif suburb — the true
  summit is 2,228 m, and a 30 m DEM landing a few metres under it is correct.
- Tasmania should top out ~1,568 m against Ben Lomond's 1,572 m.
- **The ACT must return `land_share_below_5m` = 0.00% for all 136 suburbs.**
  Landlocked, 550 m up. This is the check that would have caught a datum error.
- Tenure shares should sum to ~96.3–96.6% (remainder is "other" + "not stated").

Note `curl` gets a Cloudflare challenge on **page** routes; verified crawlers are
exempt and you are not. Use scripted Playwright for pages (`web/` has it), or the
API for data.

## 5. Serving a metric on the map

`web/src/@/lib/housing/highlight-metrics.ts` is the serializable registry. A
continuous metric with no explicit `domain` gets its domain from the data via
`robustDomainTop` (`price-scale.ts`) — the **p98**, not the maximum.

That is not outlier rejection; the tail is real (Point Piper genuinely transacts
near $60M). Anchored on the raw max, the MEDIAN NSW suburb sat at 9.5% of the
sqrt ramp and the state rendered one colour. Deleting the single worst row only
reached 12.9% — the fragility is the scale, not the data. Values above the top
still paint (d3 clamps output) and the legend labels that tick `≥`.

Metrics with an explicit `domain` (crime ranks, political lean — `[0,100]`) are
untouched.

**Charts cannot SSR and functions cannot cross the RSC boundary.** Import charts
`dynamic(..., { ssr: false })` from a `"use client"` module and pass a
*serializable* key (`MetricKey`, `format="aud"|"percent"`), never a formatter or
scale.

`MapLegend` has visual-regression stories covering the ramp
(`map-legend.stories.tsx`). Baselines are **Bookworm-generated** — macOS
anti-aliasing differs and Mac PNGs diff on every CI run:

```bash
docker run --rm -v "$PWD":/work -w /work -e SKIP_ENV_VALIDATION=1 \
  node:22-bookworm-slim bash -lc \
  "npm ci --legacy-peer-deps && npx playwright install --with-deps chromium && npm run test:visual:update"
```

`test:visual` chains `storybook:build &&` for a reason — running
`npx playwright test` alone screenshots the stale bundle and will tell you a
broken change is fine.

## 6. After any ingest

MV refresh and cache bust, in that order. `refresh_housing_materialized_views()`
needs the **session pooler (5432)** with `statement_timeout=0` — the txn pooler
(6543) kills it mid-`REFRESH … CONCURRENTLY`. The collector's `refresh()` already
sets `SET LOCAL statement_timeout = 0`.

```bash
task deploy:revalidate CONFIRM=prod FLUSH=housing \
  PATHS="/housing,/housing/[state],/housing/[state]/[suburb]"
```

Read the response body, not the status: `revalidated` reflects **only**
`flushErrors` (paths are revalidated before the flush runs), and
`flushScanCommands` reports what the flush cost — a prefix flush is O(total
keyspace), because `COUNT` is a work hint and `MATCH` filters server-side.

`/housing/[state]` and `/housing/[state]/[suburb]` are in no automated
revalidation list; pass them explicitly.

## 7. When a deploy goes red

This pipeline has a real flake rate — three transient failures in one day
(`proxy.golang.org` twice, a Cloud Run startup probe once), all green on retry.
**Re-run before investigating.** `Deploy Infrastructure` also routinely outlives
a 45-minute watch because it rebuilds every service image before Terraform runs;
key any automation on terminal state, never a timeout.
