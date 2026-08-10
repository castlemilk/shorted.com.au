# OpenStats → shorted.com.au suburb-data ingestion plan

> Scratch plan for the Codex implementer (2026-07-22). Research evidence gathered live from
> openstats.com.au (curl + bulk-zip inspection) and the shorted repo. **Do not commit this file.**
> All repo paths are relative to the repo root unless absolute.

---

## 1. What openstats.com.au is + the exact data catalog

OpenStats (founded 2024, `https://openstats.com.au/about/`) is a free Australian geographic
data-visualisation site: Leaflet choropleth maps + dashboards over **suburb (ABS SAL 2021)**,
**LGA 2024**, **POA 2021**, **SA1** and **SA2/SA3/SA4** geographies. It is a static Next.js
export (pages-router, `__N_SSG`, `getRegularMapConfig`) — **no server API**; every map reads
prebuilt static JSON from `/data/maps/…`. `robots.txt` is fully permissive (`Allow: /`),
sitemap at `/sitemap.xml`. No anti-bot at all — plain `curl` with a browser UA returns
everything (no Cloudflare/Kasada challenge observed on any endpoint).

### Catalog (verified 2026-07-22)

| Dataset | Metrics | Geography | Vintage / cadence | Underlying source | Licence |
|---|---|---|---|---|---|
| **Crime** (`/stats/crime/`) | Per offence (break-ins→`dwelling`, `violent`, `motor_vehicle`): normalised count, rate /100k, national **population-weighted percentile rank** (0–100). Annual FY2012→FY2024 (annual = dwelling+violent only) + 2-yr-pooled FY2013→FY2024 (all 3 offences) | SAL 2021 (14,262), LGA 2024, POA 2021 | Annual; zip last-modified 2026-01-14; latest = pooled avg FY2022-23+2023-24 | ABS Crime Victimisation survey scaling + state police open data (BOCSAR, Vic CSA, QPS, SAPOL, WAPOL, ACT Policing). **No TAS/NT** (no suburb-level police data) | **CC-BY-NC-4.0** (bulk zip); commercial use = purchased licence (then CC-BY-4.0). See §6 |
| **Housing** (`/stats/housing/`) | Public-housing / private-rental / owner-occupied **percentile ranks** | SA1, SAL, LGA | Census 2021 (last updated 2 Jan 2025) | ABS Census 2021 "Tenure and Landlord Type" (TableBuilder) | Derived from CC-BY ABS data; openstats site content CC-BY-4.0, but see §6 caveat on data files |
| **Demographics** (`/stats/demographics/`) | Median age, born overseas, **indigeneity** — value + percentile rank | SAL, LGA | Census 2021 (updated 16 Dec 2024) | ABS Census 2021 (G01/medians, Indigenous Status) | as above |
| **Socio-economic** (`/stats/socio-economic/`) | **SEIFA IRSD disadvantage** rank, median weekly household income, **labour-force participation rate** — value + percentile rank | SAL, LGA | Census 2021 / SEIFA 2021 | ABS SEIFA 2021 + Census G43 | as above |
| **Property prices** (`/maps/property-prices/`, `/dashboards/property-prices/`) | Stratified median 3-br house & 2-br unit price + quarterly/annual/5-yr change | SA2/SA3/SA4 2021 | Quarterly, June-qtr 2025, marked **"experimental"** | OpenStats' own modelling (no methodology page live; `/stats/property-prices` not in sitemap) | **No licence stated** → treat as unlicensed |

### Access surfaces (exact URL shapes, all verified)

1. **Official bulk download (crime only)** — `https://dl.openstats.com.au/crime-data-nc.zip`
   (13.6 MB, `last-modified: 14 Jan 2026`). Contents:
   ```
   LICENCE.txt                                   (CC-BY-NC-4.0 full text)
   SAL2021/crime_normalised_sal_2021_ann.csv          (counts, annual, 280k rows)
   SAL2021/crime_rate_normalised_sal_2021_ann.csv     (rates /100k, annual)
   SAL2021/crime_rank_normalised_sal_2021_ann.csv     (percentile ranks, annual)
   SAL2021/crime_{,rate_,rank_}pooled_normalised_sal_2021_ann.csv   (2-yr pooled, 378k/378k/128k rows)
   LGA2024/… POA2021/…                            (same 6-file shape per geography)
   ```
   CSV schema (identical across files):
   ```
   frequency,date,measure,region_type,region,offence_type,offence,value
   ANNUAL,2024-06-01T00:00:00Z,OFFENCE_RATE_POOLED_NORMALISED,SAL_2021,Abbotsford (NSW),OFF,dwelling,926.22
   ```
   - `date` = FY ending (2024-06-01 = FY2023-24; pooled = avg of that FY + prior).
   - `region` = **ABS SAL 2021 display name** (e.g. `Abbotsford (NSW)`, `Birdwood (SA)`), NOT the code.
   - `offence` ∈ `dwelling` | `violent` | `motor_vehicle`; `value` may be `NA` (rank files).
   - Latest pooled year: 42,786 rows = 14,262 SALs × 3 offences; ranks are 0–100.

2. **Static map-data JSON** (what the Leaflet embeds fetch; config in
   `https://openstats.com.au/js/map-configs.js`):
   - Statistics: `/data/maps/statistics/{crime/dwelling,crime/violent,crime/motor_vehicle,housing/public,housing/private_rental,housing/owned,demographic/indigeneity,demographic/born_overseas,demographic/median_age,socio-economic/disadvantage,socio-economic/median_income,socio-economic/participation_rate,property-prices/median-3br-house,property-prices/annual-3br-house,property-prices/five-yr-3br-house,property-prices/median-2br-unit,property-prices/annual-2br-unit,property-prices/five-yr-2br-unit}.json`
     — shape `{"suburb": {"<SAL name>": <value>}, "lga": {...}}` (property-prices keyed
     `sa2_2021`/`sa3_2021`/`sa4_2021` by SA2 name).
   - Summaries: `/data/maps/summaries/{crime,housing,demographic,socio-economic,propertyprices}.json`
     — per-region multi-stat blobs (e.g. crime `{count,rate,rank}` per offence; propertyprices
     `{"date":"June 2025","summaryRows":{...price/quarterly/annual/5yr...}}`).
   - Boundary tiles: `/data/maps/geography/{suburb,lga,sa1,sa2_2021,sa3_2021,sa4_2021}/lod/{1,2,3}/{lat}.{lon}.geojson`
     (+ `files.txt` tile listing). Feature properties are `{name, state, fid}` — **no ABS codes**.
   - Dashboard search indexes: `/data/dashboards/search/{crime,property-prices}-locations.json`.

3. **Site pages** — static HTML with `__NEXT_DATA__` containing only page metadata (no data).

### Geography keying — the bridge to shorted

- Bulk CSVs + map JSONs key suburbs by **ABS SAL 2021 name** (`Abbotsford (NSW)` style),
  which is exactly shorted's `suburb_demographics.sal_name` (sourced from `SAL_NAME21` in
  `web/public/geo/suburbs/<ST>.topojson`).
- **Measured join rate: 14,262 / 14,262 = 100.00%** (case-insensitive) of openstats crime
  SAL regions match shorted's 15,345-suburb registry. The ~1,083 registry suburbs missing
  from openstats are its deliberate small-population exclusions → they simply get no-data.
- Join case-insensitively (`LOWER(sal_name)`); ABS names are nationally unique (state
  disambiguators like `(NSW)` are part of the official name).

---

## 2. Access strategy decision

**Recommendation: (a) ingest crime from the official bulk zip; (b) rebuild every
Census-derived metric (indigeneity, public housing, SEIFA, participation) from ABS primary
sources shorted already uses; (c) skip openstats property prices.**

Reasoning:

- The bulk zip is the only **explicitly licensed** data artifact and is richer than the web
  JSON (13-year annual series + counts + rates + ranks vs a single snapshot). One HTTP GET,
  no scraping, robots-clean, stable URL.
- The `/data/maps/*.json` endpoints are trivially fetchable but the `/copyright/` page
  scopes its CC-BY-4.0 grant to site *content* and **excludes "underlying data files not
  directly linked"** — i.e. the map JSONs are NOT clearly licensed for republication. Use
  them only as a validation cross-check during development, never as a stored source.
- The housing/demographic/socio-economic numbers are 100% re-derivable from ABS Census 2021
  / SEIFA 2021 (CC-BY-4.0) — shorted already holds the GCP SAL DataPack ingest (`-mode
  census`). Rebuilding from ABS gives clean licence posture, raw values (openstats web JSON
  only exposes percentile ranks), and code-keyed joins (no name matching at all for SEIFA).
  Here openstats is the *product blueprint*, not the data source.
- Property prices: experimental, no methodology page, no licence, SA2-grain (not suburb) —
  and shorted already has VG medians + the listings crawl + ABS RES_DWELL. Skip.

**Fallbacks:**
- If `dl.openstats.com.au` moves/vanishes: the zip URL is linked from `/stats/crime/`
  ("download the data here") — re-scrape that page for the new href. Worst case, the
  `/data/maps/statistics/crime/*.json` + `/data/maps/summaries/crime.json` snapshot can
  rebuild the latest pooled year (name-keyed, same values), licence caveat above applies.
- If the commercial licence is refused (§6): rebuild crime from the primary police sources
  openstats itself cites (BOCSAR suburb dataset, Vic CSA LGA tables, QPS, SAPOL, WAPOL, ACT
  Policing) — a substantially larger build (per-state normalisation + ABS victimisation
  scaling); keep as last resort.

---

## 3. Data model

### 3.1 Crime — new table + latest-snapshot MV (licence-gated, NOT columns on suburb_demographics)

Crime rows carry a different licence (`CC-BY-NC-4.0` until a commercial licence is bought)
from `suburb_demographics`' blanket `CC-BY-4.0` default, so keep them in their own table
with per-row `source_licence` — mirroring how `house_prices` gates
`proprietary-tos-restricted` rows (migration `000054` pattern), instead of the
electorates-style UPDATE-columns pattern.

**Migration `000091_add_suburb_crime.up.sql`** (shifted +2: `000089`/`000090` taken by
`crawl_run_status`. On `main`, 000087 = listing_details, 000088 = property_valuations (unmerged
PR), and 000089 = crawl_run_status are taken, so the next free pair is **000091** (crime) +
**000092** (census/SEIFA). Still re-verify at build time; this repo has renumbered several times
after parallel-branch collisions):

```sql
-- Suburb crime statistics (OpenStats bulk dataset, derived from state police data
-- + ABS Crime Victimisation scaling). Keyed by ABS SAL_CODE21 via the sal_name
-- bridge. Licence: CC-BY-NC-4.0 pending commercial licence (see source_licence).
CREATE TABLE IF NOT EXISTS suburb_crime_stats (
    sal_code        TEXT NOT NULL,          -- ABS SAL_CODE21 (joined via sal_name)
    fy_ending       SMALLINT NOT NULL,      -- 2024 = FY2023-24 (CSV date 2024-06-01)
    offence         TEXT NOT NULL,          -- 'break_ins' | 'violent' | 'motor_vehicle'
    pooled          BOOLEAN NOT NULL,       -- true = 2-yr pooled (preferred display series)
    count_norm      NUMERIC,                -- normalised offence count
    rate_per_100k   NUMERIC,                -- normalised rate per 100,000 persons
    percentile_rank NUMERIC,                -- 0..100 national population-weighted (NULL if 'NA')
    source          TEXT NOT NULL DEFAULT 'openstats_crime',
    source_licence  TEXT NOT NULL DEFAULT 'CC-BY-NC-4.0',
    fetched_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (sal_code, fy_ending, offence, pooled)
);
CREATE INDEX IF NOT EXISTS idx_suburb_crime_latest
    ON suburb_crime_stats (sal_code, pooled, fy_ending DESC);

-- Latest pooled snapshot for the map (one row per suburb; joined by ListStateSuburbs).
CREATE MATERIALIZED VIEW mv_suburb_crime_latest AS
SELECT DISTINCT ON (sal_code, offence)
       sal_code, offence, fy_ending, rate_per_100k, percentile_rank, source_licence
FROM suburb_crime_stats
WHERE pooled
ORDER BY sal_code, offence, fy_ending DESC;
CREATE UNIQUE INDEX idx_mv_suburb_crime_latest ON mv_suburb_crime_latest (sal_code, offence);
```

Fold the MV into `refresh_housing_materialized_views()` (same guarded-CONCURRENTLY pattern
as the price-drops MVs in `000086`). Data volume: ~14.3k SALs × 3 offences × (12 pooled +
13×2 annual) ≈ **0.9M rows** — comparable to existing housing tables, fine.

Map `dwelling` → `break_ins` at ingest (display language, matches openstats' own UI).

**Rejected alternatives:**
- `economic_series`/`economic_observations` (`000081`): SDMX-shaped and generic, but it
  would mint ~86k catalog rows (14.3k regions × 3 offences × 2 measures), its read path
  (`ListEconomicSeries`) serves the `/economy` state-grain surface, and the suburb explorer
  reads flat per-suburb fields via `ListStateSuburbs` — wrong grain, wrong reader. Suburb
  data lives in the housing domain.
- Columns on `suburb_demographics`: breaks the per-row licence gate and bloats the
  authoritative CC-BY registry with NC data.

### 3.2 Census-derived metrics — extend `suburb_demographics` (recipe H, clean CC-BY)

**Migration `000092_add_suburb_seifa_tenure.up.sql`** (shifted +2: 000089/000090 taken by
crawl_run_status; or fold into 000091 if preferred — keep crime separate so it can ship/gate independently):

```sql
ALTER TABLE suburb_demographics
    ADD COLUMN IF NOT EXISTS pct_indigenous            NUMERIC,  -- 0..100 (Census G01)
    ADD COLUMN IF NOT EXISTS pct_public_housing        NUMERIC,  -- 0..100 (Census tenure/landlord: state/community-housing landlord share)
    ADD COLUMN IF NOT EXISTS seifa_disadvantage_pctile NUMERIC,  -- 0..100 IRSD national percentile (SEIFA 2021 SAL)
    ADD COLUMN IF NOT EXISTS seifa_disadvantage_decile SMALLINT, -- 1..10 (1 = most disadvantaged)
    ADD COLUMN IF NOT EXISTS participation_rate        NUMERIC;  -- 0..100 labour-force participation (Census G43-family)
```

Sources (all ABS, CC-BY-4.0, no openstats dependency):
- `pct_indigenous`: the GCP SAL DataPack **G01** already parsed by `census.go` carries
  Aboriginal/Torres Strait Islander person counts — add the columns to `parseG01`.
- `pct_public_housing`: the DataPack **tenure & landlord-type table** (G33-family in the
  2021 GCP; find the exact `_AUST_SAL.csv` + short-header codes in the DataPack metadata —
  recipe H explicitly warns the codes are non-obvious). Public = landlord ∈ {state/territory
  housing authority, community housing provider} / total occupied rented+owned dwellings.
- `seifa_disadvantage_*`: ABS **SEIFA 2021 by SAL** spreadsheet (ABS website / Data
  Explorer, keyed by `SAL_CODE_2021` — a direct code join, no names). Small XLSX/CSV;
  the economy-collector's govfin XLSX importer shows the excelize pattern if XLSX.
- `participation_rate`: DataPack **G43-family** (selected labour-force characteristics) —
  same DataPack zip.

`house-price-collector`'s `upsertDemographics` (services/house-price-collector/store.go:161)
gains the new columns in its INSERT/`ON CONFLICT` list.

### 3.3 What NOT to store

- OpenStats' housing/demographic **percentile ranks** — recompute ranks in-house if wanted
  (population-weighted percentiles are a trivial SQL window over our own raw values), or
  skip: the choropleth normalises visually anyway.
- OpenStats property prices, POA/LGA/SA1 crime cuts (LGA can come later from the same zip —
  `lga` table exists since `000061`; out of v1 scope).

---

## 4. Collector implementation

**Home: `services/house-price-collector` (NOT economy-collector).** Suburb-grain data,
`suburb_demographics`/housing read path, and the collector already owns every suburb ingest
(`census`, `electorates`, `lga`, `amenities`, `connectivity`…). economy-collector is
state/national SDMX series only.

### 4.1 `-mode crime` (new file `services/house-price-collector/crime.go`)

Follow the `runCensus` shape exactly (main.go:366 — ingest → upsert → `updateRun` cursor):

1. Register in `main.go`: `case "crime": runCrime(ctx, pool)` + add to the `-mode` usage
   string. **Do not** add to `"all"`/the scheduled path — operator-run like `census`
   (annual cadence, see §4.3).
2. `ingestCrime(ctx)`:
   - GET `https://dl.openstats.com.au/crime-data-nc.zip` (env override
     `OPENSTATS_CRIME_ZIP` for a local file path — the DataPack pattern
     (`CENSUS_DATAPACK_PATH`) shows the convention). Send the project UA
     `shorted-housing/1.0 (+https://shorted.com.au)` per the ABS-WAF convention in
     `abs.go` — no WAF observed on openstats, but keep the house style. Plain
     `net/http` + `archive/zip` on a temp file; `services/pkg/absdata` is SDMX/RBA-specific
     and not needed here.
   - Parse the 6 `SAL2021/*.csv` members (`encoding/csv`). Header
     `frequency,date,measure,region_type,region,offence_type,offence,value`. Skip
     non-`SAL_2021` rows defensively; `value == "NA"` → NULL; `date` → `fy_ending =
     year(date)`; filename/`measure` (`OFFENCE_COUNT/RATE/RANK` × `_POOLED`) selects the
     column + `pooled` flag; `dwelling` → `break_ins`.
   - Resolve `region` (SAL name) → `sal_code` via one query:
     `SELECT sal_code, LOWER(sal_name) FROM suburb_demographics` into a map (the
     authoritative registry — `-mode census` must have run first). Match
     case-insensitively. Log + count unmatched names and **fail the run if match rate
     < 99%** (measured today: 100.00%; a drop means ASGS drift or an upstream format
     change — fail-closed like the economy importers).
3. `upsertCrime(ctx, pool, rows)` in store.go: batch upsert
   (`INSERT … ON CONFLICT (sal_code, fy_ending, offence, pooled) DO UPDATE`) — copy the
   `upsertDemographics` `pgx.Batch` pattern. Merge the three measure files per key before
   upserting (build a `map[key]row` while parsing) so one row carries count+rate+rank.
4. Finish with `refresh(ctx, pool)` (refreshes housing MVs incl. the new
   `mv_suburb_crime_latest`, re-links sal codes, pings revalidate).
5. `updateRun(ctx, pool, "openstats_crime", latestFY, n, status, msg)` — the existing
   `collector_runs` cursor.

Idempotency: pure upsert on a natural key; re-running on the same zip is a no-op. A new
zip revision simply overlays newer FYs.

### 4.2 Census extensions (`-mode census` + new `-mode seifa`)

- Extend `census.go` (`CensusRow`, `parseG01`, new `parseTenure`, new `parseG43`) +
  `upsertDemographics` per recipe H (docs/feature/housing/architecture.md §9-H). Re-run needs
  `CENSUS_DATAPACK_PATH` + `CENSUS_GEO_DIR`; **re-apply migration `000056`** (sal_code
  backfill) after re-running, per the documented recipe.
- `-mode seifa` (new `seifa.go`): download/read the ABS SEIFA 2021 SAL file (env
  `SEIFA_PATH` for a local copy; implementer to pin the ABS download URL — it lives on the
  SEIFA 2021 release page), join on `SAL_CODE_2021` directly, `UPDATE suburb_demographics
  SET seifa_… WHERE sal_code = $1` (electorates-style targeted update, store.go:215).

### 4.3 Cadence / scheduling

- **Crime**: openstats refreshes ~annually (current zip Jan-2026, data to FY2023-24). Run
  `-mode crime` manually now, then re-run when FY2024-25 lands (~Q4 2026). Optionally add a
  yearly Cloud Run scheduler later — not worth TF wiring for v1 (matches the
  suburb-explorer "manual-ingest" posture in CLAUDE.md).
- **SEIFA/census**: one-shot until Census 2026 DataPacks (2027+).
- Both run against prod DB the same way existing census/electorate ingests do (operator,
  `DATABASE_URL` to the txn pooler 6543; DDL itself via session pooler — §7).

---

## 5. Read path + frontend

### 5.1 Proto (dual-add contract — domain file AND legacy service)

`proto/shortedapi/shorts/v1alpha1/housing.proto`:

- **`SuburbSummary`** (map metrics; current max field = 27 — verify before assigning):
  ```protobuf
  // Crime (OpenStats-derived, latest 2-yr-pooled FY). 0/absent until ingested or when gated.
  double crime_break_ins_rank      = 28;  // 0..100 national percentile
  double crime_violent_rank        = 29;
  double crime_motor_vehicle_rank  = 30;
  // Socio-economic (ABS SEIFA 2021 / Census 2021).
  double seifa_disadvantage_pctile = 31;  // 0..100 (higher = more disadvantaged)
  double pct_public_housing        = 32;  // 0..100
  double pct_indigenous            = 33;  // 0..100
  double participation_rate        = 34;  // 0..100
  ```
- **`SuburbDemographics`** (profile; current max field = 18): add `pct_indigenous = 19`,
  `pct_public_housing = 20`, `seifa_disadvantage_pctile = 21`, `seifa_disadvantage_decile = 22`,
  `participation_rate = 23`.
- **New profile message + field on `GetSuburbProfileResponse`** (phase 2, trend chart):
  ```protobuf
  message SuburbCrimeYear {
    int32  fy_ending = 1;          // 2024 = FY2023-24
    string offence = 2;            // 'break_ins' | 'violent' | 'motor_vehicle'
    double rate_per_100k = 3;
    double percentile_rank = 4;
  }
  // on GetSuburbProfileResponse: repeated SuburbCrimeYear crime_series = <next>;
  ```
- No new RPCs needed (existing `ListStateSuburbs` / `GetSuburbProfile` carry everything) →
  no `serve.go` mounting, no rewrite-rule change. Message-field additions still follow the
  split-proto rules: fields live in `housing.proto` only (messages are domain-owned; the
  legacy `ShortedStocksService` in `shorts.proto` is message-less and shares these rpcs
  already — `proto_parity_test.go` will catch any drift). Then `cd proto && buf generate`
  and **commit ALL outputs including `sdks/java` churn**.

### 5.2 Handlers + store

- `services/shorts/internal/store/shorts/postgres_house_prices.go`:
  - `ListStateSuburbs` (line ~240): LEFT JOIN `mv_suburb_crime_latest` three ways or
    (simpler) one lateral `jsonb_object_agg(offence, percentile_rank)` — pick the flat
    3-column join for scan simplicity. Gate: only populate when
    `HOUSING_CRIME_ENABLED` (default per §6 decision) AND `source_licence` is republishable
    once the commercial licence flips — cleanest is to bake the gate into the SELECT
    (`WHERE source_licence IN (...allowed...)`) mirroring `000054`'s
    `source_licence <> 'proprietary-tos-restricted'` pattern, with the env flag checked in
    the handler (`house_prices.go`) like `HOUSING_DROP_LISTINGS_ENABLED` is today.
  - `GetSuburbProfile` (line ~322): add the new demographic columns to SELECT/Scan; phase 2
    adds the `suburb_crime_stats` pooled-series query.
- `services/shorts/internal/services/shorts/house_prices.go`: map new store fields → proto.
  Bump/namespace the relevant MemoryCache keys (`ListStateSuburbs` responses are cached —
  include the flag state in the key or flush on deploy).

### 5.3 Frontend — new "Colour by" highlight metrics

Registry: `web/src/@/lib/housing/highlight-metrics.ts` (recipe G — selector/legend/dispatch
are automatic once registered):

- Extend `SuburbMetricInput` + the mapping in `state-suburb-explorer.tsx` /
  `state-suburb-map.tsx` (`SuburbDatum`) with the new fields off `SuburbSummary`.
- Add to `HIGHLIGHT_METRICS`:
  - `crime_break_ins`, `crime_violent`, `crime_motor_vehicle` — `kind:"continuous"`,
    value = percentile rank, fixed `domain: [0,100]`, and a **danger scale** (amber→red;
    add a `makeScale` like the existing `politicalLeanScale` diverging precedent — do NOT
    reuse plain amber, high must read as bad). `null` when 0-and-no-data (TAS/NT + small
    suburbs → hatch).
  - `disadvantage` — continuous, `domain: [0,100]`, diverging.
  - `public_housing`, `indigenous`, `participation` — continuous percentages.
- Icons: add entries to the `METRIC_ICONS` map (`HousingIconName` — reuse existing sprite
  names or add via the brandbrain icon flow; non-blocking).
- Profile page (`suburb-profile.tsx`): surface SEIFA decile + public housing + participation
  in the demographics panel; phase-2 crime trend = a small multiples/line chart via the
  existing chart primitives (`dynamic ssr:false`, format-key rule — no function props).
- Economy surface: **no change** (suburb grain doesn't fit `map-metrics.ts`; skip).

---

## 6. Licensing / ToS posture  ⚠️ USER DECISION REQUIRED (crime only)

| Source | Licence | Posture |
|---|---|---|
| OpenStats crime bulk zip | **CC-BY-NC-4.0**; site offers a **paid commercial licence** (then CC-BY-4.0) — `/stats/crime/`: "Commercial licensing of our crime data is available… contact us" | shorted is commercial (ads/Stripe subs) → **NC does not cover production use.** Fork below |
| ABS Census 2021 / SEIFA 2021 | CC-BY-4.0 | Ingest + republish freely with attribution (existing posture, `source_licence='CC-BY-4.0'`) |
| OpenStats map JSONs (`/data/maps/…`) | Excluded from the site's CC-BY grant ("underlying data files not directly linked") | Dev-time cross-validation only; never stored/republished |
| OpenStats property prices | None stated, "experimental" | Do not ingest |

**The fork (user must choose before the crime surface goes live):**
- **A (recommended): buy/obtain the commercial licence** via `https://openstats.com.au/contact/`
  (site self-describes "permissive terms"; likely cheap for attribution + a backlink). Then
  flip `source_licence` to the granted terms (CC-BY-4.0), attribute "Crime data © OpenStats"
  in the map legend/sources, and ship ON.
- **B: build everything now, gate crime display** behind `HOUSING_CRIME_ENABLED=false`
  until A resolves. This conflicts with the "no dark flags" preference, but this is a legal
  gate, not a product experiment — the flag flips to ON (and becomes a kill switch, matching
  the `HOUSING_DROP_LISTINGS_ENABLED` precedent) the day the licence lands.
- **C: rebuild from primary police sources** (BOCSAR/CSA/QPS/SAPOL/WAPOL/ACT) — weeks of
  per-state normalisation; last resort.

Everything else in this plan (SEIFA/tenure/indigeneity/participation, §3.2) is CC-BY and
ships unconditionally. Attribution lines go wherever the suburb explorer already credits ABS
(map legend / methodology footer / `sources` fields).

---

## 7. Phased rollout + landmines

**Phase 1 (ship immediately, no licence dependency):** migrations 000091+000092, census/SEIFA
ingests, proto+RPC plumbing for the §3.2 metrics, 4 new highlight metrics
(disadvantage/public_housing/indigenous/participation), prod ingest + MV refresh.

**Phase 2 (crime, behind the §6 decision):** `-mode crime` ingest (can run into prod
immediately — storage of NC data for internal evaluation is defensible; **publishing** is
what needs the licence), map crime metrics + profile trend chart wired but gated per §6.

**Phase 3 (optional):** LGA-grain crime from the same zip onto the `lga` dimension; in-house
percentile ranks for other metrics; yearly scheduler for `-mode crime`.

**Landmines (from the analogous pipelines — read before building):**
1. **Name join**: case-insensitive only (`Hmas Cerberus`-style casing drift exists in
   openstats' *web* JSON; the bulk CSV matched 100% today but don't assume). Fail-closed
   below 99% match. `-mode census` must have populated `suburb_demographics` first.
2. **`NA` values** in rank CSVs → NULL, not 0 (0 is a real rank).
3. **Annual vs pooled**: annual files lack `motor_vehicle`; display the pooled series
   (openstats' own default) and label it "2-yr pooled".
4. **TAS/NT are absent by design** → those states' suburbs must hatch as no-data in the
   crime metrics (the `category/value → null` path in `highlight-metrics.ts`), not paint 0.
5. **Migration number collision**: use **000091/000092** (shifted +2: 000089/000090 taken by
   crawl_run_status) — 000087 (listing_details), 000088 (property_valuations, unmerged) and
   000089 (crawl_run_status) are taken on `main`; `git fetch` +
   `ls services/migrations | tail` on main to re-confirm. This repo has collided several times.
6. **Prod DDL**: session pooler port 5432 + `PGOPTIONS="-c statement_timeout=0"` (txn
   pooler 6543 kills `CREATE/REFRESH MATERIALIZED VIEW CONCURRENTLY`); normal collector
   writes stay on 6543. First `REFRESH … CONCURRENTLY` needs the unique index in place.
7. **MV refresh wiring**: add `mv_suburb_crime_latest` to
   `refresh_housing_materialized_views()` inside the migration (copy the `000086` guarded
   fallback) — otherwise the collector's `refresh()` silently skips it.
8. **Proto discipline**: fields in `housing.proto` only; `cd proto && buf generate`; commit
   `sdks/java` churn; web imports from `~/gen/shorts/v1alpha1/housing_pb` — importing
   `shorts_pb` will trip `bundle:budget`.
9. **RSC rules**: new metrics are dispatched by serializable `MetricKey` — never pass
   scale/formatter functions across the boundary; charts stay `dynamic(ssr:false)`.
10. **Caches**: `ListStateSuburbs`/`GetSuburbProfile` responses sit in MemoryCache + the web
    KV layer — after prod ingest, hit `/api/revalidate?path=/housing&flush=housing` (the
    collector's `refresh()` → `pingRevalidate` does this automatically when
    `REVALIDATION_URL`/`_SECRET` are set).
11. **UA convention**: send `shorted-housing/1.0 (+https://shorted.com.au)` on openstats +
    ABS fetches (ABS hard-requires it; openstats doesn't today, stay polite). Single-digit
    requests per run — no rate concerns; robots.txt permits all.
12. **Don't touch the residential-crawl Chrome** — openstats needs none of that machinery.

---

## 8. Ordered task list for the implementer

Phase 1 — Census/SEIFA (licence-clean):
1. Verify next free migration numbers (`ls services/migrations | tail`). Write
   `000091_add_suburb_crime.{up,down}.sql` (§3.1: table + MV + fold MV into
   `refresh_housing_materialized_views()`) and
   `000092_add_suburb_seifa_tenure.{up,down}.sql` (§3.2) — shifted +2: 000089/000090 taken by crawl_run_status.
2. `services/house-price-collector/census.go`: extend `CensusRow` + `parseG01`
   (indigenous), add tenure + labour-force table parsers (find exact DataPack CSV names +
   short-header codes in the DataPack metadata first). Extend
   `upsertDemographics` (store.go) with the new columns.
3. New `services/house-price-collector/seifa.go` + `-mode seifa` in main.go: ABS SEIFA 2021
   SAL file → `seifa_*` columns (code-keyed UPDATE).
4. Proto: add §5.1 fields to `SuburbDemographics` + the four §3.2 fields on `SuburbSummary`
   in `proto/shortedapi/shorts/v1alpha1/housing.proto`; `buf generate`; commit all outputs.
5. Store + handler: extend `ListStateSuburbs` / `GetSuburbProfile` SELECT/Scan/mapping
   (`postgres_house_prices.go`, `house_prices.go`).
6. Frontend: extend `SuburbMetricInput`/`SuburbDatum` mappings; add
   `disadvantage`/`public_housing`/`indigenous`/`participation` to `HIGHLIGHT_METRICS` +
   `METRIC_ICONS`; surface in `suburb-profile.tsx`.
7. Tests: unit-test the new parsers on DataPack fixtures; `make test`; jest for the
   registry; storybook visual if the legend changes.
8. Local verify end-to-end (`make dev`, run `-mode census` + `-mode seifa` against local
   DB, check `/housing/[state]` colour-by + a suburb profile).
9. Prod rollout (DB-before-code order, per local-insights precedent): apply 000091+000092
   via session pooler; run `-mode census` (with `CENSUS_DATAPACK_PATH`) + re-apply `000056`;
   run `-mode seifa`; merge/deploy code; revalidate sweep.

Phase 2 — Crime:
10. `services/house-price-collector/crime.go` + `-mode crime` (§4.1) + `upsertCrime` in
    store.go + unit tests on a truncated zip fixture (incl. `NA`, name-match fail-closed,
    dwelling→break_ins mapping).
11. Proto crime fields on `SuburbSummary` (+ phase-2 `SuburbCrimeYear` series on the
    profile response); `buf generate`; store/handler wiring with the
    `HOUSING_CRIME_ENABLED` + `source_licence` gate (§5.2).
12. Frontend crime metrics (danger scale, TAS/NT no-data hatch) + profile trend chart.
13. Run `-mode crime` against prod (ingest is fine pre-licence; display gated per §6).
14. **USER: resolve the §6 licence fork** → flip `source_licence` (one UPDATE) + the env
    flag; add the OpenStats attribution line to the map sources; announce the surface.
