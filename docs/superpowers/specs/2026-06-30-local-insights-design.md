# Local Insights — Suburb Amenity Enrichment + Geographic Knowledge Graph

**Status:** Approved (design) · 2026-06-30
**Author:** Ben + Claude
**Supersedes/extends:** the suburb explorer (`docs/housing-architecture.md` §5), the stock knowledge graph (`entities`/`entity_edges`).

## 1. Goal

Turn the suburb explorer from a price + census + electoral map into a rich **"what is this suburb actually like to live in"** surface, and extend the existing knowledge graph with **geographic nodes/edges** so we can answer *"which suburbs are like this one?"* and *"who is my council and which councils are its peers?"*.

New per-suburb insight families (all four bundles approved):

1. **Amenities & lifestyle** — schools, supermarkets (Coles/Woolworths/Aldi/IGA), pubs/bars, parks, libraries, train stations, hospitals/GPs, distance-to-coast.
2. **Council / LGA context** — which council, ABS council facts (area/population/growth/demographics), and (gated) rates + financial-sustainability.
3. **Connectivity / NBN** — dominant access technology + a connectivity-quality score + FTTP-upgrade eligibility.
4. **Government funding** — federal infrastructure $ that genuinely maps to a suburb, plus LGA/state grant context (honestly labelled).

Plus the **geographic knowledge graph**: `suburb`/`lga`/`state`/`brand` nodes and `in_lga`/`in_state`/`has_brand`/`similar_to`/`peer_of` edges, powering a "similar suburbs" + "your council & peers" Connections card.

### Success criteria
- Each insight family appears as (a) one or more map "Colour by" metrics and (b) a profile-page card.
- A new `GetSuburbGraph` RPC backs a `suburb-connections.tsx` card showing the most-similar suburbs and the suburb's council + peer councils.
- All published data is licence-clean (see §7); OSM contributes derived counts only, with attribution.
- No regression to the existing housing/suburb surfaces.

## 2. Current state (from the codebase audit)

**Knowledge graph (already generic).** `entities` (`id`, `type` TEXT, `canonical_name`, `normalized_name`, `stock_code` TEXT **nullable**, `attrs` JSONB; unique `(type, normalized_name)`) + `entity_edges` (`src_id`, `dst_id`, `edge_type`, `weight`, `attrs`, `source`; unique `(src_id, dst_id, edge_type)`; indexes on `(src_id, edge_type)` and `(dst_id, edge_type)`). Migrations `000047`/`000048`. Today only `company`/`person` nodes and `officer_of`/`directs`/`similar_to` edges. Backfilled by `services/shorts/cmd/graph-backfill/main.go`; `similar_to` weights from pgvector kNN in `news-aggregator/company_embeddings.go`. Served by `GetStockGraph` (`postgres_graph.go`, two-query pattern) → `web/.../company/stock-connections.tsx`. **The model hosts geographic nodes/edges with no schema change.**

**Suburb explorer.** `suburb_demographics` (PK `sal_code` = ABS SAL_CODE21) carries census (`000055`), culture (`000057`), federal (`000058`), state district (`000059`), state member (`000060`). `house_price_regions` bridges to it via `sal_code`. `region_type='lga'` is declared in the schema/proto but **no LGA boundaries or data are shipped**. There are **no** amenity/school/council/funding/connectivity fields.

**UI surfacing.** `web/src/@/lib/housing/highlight-metrics.ts` — `HIGHLIGHT_METRICS` registry (continuous: `amberScale`/custom `makeScale`; categorical: `colorFor`+`order`; `null`→hatch). `choropleth-map.tsx` routes `valueById`+`colorScale` (continuous) vs `categoryById`+`categoryColor` (categorical). `suburb-profile.tsx` renders `DemoGroup` cards + `CompareBar` (vs state/national from `ComparisonBaselines`) + `FederalRep`. `suburb-tooltip.tsx` shows a `SuburbSummary` subset. Adding a metric = extend `SuburbSummary`/`SuburbDemographics` proto → register a `HIGHLIGHT_METRICS` entry → (optional) profile card.

**Ingest.** `services/house-price-collector` `-mode official|census|electorates|crawl|refresh|all`. `census.go` reads the ABS GCP SAL DataPack + uses the boundary TopoJSON (`web/public/geo/suburbs/<ST>.topojson`, `SAL_CODE21`) as the authoritative suburb registry. `electorates.go` loads **precomputed** spatial-join JSON from `web/public/geo/electorates/` (built by `web/scripts/geo/join-electorates.mjs`/`join-sed.mjs` — centroid point-in-polygon ray-casting). `store.go` upserts via `ON CONFLICT (sal_code)` on the **txn pooler :6543** with `QueryExecModeSimpleProtocol`; `updateRun` tracks per-source cursors.

## 3. Architecture

One pipeline shape per dataset, mirroring the electorates flow:

```
Acquire (download / Overpass / ArcGIS REST → PRIVATE staging)
  → Join   (point-in-polygon → SAL suburb; mesh-block crosswalk → LGA;
            precomputed in web/scripts/geo/*.mjs → committed {salCode|lgaCode → metrics} JSON)
  → Store  (new tables keyed by sal_code / lga_code24, upserted by the collector)
  → Serve  (extended SuburbSummary/SuburbDemographics + new RPCs)
  → Surface (HIGHLIGHT_METRICS + profile cards + Connections card)
```

### 3.1 Spatial-join harness (the one new piece of infra)

The existing `.mjs` joins map *suburb-centroid → division*. POIs are the inverse: ~80k points → 15k suburb polygons. Naïve O(n·m) ray-casting is too slow, so the harness adds a spatial index:

- **Point-in-polygon counts** — build a polygon index over the SAL boundaries (`which-polygon` or a bounding-box grid), look up each POI's suburb in O(log m). Aggregate `COUNT`/`SUM`/`AVG` per `sal_code`.
- **Nearest-distance metrics** (nearest train station, nearest hospital, dist-to-coast) — build a KD-tree (`kdbush`) over POI points (or turf line-distance for the Smartline coastline) and query from each suburb centroid.
- Output one committed JSON per dataset under `web/public/geo/insights/` (e.g. `suburb-amenities.json`, `suburb-lga.json`, `suburb-connectivity.json`). **Derived numbers only — never raw OSM geometry** (see §7).

No PostGIS dependency — keeps the "precompute → commit JSON → upsert" idiom. (PostGIS is noted as a future option if join volume grows.)

### 3.2 Collector modes

Add `-mode amenities`, `-mode lga`, `-mode connectivity`, `-mode funding`, `-mode geo` (graph backfill). Each: load the committed JSON → upsert into its table → `updateRun`. `census.go`'s suburb-registry bootstrap (TopoJSON `SAL_CODE21`) is reused as the canonical sal_code list.

## 4. Data model (new tables — census stays clean)

Illustrative DDL (final columns settle per-workstream). Every table carries `source` + `source_licence` (per field-group where licences differ) + `fetched_at`.

```sql
-- LGA dimension (migration 000061)
CREATE TABLE lga (
  lga_code24      TEXT PRIMARY KEY,          -- ABS LGA_CODE_2024
  lga_name        TEXT NOT NULL,
  state_code      TEXT NOT NULL,
  area_sqkm       DOUBLE PRECISION,
  population       INTEGER,                   -- ABS ERP latest
  pop_growth_pct  DOUBLE PRECISION,          -- YoY ERP
  median_age      DOUBLE PRECISION,
  median_hhd_income INTEGER,
  pct_rented      DOUBLE PRECISION,          -- Census G37 at LGA
  aclg_group      TEXT,                      -- ACLG/OLG peer classification
  mayor           TEXT,                      -- nullable, per-state
  councillor_count INTEGER,                  -- nullable
  avg_rates       DOUBLE PRECISION,          -- nullable, per-state, licence-gated
  op_surplus_ratio DOUBLE PRECISION,         -- nullable
  asset_renewal_ratio DOUBLE PRECISION,      -- nullable
  centroid_lat    DOUBLE PRECISION,
  centroid_lon    DOUBLE PRECISION,
  fin_source      TEXT, fin_source_licence TEXT,   -- financials provenance (per-state)
  source TEXT, source_licence TEXT, fetched_at TIMESTAMPTZ DEFAULT now()
);

-- suburb → LGA bridge (a suburb can straddle councils)
CREATE TABLE suburb_lga (
  sal_code     TEXT PRIMARY KEY REFERENCES suburb_demographics(sal_code),
  lga_code24   TEXT NOT NULL REFERENCES lga(lga_code24),  -- dominant by mesh-block weight
  overlap_lgas JSONB DEFAULT '[]'                         -- [{lga_code24, share}]
);

-- amenities + lifestyle (migration 000062)
CREATE TABLE suburb_amenities (
  sal_code              TEXT PRIMARY KEY REFERENCES suburb_demographics(sal_code),
  schools_total         INTEGER, schools_primary INTEGER, schools_secondary INTEGER,
  schools_gov INTEGER, schools_catholic INTEGER, schools_independent INTEGER,
  nearest_secondary_km  DOUBLE PRECISION,
  supermarkets_total    INTEGER, coles_count INTEGER, woolworths_count INTEGER,
  aldi_count INTEGER, iga_count INTEGER, nearest_supermarket_km DOUBLE PRECISION,
  pubs_bars             INTEGER, clubs INTEGER,
  parks_count           INTEGER, green_space_ratio DOUBLE PRECISION,
  libraries_count       INTEGER,
  nearest_train_km      DOUBLE PRECISION,
  hospitals_count INTEGER, gp_count INTEGER, pharmacy_count INTEGER,
  nearest_hospital_km   DOUBLE PRECISION,
  dist_to_coast_km      DOUBLE PRECISION,
  -- derived indices (0-100, computed at ingest)
  grocery_access_score  DOUBLE PRECISION,
  amenity_density_score DOUBLE PRECISION,
  walkability_score     DOUBLE PRECISION,
  family_friendly_score DOUBLE PRECISION,
  osm_source_licence TEXT DEFAULT 'ODbL-1.0',
  source TEXT, source_licence TEXT, fetched_at TIMESTAMPTZ DEFAULT now()
);

-- connectivity (migration 000063)
CREATE TABLE suburb_connectivity (
  sal_code            TEXT PRIMARY KEY REFERENCES suburb_demographics(sal_code),
  dominant_nbn_tech   TEXT,                  -- FTTP|HFC|FTTC|FTTB|FTTN|FW|Satellite
  pct_fixed_line DOUBLE PRECISION, pct_fixed_wireless DOUBLE PRECISION, pct_satellite DOUBLE PRECISION,
  connectivity_quality_score DOUBLE PRECISION,  -- 0-100, tech-tier weighted by address share
  pct_fttp_upgrade_eligible  DOUBLE PRECISION,
  source TEXT, source_licence TEXT, fetched_at TIMESTAMPTZ DEFAULT now()
);

-- funding (migration 000064)
CREATE TABLE suburb_funding (
  sal_code            TEXT PRIMARY KEY REFERENCES suburb_demographics(sal_code),
  infra_project_count INTEGER,              -- IIP projects PIP into suburb
  infra_committed_aud DOUBLE PRECISION,     -- Cwlth contribution sum
  source TEXT, source_licence TEXT, fetched_at TIMESTAMPTZ DEFAULT now()
);
-- LGA grants live on lga.*; GST/state context in a tiny state_facts table or constants.
```

## 5. Geographic knowledge graph (reuses `entities`/`entity_edges`)

**Nodes** (coarse — POIs/schools stay as counts, not nodes):
- `suburb` (`normalized_name=sal_code`, `attrs`: state, postcode, lat/lon, headline price/pop)
- `lga` (`normalized_name=lga_code24`, `attrs`: state, aclg_group, population)
- `state` (`normalized_name=state_code`)
- `brand` (`normalized_name` = `coles|woolworths|aldi|iga`)

**Edges:**
- `suburb —in_lga→ lga` (weight = mesh-block overlap share)
- `lga —in_state→ state`
- `suburb —has_brand→ brand` (weight = store count) — powers "duopoly-only suburbs" cuts
- `suburb —similar_to→ suburb` (weight = similarity; top-K)
- `lga —peer_of→ lga` (same ACLG peer group)

**Similar suburbs = explainable feature-vector kNN** (not LLM embeddings): z-score a feature vector per suburb (median price, income, age, dwelling density, born-overseas, amenity-density, grocery/walkability scores, dominant culture one-hots), compute top-K nearest by Euclidean/cosine in Go, store as `similar_to` edges with `attrs` listing the top contributing dimensions (so the UI can say *"similar on price, schools, and cultural mix"*). LLM-embedding semantic search is a later layer, not this build.

**Backfill:** extend `graph-backfill` with `backfillSuburbs/LGAs/Brands/SimilarSuburbs/PeerCouncils` (reads `suburb_demographics` + `suburb_amenities` + `suburb_lga` + `lga`). Idempotent `ON CONFLICT` upserts, same as the company/person path.

**Serve:** `GetSuburbGraph(sal_code, limit)` → `{ similarSuburbs:[{salCode,name,state,similarity,medianPrice,sharedDimensions[]}], council:{lga, mayor, peers:[…]}, brands:[{brand,count}] }`. Frontend: new `web/src/@/components/housing/suburb-connections.tsx`, embedded in `suburb-profile.tsx`.

## 6. API + frontend surface

**Proto** (`shorts.proto`): extend `SuburbSummary` (a handful of headline fields used by map metrics + tooltip: e.g. `schools_total`, `supermarkets_total`, `nearest_train_km`, `amenity_density_score`, `dominant_nbn_tech`, `connectivity_quality_score`, `lga_name`) and `SuburbDemographics`/profile response (full amenity/council/connectivity/funding detail). Add `GetSuburbGraph` RPC + messages. Regenerate (`buf generate`) — 4-layer store pattern (store iface, adapter, mock, postgres impl) for any new store methods.

**Highlight metrics** (`highlight-metrics.ts`) — new entries:
- Continuous: `schools` (per-1000), `supermarkets`, `amenity_density`, `green_space`, `nearest_train`, `connectivity_quality`, `infra_funding`.
- Categorical: `nbn_tech` (FTTP/HFC/…/Satellite palette), `grocery_competition` (duopoly vs Aldi/IGA present), `council` (colour by LGA — categorical), optionally `school_mix`.

**Profile cards** (`suburb-profile.tsx`): new `AmenitiesCard`, `CouncilCard` ("your council" + facts + financials when present, clearly labelled LGA-level), `ConnectivityCard` (tech mix donut + score), `FundingCard` (suburb infra $ + LGA/state context with honest labels), and the `SuburbConnections` card.

**Attribution:** add a credits line to the map/footer: "© OpenStreetMap contributors" + ABS/ACARA/Geoscience Australia/NBN Co source acknowledgements.

## 7. Licensing guardrails (load-bearing)

| Source | Licence | Posture |
|--------|---------|---------|
| ACARA Australian Schools List (location/sector/type) | CC-BY-4.0 | Publish derived counts. Attribute ACARA. |
| ACARA My School (ICSEA, enrolments) | My School ToS — **non-commercial, no public republish** | **Excluded.** Optional per-state CC-BY (NSW CESE master dataset, CC-BY 3.0 AU) if ICSEA wanted later. |
| OSM (supermarkets, pubs, parks, libraries) | **ODbL-1.0** | **Derived per-suburb counts/indices only** (a "Produced Work" — attribution, no share-alike). Raw points → **private staging, never committed/served.** Keep OSM-derived columns separable. Map credit: "© OpenStreetMap contributors". |
| ABS (LGA boundaries, ERP, Census-at-LGA, SAL) | CC-BY-4.0 | Publish. Attribute ABS. |
| Geoscience Australia (rail stations, HealthDirect facilities, Smartline coast) | CC-BY-4.0 | Publish. Attribute GA. |
| NBN footprint (via DITRDCA) | CC-BY-4.0 | Publish area-level tech/score; **never present as address-level availability** (NBN disclaimer). |
| Council financials — VIC Know Your Council | CC-BY-4.0 | Publish (VIC first). |
| Council financials — **NSW "Your Council" (OLG)** | **Crown copyright, all rights reserved** | **Gated** — not published until OLG written permission cleared. Schema columns ship NULL for NSW meanwhile. |
| Council financials — QLD/WA/SA/TAS/NT | mixed per-state | Verify each before publishing; ship as cleared. |
| Federal funding (IIP, R2R, FAGs, GST) | CC-BY-4.0 | Publish with honest granularity labels (suburb vs LGA vs state). |

**Hard rules:** (1) raw OSM geometry is never committed to the repo or served by the API; (2) the OSM-derived layer stays separable so share-alike can never reach CC-BY or proprietary data; (3) brand store-locator data (proprietary ToS) is **not** blended into the OSM layer; (4) council-financial columns are populated per-state only as each state's licence is cleared, NSW gated.

## 8. Workstreams (each its own implementation plan + PR)

| # | Workstream | Deliverables | Depends on | Acceptance |
|---|-----------|--------------|------------|-----------|
| **W0** | **Foundation** | spatial-index/KD-tree join harness in `web/scripts/geo/`; OSM staging + `.gitignore`; attribution credit component; migrations `000061`+`suburb_lga` and empty `suburb_amenities`/`suburb_connectivity`/`suburb_funding`; collector `-mode` skeletons + `updateRun`; proto stubs. | — | Harness joins a sample POI set to SAL with a correctness check; migrations apply locally; collector modes run no-op. |
| **W1** | **Amenities & lifestyle** | ingest schools (ACARA), supermarkets+pubs+parks+libraries (OSM), rail/health/coast (GA); compute counts/distances/indices; `suburb-amenities.json`; upsert; map metrics + `AmenitiesCard`. | W0 | Each amenity metric renders on the map + card; counts sanity-checked vs known suburbs; OSM attribution visible. |
| **W2** | **Council / LGA** | LGA boundaries + mesh-block crosswalk → `suburb_lga`; ABS LGA facts → `lga`; VIC financials (NSW gated); `CouncilCard` + LGA map metrics. | W0 | "Your council" chip on every profile; straddle-LGA handled; financials labelled + licence-gated. |
| **W3** | **Connectivity / NBN** | NBN footprint intersect → tech mix + quality score + FTTP eligibility; `suburb-connectivity.json`; metric + `ConnectivityCard`. | W0 | `nbn_tech` categorical map + quality continuous map; address-level disclaimer present. |
| **W4** | **Funding** | IIP projects PIP → `suburb_funding`; LGA grants on `lga`; state GST context; `FundingCard` with honest labels. | W0, W2 | Suburb infra $ metric; LGA/state context clearly not-suburb-specific. |
| **W5** | **Geographic graph** | suburb/lga/state/brand nodes + edges; feature-vector `similar_to`; `peer_of`; `GetSuburbGraph` RPC; `SuburbConnections` card. | W1, W2 | "Similar suburbs" returns sensible neighbours with shared-dimension explanations; council + peers shown. |

**Sequencing:** W0 first. W1–W3 then proceed largely in parallel (independent data). W4 after W2 (needs LGA). W5 last (needs amenity + LGA data for similarity + council edges). Each workstream is independently shippable and adds visible value.

## 9. Prod-ops (per the housing pattern)
- DDL on prod Supabase via **session pooler :5432** + `PGOPTIONS="-c statement_timeout=0"`; collector bulk upserts on **txn pooler :6543** + `SimpleProtocol`.
- Manual ingest runs per mode (same as census/electorates); the Cloud Run Job wiring (terraform) is deferred with the existing collector wiring TODO.
- Re-pull cadence: OSM monthly (Geofabrik extract), ACARA quarterly, ABS/NBN on release.

## 10. Risks & open questions
- **Spatial-join performance** — validate the `which-polygon`/`kdbush` harness on the full national POI set in W0 before committing to it; PostGIS is the fallback.
- **OSM completeness skew** (metro-strong, remote-weak) — surface "0" as informative, caveat sparse-rural counts.
- **LGA straddle** — dominant-LGA by mesh-block weight is the default; the overlap list is retained for correctness.
- **Council-financial licence clearance** (NSW) is a real external dependency — W2 ships VIC + ABS facts regardless; NSW financials land when cleared.
- **My School exclusion** means school *quality* (ICSEA) is absent in v1 — acceptable; revisit with per-state CC-BY.

## 11. Out of scope (this program)
- Crime/safety (state-fragmented, no national consistency) — future.
- Pokies/EGM density (needs NSW liquor register) — future, pairs with pubs.
- Per-state GTFS multi-modal transit (8 portals) — rail-station proxy now; GTFS later.
- LLM semantic suburb search / mobile (5G) coverage — future layers.
