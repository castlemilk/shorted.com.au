# Local Insights W0 — Foundation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the reusable spatial-join harness, the four new suburb-insight tables, and the collector ingest scaffold that workstreams W1–W5 all depend on — proven by unit tests and a fixture round-trip, with zero user-facing churn.

**Architecture:** A hand-rolled `geo-index.mjs` (uniform-grid polygon index for point-in-polygon counts + brute-force haversine nearest for distance metrics) precomputes `{salCode → metrics}` JSON exactly like the existing `join-electorates.mjs`/`join-sed.mjs`. The collector gains `-mode amenities` that loads that JSON and upserts into a new `suburb_amenities` table (plus empty `lga`/`suburb_lga`/`suburb_connectivity`/`suburb_funding` skeletons). OSM raw points never enter the repo; an attribution credit is wired into the map.

**Tech Stack:** Node ESM (`.mjs`, `node:test`), PostgreSQL (golang-migrate up/down SQL), Go (pgx batch `ON CONFLICT` upserts), Next.js/React (TSX attribution component).

**Reference spec:** `docs/superpowers/specs/2026-06-30-local-insights-design.md` (§3 architecture, §4 data model, §7 licensing, §8 workstreams).

**Conventions reused (read before starting):**
- Join script idiom + ray-casting helpers: `web/scripts/geo/join-sed.mjs`.
- Collector store upsert pattern: `services/house-price-collector/store.go` (`upsertDemographics`, `connect`, `updateRun`).
- Collector mode switch + run fn: `services/house-price-collector/main.go` (`runCensus`, `runElectorates`).
- Ingest-from-JSON idiom: `services/house-price-collector/electorates.go` (`readJSONFile`, `ingestElectorates`).
- Migration format: `services/migrations/000055_add_suburb_demographics.up.sql` (CREATE TABLE), `000060_*.up.sql`/`.down.sql` (ALTER + down).
- Local dev DB: `postgresql://admin:password@localhost:5438/shorts` (started by `make dev-db`). Migrations applied from `services/` via `make migrate-up`.

---

## File Structure

**Create:**
- `web/scripts/geo/geo-index.mjs` — reusable spatial harness: GeoJSON helpers, `makePolygonIndex(features)` → `{ locate(lon,lat) }`, `haversineKm`, `nearestPoint(lon,lat,points)`, `loadSuburbFeatures(dir)`.
- `web/scripts/geo/geo-index.test.mjs` — `node:test` unit tests for the harness (the risk surface).
- `services/migrations/000061_add_lga.up.sql` / `.down.sql` — `lga` dimension + `suburb_lga` bridge.
- `services/migrations/000062_add_suburb_amenities.up.sql` / `.down.sql` — `suburb_amenities`.
- `services/migrations/000063_add_suburb_connectivity.up.sql` / `.down.sql` — `suburb_connectivity`.
- `services/migrations/000064_add_suburb_funding.up.sql` / `.down.sql` — `suburb_funding`.
- `services/house-price-collector/amenities.go` — `AmenityRow` + `ingestAmenities()` (load `suburb-amenities.json`).
- `services/house-price-collector/amenities_test.go` — fixture parse test.
- `services/house-price-collector/testdata/suburb-amenities.sample.json` — 2-row fixture.
- `web/src/@/components/housing/data-attribution.tsx` — source/licence credit line.

**Modify:**
- `services/house-price-collector/store.go` — add `upsertAmenities`.
- `services/house-price-collector/main.go` — add `-mode amenities` case + `runAmenities`.
- `web/scripts/geo/.gitignore` (create) — ignore the raw OSM `.staging/` dir.
- `web/src/@/components/housing/state-suburb-explorer.tsx` — render `<DataAttribution/>` under the map.

---

## Task 1: Polygon index (point-in-polygon counts)

**Files:**
- Create: `web/scripts/geo/geo-index.mjs`
- Test: `web/scripts/geo/geo-index.test.mjs`

- [ ] **Step 1: Write the failing test**

```js
// web/scripts/geo/geo-index.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { makePolygonIndex } from "./geo-index.mjs";

// Two non-overlapping unit squares as GeoJSON-ish features with an `id` (SAL code).
const features = [
  { id: "10001", geometry: { type: "Polygon", coordinates: [[[0, 0], [0, 1], [1, 1], [1, 0], [0, 0]]] } },
  { id: "10002", geometry: { type: "Polygon", coordinates: [[[2, 2], [2, 3], [3, 3], [3, 2], [2, 2]]] } },
];

test("locate returns the containing feature id", () => {
  const idx = makePolygonIndex(features);
  assert.equal(idx.locate(0.5, 0.5), "10001");
  assert.equal(idx.locate(2.5, 2.5), "10002");
});

test("locate returns null outside all polygons", () => {
  const idx = makePolygonIndex(features);
  assert.equal(idx.locate(1.5, 1.5), null);
  assert.equal(idx.locate(-1, -1), null);
});

test("locate respects holes", () => {
  const donut = [{
    id: "20001",
    geometry: { type: "Polygon", coordinates: [
      [[0, 0], [0, 10], [10, 10], [10, 0], [0, 0]],   // outer
      [[4, 4], [4, 6], [6, 6], [6, 4], [4, 4]],        // hole
    ] },
  }];
  const idx = makePolygonIndex(donut);
  assert.equal(idx.locate(1, 1), "20001"); // in ring, outside hole
  assert.equal(idx.locate(5, 5), null);    // inside the hole
});

test("centroids exposes a representative interior point per feature", () => {
  const idx = makePolygonIndex(features);
  const c = idx.centroids();
  assert.equal(c.get("10001").length, 2);
  // centroid of the unit square is ~(0.5,0.5) and must locate back to itself
  assert.equal(idx.locate(...c.get("10001")), "10001");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test web/scripts/geo/geo-index.test.mjs`
Expected: FAIL — `Cannot find module './geo-index.mjs'` / `makePolygonIndex is not a function`.

- [ ] **Step 3: Write minimal implementation**

```js
// web/scripts/geo/geo-index.mjs
// Reusable spatial-join harness for suburb-insight precompute scripts.
// Mirrors the ray-casting helpers in join-sed.mjs but adds a uniform-grid index
// so we can attach ~80k POIs to ~15k suburb polygons in O(points), and a
// brute-force haversine nearest for distance metrics. No external deps.
import fs from "node:fs";
import path from "node:path";
import { feature } from "topojson-client";

// --- GeoJSON ring helpers (same math as join-sed.mjs) -----------------------
export function toPolys(geom) {
  const out = [];
  const push = (poly) => out.push({ outer: poly[0], holes: poly.slice(1) });
  if (geom.type === "Polygon") push(geom.coordinates);
  else if (geom.type === "MultiPolygon") geom.coordinates.forEach(push);
  return out;
}
export function ringsBbox(polys) {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const p of polys) for (const [x, y] of p.outer) {
    if (x < x0) x0 = x; if (y < y0) y0 = y; if (x > x1) x1 = x; if (y > y1) y1 = y;
  }
  return [x0, y0, x1, y1];
}
export function inRing(pt, ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const xi = ring[i][0], yi = ring[i][1], xj = ring[j][0], yj = ring[j][1];
    if (((yi > pt[1]) !== (yj > pt[1])) && (pt[0] < ((xj - xi) * (pt[1] - yi)) / (yj - yi) + xi)) inside = !inside;
  }
  return inside;
}
export function inPolys(pt, polys) {
  for (const { outer, holes } of polys) if (inRing(pt, outer) && !holes.some((h) => inRing(pt, h))) return true;
  return false;
}
function ringArea(ring) { let a = 0; for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) a += (ring[j][0] + ring[i][0]) * (ring[j][1] - ring[i][1]); return a / 2; }
function ringCentroid(ring) {
  let x = 0, y = 0, a = 0;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const f = ring[j][0] * ring[i][1] - ring[i][0] * ring[j][1];
    x += (ring[j][0] + ring[i][0]) * f; y += (ring[j][1] + ring[i][1]) * f; a += f;
  }
  a *= 0.5; return a ? [x / (6 * a), y / (6 * a)] : ring[0];
}
export function repPoint(polys) {
  let best = polys[0], bestArea = -1;
  for (const p of polys) { const ar = Math.abs(ringArea(p.outer)); if (ar > bestArea) { bestArea = ar; best = p; } }
  const c = ringCentroid(best.outer);
  if (inRing(c, best.outer) && !best.holes.some((h) => inRing(c, h))) return c;
  const v = best.outer[0];
  return [(v[0] + c[0]) / 2, (v[1] + c[1]) / 2];
}

// --- Uniform-grid polygon index --------------------------------------------
const CELL = 0.05; // ~5km cells in degrees; empty cells cost nothing (Map-keyed)

// makePolygonIndex(features) where each feature = { id, geometry }.
// Returns { locate(lon,lat) → id|null, centroids() → Map<id,[lon,lat]> }.
export function makePolygonIndex(features) {
  const recs = [];
  const grid = new Map(); // "ix,iy" → [recIndex, ...]
  const key = (ix, iy) => `${ix},${iy}`;
  for (const f of features) {
    if (!f.geometry) continue;
    const polys = toPolys(f.geometry);
    if (!polys.length) continue;
    const bbox = ringsBbox(polys);
    const rec = { id: String(f.id), polys, bbox };
    const ri = recs.push(rec) - 1;
    const [x0, y0, x1, y1] = bbox;
    for (let ix = Math.floor(x0 / CELL); ix <= Math.floor(x1 / CELL); ix++)
      for (let iy = Math.floor(y0 / CELL); iy <= Math.floor(y1 / CELL); iy++) {
        const k = key(ix, iy);
        const bucket = grid.get(k);
        if (bucket) bucket.push(ri); else grid.set(k, [ri]);
      }
  }
  function locate(lon, lat) {
    const bucket = grid.get(key(Math.floor(lon / CELL), Math.floor(lat / CELL)));
    if (!bucket) return null;
    const pt = [lon, lat];
    for (const ri of bucket) {
      const r = recs[ri];
      if (pt[0] < r.bbox[0] || pt[0] > r.bbox[2] || pt[1] < r.bbox[1] || pt[1] > r.bbox[3]) continue;
      if (inPolys(pt, r.polys)) return r.id;
    }
    return null;
  }
  function centroids() {
    const m = new Map();
    for (const r of recs) m.set(r.id, repPoint(r.polys));
    return m;
  }
  return { locate, centroids };
}

// --- Suburb feature loader (TopoJSON per state, SAL_CODE21 as feature id) ----
const STATES = ["NSW", "VIC", "QLD", "SA", "WA", "TAS", "NT", "ACT"];
export function loadSuburbFeatures(suburbsDir) {
  const out = [];
  for (const st of STATES) {
    const file = path.join(suburbsDir, `${st}.topojson`);
    if (!fs.existsSync(file)) continue;
    const topo = JSON.parse(fs.readFileSync(file, "utf8"));
    const fc = feature(topo, topo.objects[Object.keys(topo.objects)[0]]);
    for (const f of fc.features) if (f.id && f.geometry) out.push({ id: String(f.id), geometry: f.geometry, state: st });
  }
  return out;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test web/scripts/geo/geo-index.test.mjs`
Expected: PASS — 4 tests (the haversine/nearest tests come in Task 2).

- [ ] **Step 5: Commit**

```bash
git add web/scripts/geo/geo-index.mjs web/scripts/geo/geo-index.test.mjs
git commit -m "feat(geo): grid polygon index for suburb point-in-polygon joins"
```

---

## Task 2: Nearest-point distance metric

**Files:**
- Modify: `web/scripts/geo/geo-index.mjs`
- Test: `web/scripts/geo/geo-index.test.mjs`

- [ ] **Step 1: Write the failing test (append to the existing test file)**

```js
// append to web/scripts/geo/geo-index.test.mjs
import { haversineKm, nearestPoint } from "./geo-index.mjs";

test("haversineKm matches a known distance", () => {
  // Sydney CBD → Parramatta is ~23km; assert within 1km.
  const d = haversineKm(151.2093, -33.8688, 151.0, -33.815);
  assert.ok(Math.abs(d - 21.5) < 2, `got ${d}`);
});

test("nearestPoint returns the closest point and its distance", () => {
  const pts = [
    { lon: 151.0, lat: -33.8, name: "A" },
    { lon: 152.0, lat: -34.0, name: "B" },
  ];
  const r = nearestPoint(151.05, -33.82, pts);
  assert.equal(r.point.name, "A");
  assert.ok(r.distKm < 10);
});

test("nearestPoint returns null on empty input", () => {
  assert.equal(nearestPoint(151, -33, []), null);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test web/scripts/geo/geo-index.test.mjs`
Expected: FAIL — `haversineKm is not a function`.

- [ ] **Step 3: Add the implementation (append to `geo-index.mjs`)**

```js
// append to web/scripts/geo/geo-index.mjs
// --- Distance metrics -------------------------------------------------------
export function haversineKm(lon1, lat1, lon2, lat2) {
  const R = 6371, rad = Math.PI / 180;
  const dLat = (lat2 - lat1) * rad, dLon = (lon2 - lon1) * rad;
  const a = Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1 * rad) * Math.cos(lat2 * rad) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

// nearestPoint(lon,lat, points) where each point = { lon, lat, ... }.
// Brute force — fine offline (15k suburbs × a few-k POIs). Returns
// { point, distKm } or null.
export function nearestPoint(lon, lat, points) {
  let best = null, bestD = Infinity;
  for (const p of points) {
    const d = haversineKm(lon, lat, p.lon, p.lat);
    if (d < bestD) { bestD = d; best = p; }
  }
  return best ? { point: best, distKm: bestD } : null;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test web/scripts/geo/geo-index.test.mjs`
Expected: PASS — 7 tests total.

- [ ] **Step 5: Commit**

```bash
git add web/scripts/geo/geo-index.mjs web/scripts/geo/geo-index.test.mjs
git commit -m "feat(geo): haversine nearest-point for suburb distance metrics"
```

---

## Task 3: LGA dimension + suburb_lga bridge migration

**Files:**
- Create: `services/migrations/000061_add_lga.up.sql`, `services/migrations/000061_add_lga.down.sql`

- [ ] **Step 1: Write the up migration**

```sql
-- services/migrations/000061_add_lga.up.sql
-- Local Government Area dimension (ABS ASGS Ed.3 LGA_2024) + suburb→LGA bridge.
-- ABS facts (name/area/population/growth/demographics) are CC-BY-4.0; the
-- financial columns (rates, sustainability ratios, mayor/councillors) are
-- per-state and licence-gated — they stay NULL until each state is cleared
-- (NSW "Your Council" is Crown copyright and must NOT be populated without
-- written OLG permission). See the design doc §7.
CREATE TABLE IF NOT EXISTS lga (
    lga_code24          TEXT PRIMARY KEY,        -- ABS LGA_CODE_2024
    lga_name            TEXT NOT NULL,
    state_code          TEXT NOT NULL,
    area_sqkm           NUMERIC,
    population          INTEGER,                 -- ABS ERP latest
    pop_growth_pct      NUMERIC,                 -- YoY ERP
    median_age          NUMERIC,
    median_hhd_income   INTEGER,
    pct_rented          NUMERIC,                 -- Census G37 at LGA
    aclg_group          TEXT,                    -- ACLG/OLG peer classification
    mayor               TEXT,                    -- nullable, per-state, licence-gated
    councillor_count    INTEGER,                 -- nullable
    avg_rates           NUMERIC,                 -- nullable, per-state, licence-gated
    op_surplus_ratio    NUMERIC,                 -- nullable
    asset_renewal_ratio NUMERIC,                 -- nullable
    centroid_lat        NUMERIC,
    centroid_lon        NUMERIC,
    fin_source          TEXT,                    -- financial-data provenance (per-state)
    fin_source_licence  TEXT,
    source              TEXT NOT NULL DEFAULT 'abs_asgs_2024',
    source_licence      TEXT NOT NULL DEFAULT 'CC-BY-4.0',
    fetched_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_lga_state ON lga (state_code);

-- A suburb can straddle multiple councils; dominant_lga is the best single
-- assignment (by mesh-block weight), overlap_lgas keeps the full list.
CREATE TABLE IF NOT EXISTS suburb_lga (
    sal_code     TEXT PRIMARY KEY,
    lga_code24   TEXT NOT NULL,
    overlap_lgas JSONB NOT NULL DEFAULT '[]'     -- [{ "lga_code24": "...", "share": 0.0 }]
);
CREATE INDEX IF NOT EXISTS idx_suburb_lga_lga ON suburb_lga (lga_code24);
```

- [ ] **Step 2: Write the down migration**

```sql
-- services/migrations/000061_add_lga.down.sql
DROP TABLE IF EXISTS suburb_lga;
DROP TABLE IF EXISTS lga;
```

- [ ] **Step 3: Apply and verify**

Run (DB must be up — `make dev-db` first if needed):
```bash
cd services && make migrate-up && make migrate-version
psql "postgresql://admin:password@localhost:5438/shorts" -c "\d lga" -c "\d suburb_lga"
```
Expected: version is `61`+; both tables print their columns.

- [ ] **Step 4: Commit**

```bash
git add services/migrations/000061_add_lga.up.sql services/migrations/000061_add_lga.down.sql
git commit -m "feat(db): lga dimension + suburb_lga bridge (000061)"
```

---

## Task 4: suburb_amenities migration

**Files:**
- Create: `services/migrations/000062_add_suburb_amenities.up.sql`, `.down.sql`

- [ ] **Step 1: Write the up migration**

```sql
-- services/migrations/000062_add_suburb_amenities.up.sql
-- Per-suburb amenity counts, nearest-distances, and derived lifestyle indices,
-- keyed by ABS SAL_CODE21. OSM-derived columns are aggregate counts (a Produced
-- Work under ODbL — attribution only, no share-alike); raw OSM points are never
-- stored. School location/sector/type is ACARA CC-BY; rail/health/coast are
-- Geoscience Australia CC-BY. See design doc §7.
CREATE TABLE IF NOT EXISTS suburb_amenities (
    sal_code               TEXT PRIMARY KEY,
    schools_total          INTEGER,
    schools_primary        INTEGER,
    schools_secondary      INTEGER,
    schools_gov            INTEGER,
    schools_catholic       INTEGER,
    schools_independent    INTEGER,
    nearest_secondary_km   NUMERIC,
    supermarkets_total     INTEGER,
    coles_count            INTEGER,
    woolworths_count       INTEGER,
    aldi_count             INTEGER,
    iga_count              INTEGER,
    nearest_supermarket_km NUMERIC,
    pubs_bars              INTEGER,
    clubs                  INTEGER,
    parks_count            INTEGER,
    green_space_ratio      NUMERIC,      -- park area ÷ suburb land area, 0..1
    libraries_count        INTEGER,
    nearest_train_km       NUMERIC,
    hospitals_count        INTEGER,
    gp_count               INTEGER,
    pharmacy_count         INTEGER,
    nearest_hospital_km    NUMERIC,
    dist_to_coast_km       NUMERIC,
    grocery_access_score   NUMERIC,      -- 0..100 derived
    amenity_density_score  NUMERIC,      -- 0..100 derived
    walkability_score      NUMERIC,      -- 0..100 derived
    family_friendly_score  NUMERIC,      -- 0..100 derived
    osm_source_licence     TEXT NOT NULL DEFAULT 'ODbL-1.0',
    source                 TEXT,
    source_licence         TEXT,
    fetched_at             TIMESTAMPTZ NOT NULL DEFAULT now()
);
```

- [ ] **Step 2: Write the down migration**

```sql
-- services/migrations/000062_add_suburb_amenities.down.sql
DROP TABLE IF EXISTS suburb_amenities;
```

- [ ] **Step 3: Apply and verify**

Run:
```bash
cd services && make migrate-up && make migrate-version
psql "postgresql://admin:password@localhost:5438/shorts" -c "\d suburb_amenities"
```
Expected: version `62`; table prints 30 columns.

- [ ] **Step 4: Commit**

```bash
git add services/migrations/000062_add_suburb_amenities.up.sql services/migrations/000062_add_suburb_amenities.down.sql
git commit -m "feat(db): suburb_amenities table (000062)"
```

---

## Task 5: connectivity + funding migrations

**Files:**
- Create: `services/migrations/000063_add_suburb_connectivity.up.sql`, `.down.sql`
- Create: `services/migrations/000064_add_suburb_funding.up.sql`, `.down.sql`

- [ ] **Step 1: Write 000063 up/down**

```sql
-- services/migrations/000063_add_suburb_connectivity.up.sql
-- NBN access-technology profile per suburb (CC-BY-4.0, NBN Co via DITRDCA).
-- Area-level only — never an address-level availability promise (NBN disclaimer).
CREATE TABLE IF NOT EXISTS suburb_connectivity (
    sal_code                   TEXT PRIMARY KEY,
    dominant_nbn_tech          TEXT,    -- FTTP|HFC|FTTC|FTTB|FTTN|FW|Satellite
    pct_fixed_line             NUMERIC,
    pct_fixed_wireless         NUMERIC,
    pct_satellite              NUMERIC,
    connectivity_quality_score NUMERIC, -- 0..100, tech tier weighted by address share
    pct_fttp_upgrade_eligible  NUMERIC,
    source                     TEXT NOT NULL DEFAULT 'nbn_footprint',
    source_licence             TEXT NOT NULL DEFAULT 'CC-BY-4.0',
    fetched_at                 TIMESTAMPTZ NOT NULL DEFAULT now()
);
```
```sql
-- services/migrations/000063_add_suburb_connectivity.down.sql
DROP TABLE IF EXISTS suburb_connectivity;
```

- [ ] **Step 2: Write 000064 up/down**

```sql
-- services/migrations/000064_add_suburb_funding.up.sql
-- Federal infrastructure funding mapped to a suburb (Infrastructure Investment
-- Program project coordinates → point-in-polygon). The ONLY genuinely
-- suburb-level federal funding; LGA grants live on lga.*, GST is state-level.
-- CC-BY-4.0 (DITRDCSA). See design doc §4/§7.
CREATE TABLE IF NOT EXISTS suburb_funding (
    sal_code            TEXT PRIMARY KEY,
    infra_project_count INTEGER,
    infra_committed_aud NUMERIC,      -- sum of Commonwealth contribution
    source              TEXT NOT NULL DEFAULT 'iip',
    source_licence      TEXT NOT NULL DEFAULT 'CC-BY-4.0',
    fetched_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);
```
```sql
-- services/migrations/000064_add_suburb_funding.down.sql
DROP TABLE IF EXISTS suburb_funding;
```

- [ ] **Step 3: Apply and verify**

Run:
```bash
cd services && make migrate-up && make migrate-version
psql "postgresql://admin:password@localhost:5438/shorts" -c "\dt suburb_connectivity" -c "\dt suburb_funding"
```
Expected: version `64`; both tables exist.

- [ ] **Step 4: Commit**

```bash
git add services/migrations/000063_add_suburb_connectivity.up.sql services/migrations/000063_add_suburb_connectivity.down.sql services/migrations/000064_add_suburb_funding.up.sql services/migrations/000064_add_suburb_funding.down.sql
git commit -m "feat(db): suburb_connectivity + suburb_funding tables (000063,000064)"
```

---

## Task 6: Collector amenities ingest (load JSON → rows)

**Files:**
- Create: `services/house-price-collector/amenities.go`
- Create: `services/house-price-collector/testdata/suburb-amenities.sample.json`
- Test: `services/house-price-collector/amenities_test.go`

- [ ] **Step 1: Write the fixture**

```json
// services/house-price-collector/testdata/suburb-amenities.sample.json
{
  "10001": { "schoolsTotal": 3, "schoolsPrimary": 2, "schoolsSecondary": 1, "supermarketsTotal": 2, "colesCount": 1, "woolworthsCount": 1, "pubsBars": 4, "nearestTrainKm": 0.8, "amenityDensityScore": 72.5 },
  "10002": { "schoolsTotal": 0, "supermarketsTotal": 0, "pubsBars": 0, "nearestTrainKm": 14.2, "amenityDensityScore": 6.0 }
}
```

- [ ] **Step 2: Write the failing test**

```go
// services/house-price-collector/amenities_test.go
package main

import "testing"

func TestIngestAmenitiesFromFile(t *testing.T) {
	rows, err := loadAmenities("testdata/suburb-amenities.sample.json")
	if err != nil {
		t.Fatalf("loadAmenities: %v", err)
	}
	if len(rows) != 2 {
		t.Fatalf("want 2 rows, got %d", len(rows))
	}
	by := map[string]AmenityRow{}
	for _, r := range rows {
		by[r.SALCode] = r
	}
	a := by["10001"]
	if a.SchoolsTotal == nil || *a.SchoolsTotal != 3 {
		t.Errorf("10001 schoolsTotal want 3, got %v", a.SchoolsTotal)
	}
	if a.NearestTrainKm == nil || *a.NearestTrainKm != 0.8 {
		t.Errorf("10001 nearestTrainKm want 0.8, got %v", a.NearestTrainKm)
	}
	// A suburb present with an explicit 0 keeps 0 (not nil) — count was computed.
	b := by["10002"]
	if b.SchoolsTotal == nil || *b.SchoolsTotal != 0 {
		t.Errorf("10002 schoolsTotal want 0, got %v", b.SchoolsTotal)
	}
	// Unspecified fields stay nil → NULL (not present in the source object).
	if b.ColesCount != nil {
		t.Errorf("10002 colesCount want nil, got %v", *b.ColesCount)
	}
}
```

- [ ] **Step 3: Run test to verify it fails**

Run: `cd services/house-price-collector && go test -run TestIngestAmenitiesFromFile ./...`
Expected: FAIL — `undefined: loadAmenities` / `undefined: AmenityRow`.

- [ ] **Step 4: Write the implementation**

```go
// services/house-price-collector/amenities.go
package main

import (
	"os"
	"path/filepath"
	"strings"
)

// AmenityRow is one suburb's amenity metrics (UPSERT target on suburb_amenities).
// All metric fields are pointers so an absent JSON key binds to SQL NULL while an
// explicit 0 (a real computed count) is preserved. The join/derivation lives in
// the precompute script web/scripts/geo/join-amenities.mjs (added in W1); this
// just loads its committed output.
type AmenityRow struct {
	SALCode              string
	SchoolsTotal         *int     `json:"schoolsTotal"`
	SchoolsPrimary       *int     `json:"schoolsPrimary"`
	SchoolsSecondary     *int     `json:"schoolsSecondary"`
	SchoolsGov           *int     `json:"schoolsGov"`
	SchoolsCatholic      *int     `json:"schoolsCatholic"`
	SchoolsIndependent   *int     `json:"schoolsIndependent"`
	NearestSecondaryKm   *float64 `json:"nearestSecondaryKm"`
	SupermarketsTotal    *int     `json:"supermarketsTotal"`
	ColesCount           *int     `json:"colesCount"`
	WoolworthsCount      *int     `json:"woolworthsCount"`
	AldiCount            *int     `json:"aldiCount"`
	IgaCount             *int     `json:"igaCount"`
	NearestSupermarketKm *float64 `json:"nearestSupermarketKm"`
	PubsBars             *int     `json:"pubsBars"`
	Clubs                *int     `json:"clubs"`
	ParksCount           *int     `json:"parksCount"`
	GreenSpaceRatio      *float64 `json:"greenSpaceRatio"`
	LibrariesCount       *int     `json:"librariesCount"`
	NearestTrainKm       *float64 `json:"nearestTrainKm"`
	HospitalsCount       *int     `json:"hospitalsCount"`
	GpCount              *int     `json:"gpCount"`
	PharmacyCount        *int     `json:"pharmacyCount"`
	NearestHospitalKm    *float64 `json:"nearestHospitalKm"`
	DistToCoastKm        *float64 `json:"distToCoastKm"`
	GroceryAccessScore   *float64 `json:"groceryAccessScore"`
	AmenityDensityScore  *float64 `json:"amenityDensityScore"`
	WalkabilityScore     *float64 `json:"walkabilityScore"`
	FamilyFriendlyScore  *float64 `json:"familyFriendlyScore"`
}

// amenitiesPath resolves the committed join output (sibling of the suburb
// boundary dir), overridable via AMENITIES_FILE.
func amenitiesPath() string {
	if f := strings.TrimSpace(os.Getenv("AMENITIES_FILE")); f != "" {
		return f
	}
	return filepath.Join(filepath.Dir(censusGeoDir()), "insights", "suburb-amenities.json")
}

// loadAmenities reads a { salCode: {metrics} } map into rows.
func loadAmenities(path string) ([]AmenityRow, error) {
	raw := map[string]AmenityRow{}
	if err := readJSONFile(path, &raw); err != nil {
		return nil, err
	}
	rows := make([]AmenityRow, 0, len(raw))
	for sal, r := range raw {
		r.SALCode = sal
		rows = append(rows, r)
	}
	return rows, nil
}

// ingestAmenities loads the default committed amenities file.
func ingestAmenities() ([]AmenityRow, error) { return loadAmenities(amenitiesPath()) }
```

- [ ] **Step 5: Run test to verify it passes**

Run: `cd services/house-price-collector && go test -run TestIngestAmenitiesFromFile ./...`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add services/house-price-collector/amenities.go services/house-price-collector/amenities_test.go services/house-price-collector/testdata/suburb-amenities.sample.json
git commit -m "feat(collector): amenities ingest (load suburb-amenities.json)"
```

---

## Task 7: upsertAmenities store method

**Files:**
- Modify: `services/house-price-collector/store.go`

- [ ] **Step 1: Add the upsert (append after `upsertElectorates`)**

```go
// upsertAmenities idempotently writes one suburb_amenities row per suburb
// (PK = sal_code). Nil pointer fields bind to NULL; explicit 0 counts persist.
func upsertAmenities(ctx context.Context, pool *pgxpool.Pool, rows []AmenityRow) (int, error) {
	const q = `
		INSERT INTO suburb_amenities (
			sal_code, schools_total, schools_primary, schools_secondary, schools_gov,
			schools_catholic, schools_independent, nearest_secondary_km,
			supermarkets_total, coles_count, woolworths_count, aldi_count, iga_count,
			nearest_supermarket_km, pubs_bars, clubs, parks_count, green_space_ratio,
			libraries_count, nearest_train_km, hospitals_count, gp_count, pharmacy_count,
			nearest_hospital_km, dist_to_coast_km, grocery_access_score,
			amenity_density_score, walkability_score, family_friendly_score, source, source_licence)
		VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,
			$21,$22,$23,$24,$25,$26,$27,$28,$29,$30,$31)
		ON CONFLICT (sal_code) DO UPDATE SET
			schools_total = EXCLUDED.schools_total, schools_primary = EXCLUDED.schools_primary,
			schools_secondary = EXCLUDED.schools_secondary, schools_gov = EXCLUDED.schools_gov,
			schools_catholic = EXCLUDED.schools_catholic, schools_independent = EXCLUDED.schools_independent,
			nearest_secondary_km = EXCLUDED.nearest_secondary_km,
			supermarkets_total = EXCLUDED.supermarkets_total, coles_count = EXCLUDED.coles_count,
			woolworths_count = EXCLUDED.woolworths_count, aldi_count = EXCLUDED.aldi_count,
			iga_count = EXCLUDED.iga_count, nearest_supermarket_km = EXCLUDED.nearest_supermarket_km,
			pubs_bars = EXCLUDED.pubs_bars, clubs = EXCLUDED.clubs, parks_count = EXCLUDED.parks_count,
			green_space_ratio = EXCLUDED.green_space_ratio, libraries_count = EXCLUDED.libraries_count,
			nearest_train_km = EXCLUDED.nearest_train_km, hospitals_count = EXCLUDED.hospitals_count,
			gp_count = EXCLUDED.gp_count, pharmacy_count = EXCLUDED.pharmacy_count,
			nearest_hospital_km = EXCLUDED.nearest_hospital_km, dist_to_coast_km = EXCLUDED.dist_to_coast_km,
			grocery_access_score = EXCLUDED.grocery_access_score,
			amenity_density_score = EXCLUDED.amenity_density_score,
			walkability_score = EXCLUDED.walkability_score,
			family_friendly_score = EXCLUDED.family_friendly_score,
			source = EXCLUDED.source, source_licence = EXCLUDED.source_licence, fetched_at = now()`
	batch := &pgx.Batch{}
	for _, r := range rows {
		batch.Queue(q, r.SALCode, r.SchoolsTotal, r.SchoolsPrimary, r.SchoolsSecondary, r.SchoolsGov,
			r.SchoolsCatholic, r.SchoolsIndependent, r.NearestSecondaryKm, r.SupermarketsTotal,
			r.ColesCount, r.WoolworthsCount, r.AldiCount, r.IgaCount, r.NearestSupermarketKm,
			r.PubsBars, r.Clubs, r.ParksCount, r.GreenSpaceRatio, r.LibrariesCount, r.NearestTrainKm,
			r.HospitalsCount, r.GpCount, r.PharmacyCount, r.NearestHospitalKm, r.DistToCoastKm,
			r.GroceryAccessScore, r.AmenityDensityScore, r.WalkabilityScore, r.FamilyFriendlyScore,
			"local_insights", "mixed")
	}
	br := pool.SendBatch(ctx, batch)
	defer func() { _ = br.Close() }()
	n := 0
	for range rows {
		if _, err := br.Exec(); err != nil {
			return n, err
		}
		n++
	}
	return n, nil
}
```

- [ ] **Step 2: Verify it compiles**

Run: `cd services/house-price-collector && go build ./...`
Expected: builds clean (no unused-import or arg-count errors — 31 placeholders match 31 args).

- [ ] **Step 3: Commit**

```bash
git add services/house-price-collector/store.go
git commit -m "feat(collector): upsertAmenities suburb_amenities writer"
```

---

## Task 8: Wire -mode amenities into main.go

**Files:**
- Modify: `services/house-price-collector/main.go`

- [ ] **Step 1: Add the mode case (in the `switch *mode` block, after the `electorates` case)**

```go
	case "amenities":
		// Per-suburb amenity/lifestyle metrics, spatially joined offline
		// (web/scripts/geo/join-amenities.mjs) and upserted into suburb_amenities.
		runAmenities(ctx, pool)
```

- [ ] **Step 2: Update the -mode flag usage string**

Change the flag definition line to include `amenities`:
```go
	mode := flag.String("mode", "all", "official | crawl | census | electorates | amenities | refresh | all")
```
And the default-case fatal message:
```go
		log.Fatalf("unknown -mode %q (want official|crawl|census|electorates|amenities|refresh|all)", *mode)
```

- [ ] **Step 3: Add the run function (after `runElectorates`)**

```go
// runAmenities loads the precomputed per-suburb amenity metrics and upserts
// them into suburb_amenities, recording the run cursor under "local_amenities".
func runAmenities(ctx context.Context, pool *pgxpool.Pool) {
	rows, err := ingestAmenities()
	if err != nil {
		log.Printf("[amenities] ingest error: %v", err)
		_ = updateRun(ctx, pool, "local_amenities", nil, 0, "error", err.Error())
		return
	}
	n, err := upsertAmenities(ctx, pool, rows)
	if err != nil {
		log.Printf("[amenities] upsert error after %d: %v", n, err)
		_ = updateRun(ctx, pool, "local_amenities", nil, n, "error", err.Error())
		return
	}
	log.Printf("[amenities] upserted %d", n)
	_ = updateRun(ctx, pool, "local_amenities", nil, n, "ok", "")
}
```

- [ ] **Step 4: Build + fixture round-trip against the local DB**

Run (DB up + migrations applied from Tasks 3–5):
```bash
cd services/house-price-collector && go build ./...
AMENITIES_FILE="$(pwd)/testdata/suburb-amenities.sample.json" \
  DATABASE_URL="postgresql://admin:password@localhost:5438/shorts" \
  go run . -mode amenities
psql "postgresql://admin:password@localhost:5438/shorts" \
  -c "SELECT sal_code, schools_total, supermarkets_total, nearest_train_km FROM suburb_amenities ORDER BY sal_code;"
```
Expected: log `[amenities] upserted 2`; the query returns rows `10001 | 3 | 2 | 0.8` and `10002 | 0 | 0 | 14.2`. (These sal_codes aren't real suburbs — this is the scaffold round-trip; clean up after with `DELETE FROM suburb_amenities WHERE sal_code IN ('10001','10002');`.)

- [ ] **Step 5: Commit**

```bash
git add services/house-price-collector/main.go
git commit -m "feat(collector): -mode amenities (load + upsert suburb_amenities)"
```

---

## Task 9: OSM staging gitignore + map attribution

**Files:**
- Create: `web/scripts/geo/.gitignore`
- Create: `web/src/@/components/housing/data-attribution.tsx`
- Modify: `web/src/@/components/housing/state-suburb-explorer.tsx`

- [ ] **Step 1: Ignore the raw-OSM staging dir (ODbL: derived only, never commit raw points)**

```gitignore
# web/scripts/geo/.gitignore
# Raw OSM / source extracts used by the insight join scripts — NEVER committed
# (ODbL: we publish derived per-suburb metrics only, not raw geometry).
.staging/
*.osm.pbf
*.osm
```

- [ ] **Step 2: Write a failing test for the attribution component**

```tsx
// web/src/@/components/housing/data-attribution.test.tsx
import { render, screen } from "@testing-library/react";
import { DataAttribution } from "./data-attribution";

test("renders the required OSM + ABS attributions", () => {
  render(<DataAttribution />);
  expect(screen.getByText(/OpenStreetMap contributors/i)).toBeInTheDocument();
  expect(screen.getByText(/Australian Bureau of Statistics/i)).toBeInTheDocument();
  // OSM credit must link to the copyright page (ODbL requirement).
  const osm = screen.getByRole("link", { name: /OpenStreetMap/i });
  expect(osm).toHaveAttribute("href", "https://www.openstreetmap.org/copyright");
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `cd web && npx jest src/@/components/housing/data-attribution.test.tsx`
Expected: FAIL — cannot find `./data-attribution`.

- [ ] **Step 4: Write the component**

```tsx
// web/src/@/components/housing/data-attribution.tsx
/**
 * Source + licence credits for the suburb insight layers. The OSM line is a hard
 * ODbL requirement wherever OSM-derived metrics (supermarkets, pubs, parks,
 * libraries) are shown; ABS/ACARA/Geoscience Australia/NBN are CC-BY attribution.
 */
export function DataAttribution() {
  return (
    <p className="mt-2 text-[11px] leading-relaxed text-muted-foreground">
      Sources:{" "}
      <a
        href="https://www.openstreetmap.org/copyright"
        target="_blank"
        rel="noopener noreferrer"
        className="underline hover:text-foreground"
      >
        © OpenStreetMap contributors
      </a>{" "}
      (ODbL); Australian Bureau of Statistics, ACARA, Geoscience Australia, and
      NBN Co (CC BY 4.0). Amenity figures are derived per-suburb counts, not
      address-level guarantees.
    </p>
  );
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `cd web && npx jest src/@/components/housing/data-attribution.test.tsx`
Expected: PASS.

- [ ] **Step 6: Render it under the map**

In `web/src/@/components/housing/state-suburb-explorer.tsx`, import and place the credit directly below the map container. Add near the other imports:
```tsx
import { DataAttribution } from "./data-attribution";
```
Then locate the closing tag of the map/legend block (the element wrapping `<StateSuburbMap .../>`) and add immediately after it:
```tsx
      <DataAttribution />
```
(If the file currently has no obvious single wrapper, place `<DataAttribution />` as the last child of the explorer's root container so it sits under both the list and the map.)

- [ ] **Step 7: Typecheck + verify it renders**

Run:
```bash
cd web && npx tsc --noEmit && npx eslint src/@/components/housing/data-attribution.tsx src/@/components/housing/state-suburb-explorer.tsx
```
Expected: no type or lint errors.

- [ ] **Step 8: Commit**

```bash
git add web/scripts/geo/.gitignore web/src/@/components/housing/data-attribution.tsx web/src/@/components/housing/data-attribution.test.tsx web/src/@/components/housing/state-suburb-explorer.tsx
git commit -m "feat(housing): OSM staging gitignore + map data attribution"
```

---

## Task 10: Foundation smoke + docs note

**Files:**
- Modify: `docs/feature/housing/architecture.md` (collector modes line)

- [ ] **Step 1: Run the full W0 test surface**

Run:
```bash
node --test web/scripts/geo/geo-index.test.mjs
cd services/house-price-collector && go test ./... && go vet ./...
cd ../../web && npx jest src/@/components/housing/data-attribution.test.tsx
```
Expected: all green.

- [ ] **Step 2: Update the collector modes mention in the architecture doc**

In `docs/feature/housing/architecture.md`, update the `-mode` enumeration (§5/§8 mention `official|census|electorates|crawl|refresh|all`) to include `amenities`, and add a one-line note under §8 "Manual ingest runs" that `suburb_amenities`/`lga`/`suburb_lga`/`suburb_connectivity`/`suburb_funding` (migrations 000061–000064) back the Local Insights workstreams. Keep it to ≤3 lines — full detail lives in the design doc.

- [ ] **Step 3: Commit**

```bash
git add docs/feature/housing/architecture.md
git commit -m "docs(housing): note Local Insights tables + amenities mode (W0)"
```

---

## Self-Review

**Spec coverage (vs design doc §8 W0 row):**
- spatial-index/KD-tree join harness → Tasks 1–2 (grid PIP + haversine nearest). ✓
- OSM staging + gitignore → Task 9 Step 1. ✓
- attribution credit → Task 9. ✓
- migrations 000061 + suburb_lga + empty suburb_amenities/connectivity/funding → Tasks 3–5. ✓
- collector `-mode` + updateRun scaffold → Tasks 6–8 (amenities is the working scaffold; lga/connectivity/funding/geo modes are added in their own workstreams against the same store/main pattern). ✓
- proto stubs — **intentionally deferred to W1** (proto fields are only needed when data is served; adding them in W0 would be dead churn). Noted here so it isn't read as a gap.

**Placeholder scan:** no TBD/TODO; every code step is complete and runnable.

**Type consistency:** `AmenityRow` JSON tags (camelCase) match the fixture keys and the `loadAmenities` map decode; the 31 INSERT columns ↔ 31 `$N` placeholders ↔ 31 `batch.Queue` args in `upsertAmenities` (sal_code + 28 metric fields + source + source_licence); `ingestAmenities`/`runAmenities`/`upsertAmenities` names are consistent across Tasks 6–8; `makePolygonIndex`/`locate`/`centroids`/`haversineKm`/`nearestPoint` names consistent across Tasks 1–2 and their tests.

**Acceptance (design doc W0):** harness joins a sample POI set with a correctness check (Task 1–2 unit tests) ✓; migrations apply locally (Tasks 3–5) ✓; collector mode runs end-to-end via fixture round-trip (Task 8 Step 4) ✓.
