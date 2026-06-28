# Housing Map & Suburb Drilldown Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the placeholder Voronoi suburb map with real ABS boundary choropleths and a national → state → suburb drilldown (clickable, breadcrumbed, pinch-zoomable), enriched with ABS Census demographics.

**Architecture:** Static per-state ABS TopoJSON in `web/public/geo/` rendered by one shared `<ChoroplethMap>` core (d3-geo + d3-zoom, SVG). Census demographics ingested into a new `suburb_demographics` table keyed by ABS SAL code; bridged to existing price data via a `sal_code` column. Three URL levels (`/housing`, `/housing/[state]`, `/housing/[state]/[suburb]`) served by new Connect-RPC endpoints following the repo's existing housing patterns.

**Tech Stack:** Next.js 14 App Router, d3-geo/d3-zoom/topojson-client, @visx/responsive, Go Connect-RPC, Postgres (pgx), protobuf/buf, golang-migrate, ABS ASGS 2021 + Census 2021 (CC-BY).

**Branch:** `feat/housing-suburb-map` (already created off `feat/house-price-tracker`; spec at `docs/superpowers/specs/2026-06-28-housing-suburb-map-design.md`).

**Commit hygiene:** Frontend-only commits use `git commit --no-verify` (the pre-commit hook spins up DB+backend and OOMs on golangci-lint); run `cd web && npx tsc --noEmit && npx eslint <changed>` manually first. Backend commits run the hook normally. Only ever `git add` the specific paths in each task — the working tree has unrelated SDK/build cruft that must never be staged.

---

## Phase 1 — Geo pipeline + shared ChoroplethMap core + national map

*Independent of the new backend. Ships a real, pinch-zoomable national states map on `/housing` wired to the existing `GetHousingOverview` data.*

### Task 1: Add map dependencies

**Files:**
- Modify: `web/package.json`

- [ ] **Step 1: Install runtime + build deps**

Run from repo root (one install covers every narrow import used later in the plan — d3-geo/zoom/scale/scale-chromatic, topojson runtime + types):
```bash
cd web && npm install d3-geo@^3.1.1 d3-zoom@^3.0.0 d3-scale@^4.0.2 d3-scale-chromatic@^3.1.0 topojson-client@^3.1.0 && npm install -D mapshaper@^0.6.102 topojson-specification@^1.0.31 @types/geojson@^7946.0.14 @types/topojson-client@^3.1.5 @types/d3-geo@^3.1.0 @types/d3-zoom@^3.0.8 @types/d3-scale@^4.0.8 @types/d3-scale-chromatic@^3.0.3
```
Expected: `package.json` gains these deps; `package-lock.json` updates. (`d3-selection` is already a dep; `d3-geo`/`d3-zoom`/`d3-scale` also exist transitively via the `d3` umbrella but we add explicit entries for stable narrow imports.)

- [ ] **Step 2: Verify install**

Run: `cd web && node -e "require('topojson-client'); require('d3-geo'); require('d3-zoom'); console.log('ok')"`
Expected: prints `ok`.

- [ ] **Step 3: Commit**

```bash
git add web/package.json web/package-lock.json
git commit --no-verify -m "build(housing): add d3-geo/d3-zoom/topojson-client + mapshaper for boundary maps"
```

---

### Task 2: Boundary build script + generated TopoJSON

**Files:**
- Create: `web/scripts/geo/build-boundaries.mjs`
- Create: `web/scripts/geo/README.md`
- Create (generated, committed): `web/public/geo/states.topojson`, `web/public/geo/suburbs/{NSW,VIC,QLD,SA,WA,TAS,NT,ACT}.topojson`

- [ ] **Step 1: Document + acquire ABS source files**

Create `web/scripts/geo/README.md`:
```markdown
# AU boundary build

Generates the TopoJSON the housing map renders, from ABS ASGS Edition 3 (2021),
CC-BY 4.0.

## Inputs (download once into `web/scripts/geo/src/`, gitignored)

From https://www.abs.gov.au/statistics/standards/australian-statistical-geography-standard-asgs-edition-3/jul2021-jun2026/access-and-downloads/digital-boundary-files :
- "States and Territories - 2021 - Shapefile" → unzip → `src/STE_2021_AUST_GDA2020.shp` (+ siblings)
- "Suburbs and Localities - 2021 - Shapefile" → unzip → `src/SAL_2021_AUST_GDA2020.shp` (+ siblings)

## Build

    node web/scripts/geo/build-boundaries.mjs

Outputs committed TopoJSON to `web/public/geo/`. Re-run only when ABS releases a
new edition (rare).

## Attributes used
- STE: `STE_CODE21`, `STE_NAME21`
- SAL: `SAL_CODE21`, `SAL_NAME21`, `STE_NAME21`, `STE_CODE21`
```

Download the two shapefiles into `web/scripts/geo/src/` as documented.

- [ ] **Step 2: Add `src/` to gitignore**

Append to `web/.gitignore` (create the line if absent):
```
/scripts/geo/src/
```

- [ ] **Step 3: Write the build script**

Create `web/scripts/geo/build-boundaries.mjs`:
```js
// Builds committed TopoJSON for the housing map from ABS ASGS 2021 shapefiles.
// States -> public/geo/states.topojson ; Suburbs split per state -> public/geo/suburbs/<STATE>.topojson
// Run: node web/scripts/geo/build-boundaries.mjs
import { execSync } from "node:child_process";
import { mkdirSync, existsSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const SRC = resolve(here, "src");
const OUT = resolve(here, "../../public/geo");
const OUT_SUBURBS = resolve(OUT, "suburbs");
const STATES = ["NSW", "VIC", "QLD", "SA", "WA", "TAS", "NT", "ACT"];
const MAX_BYTES = 1_400_000; // per-state suburb file budget

const mapshaper = (args) =>
  execSync(`npx mapshaper ${args}`, { stdio: "inherit", cwd: here });

function ensure(path) { if (!existsSync(path)) { console.error(`MISSING input: ${path} — see README`); process.exit(1); } }

mkdirSync(OUT_SUBURBS, { recursive: true });
ensure(resolve(SRC, "STE_2021_AUST_GDA2020.shp"));
ensure(resolve(SRC, "SAL_2021_AUST_GDA2020.shp"));

// States: simplify hard, keep code+name, id = STE_CODE21
mapshaper(
  `-i "${resolve(SRC, "STE_2021_AUST_GDA2020.shp")}" ` +
  `-simplify 4% keep-shapes -filter "STE_CODE21 !== '9'" ` + // drop "Other Territories"
  `-each "this.id = STE_CODE21" ` +
  `-o "${resolve(OUT, "states.topojson")}" format=topojson id-field=STE_CODE21 ` +
  `drop-table fields=STE_CODE21,STE_NAME21 quantization=1e4`
);

// Suburbs: per state, simplify, id = SAL_CODE21, keep name + state
for (const st of STATES) {
  mapshaper(
    `-i "${resolve(SRC, "SAL_2021_AUST_GDA2020.shp")}" ` +
    `-filter "STE_NAME21 === '${stateFullName(st)}'" ` +
    `-simplify 8% keep-shapes ` +
    `-each "this.id = SAL_CODE21" ` +
    `-o "${resolve(OUT_SUBURBS, st + ".topojson")}" format=topojson id-field=SAL_CODE21 ` +
    `fields=SAL_CODE21,SAL_NAME21,STE_CODE21 quantization=1e4`
  );
  const f = resolve(OUT_SUBURBS, st + ".topojson");
  const bytes = statSync(f).size;
  console.log(`${st}: ${(bytes / 1024).toFixed(0)} KB`);
  if (bytes > MAX_BYTES) console.warn(`  ⚠ ${st} exceeds ${MAX_BYTES} bytes — raise -simplify % for this state`);
}

function stateFullName(code) {
  return ({ NSW: "New South Wales", VIC: "Victoria", QLD: "Queensland",
    SA: "South Australia", WA: "Western Australia", TAS: "Tasmania",
    NT: "Northern Territory", ACT: "Australian Capital Territory" })[code];
}
console.log("done");
```

- [ ] **Step 4: Generate the TopoJSON**

Run: `node web/scripts/geo/build-boundaries.mjs`
Expected: prints per-state KB sizes and `done`; creates `web/public/geo/states.topojson` and 8 files under `web/public/geo/suburbs/`. No state should warn over budget (raise its `-simplify %` if it does).

- [ ] **Step 5: Sanity-check the output shape**

Run: `node -e "const t=require('./web/public/geo/states.topojson'); const o=Object.keys(t.objects)[0]; console.log(o, t.objects[o].geometries.length, t.objects[o].geometries[0].id)"`
Expected: prints an object name, `8` geometries, and a numeric state id (e.g. `1`).

- [ ] **Step 6: Commit**

```bash
git add web/scripts/geo/build-boundaries.mjs web/scripts/geo/README.md web/.gitignore web/public/geo/states.topojson web/public/geo/suburbs/
git commit --no-verify -m "feat(housing): ABS ASGS 2021 boundary build script + generated TopoJSON"
```

---

### Task 3: Shared `<ChoroplethMap>` core

**Files:**
- Create: `web/src/@/components/housing/choropleth-map.tsx`
- Create: `web/src/@/components/housing/use-topojson.ts`
- Test: `web/src/@/components/housing/__tests__/choropleth-map.test.tsx`

- [ ] **Step 1: Write the TopoJSON lazy-load hook**

Create `web/src/@/components/housing/use-topojson.ts`:
```ts
"use client";

import { useQuery } from "@tanstack/react-query";
import type { Topology } from "topojson-specification";

/** Lazy-fetch + cache a committed TopoJSON asset from /public/geo. */
export function useTopojson(url: string | null) {
  return useQuery({
    queryKey: ["topojson", url],
    enabled: !!url,
    staleTime: Infinity,
    gcTime: Infinity,
    queryFn: async (): Promise<Topology> => {
      const res = await fetch(url!);
      if (!res.ok) throw new Error(`topojson ${url}: ${res.status}`);
      return res.json();
    },
  });
}
```

- [ ] **Step 2: Write the failing test for the value→color mapping helper**

Create `web/src/@/components/housing/__tests__/choropleth-map.test.tsx`:
```tsx
import { describe, it, expect } from "@jest/globals";
import { featureFill } from "../choropleth-map";

describe("featureFill", () => {
  const color = (v: number) => (v > 100 ? "#f00" : "#0f0");
  it("returns the hatch sentinel when value is null/undefined", () => {
    expect(featureFill(null, color)).toBe("url(#nodata-hatch)");
    expect(featureFill(undefined, color)).toBe("url(#nodata-hatch)");
  });
  it("applies the colour scale to a real value", () => {
    expect(featureFill(150, color)).toBe("#f00");
    expect(featureFill(50, color)).toBe("#0f0");
  });
});
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `cd web && npx jest choropleth-map -t featureFill`
Expected: FAIL — `featureFill` is not exported / module not found.

- [ ] **Step 4: Implement the ChoroplethMap core**

Create `web/src/@/components/housing/choropleth-map.tsx`:
```tsx
"use client";

import { useEffect, useMemo, useRef } from "react";
import { geoMercator, geoPath } from "d3-geo";
import { zoom as d3zoom, zoomIdentity } from "d3-zoom";
import { select } from "d3-selection";
import { feature } from "topojson-client";
import type { Topology, GeometryCollection } from "topojson-specification";
import type { Feature, Geometry } from "geojson";
import { ParentSize } from "@visx/responsive";

/** Fill for a feature: hatch sentinel when no data, else the colour scale. */
export function featureFill(
  value: number | null | undefined,
  colorScale: (v: number) => string,
): string {
  if (value === null || value === undefined) return "url(#nodata-hatch)";
  return colorScale(value);
}

export interface ChoroplethMapProps {
  topology: Topology;
  objectName: string;
  /** keyed by feature id (string) → metric value, or null for "no data". */
  valueById: Map<string, number | null>;
  /** id → display name for accessibility / hover routing. */
  nameById?: Map<string, string>;
  colorScale: (v: number) => string;
  selectedId?: string;
  onFeatureClick?: (id: string) => void;
  onFeatureHover?: (id: string | null, evt?: React.PointerEvent) => void;
  height?: number;
  ariaLabel: string;
}

export function ChoroplethMap(props: ChoroplethMapProps) {
  return (
    <div style={{ width: "100%", height: props.height ?? 460 }}>
      <ParentSize>{({ width, height }) =>
        width > 0 ? <ChoroplethInner {...props} width={width} height={height} /> : null
      }</ParentSize>
    </div>
  );
}

function ChoroplethInner({
  topology, objectName, valueById, nameById, colorScale, selectedId,
  onFeatureClick, onFeatureHover, width, height, ariaLabel,
}: ChoroplethMapProps & { width: number; height: number }) {
  const svgRef = useRef<SVGSVGElement>(null);
  const gRef = useRef<SVGGElement>(null);

  const { features, pathFor } = useMemo(() => {
    const obj = topology.objects[objectName] as GeometryCollection;
    const fc = feature(topology, obj) as unknown as { features: Feature<Geometry>[] };
    const projection = geoMercator().fitSize([width, height], {
      type: "FeatureCollection", features: fc.features,
    } as never);
    const path = geoPath(projection);
    return { features: fc.features, pathFor: (f: Feature<Geometry>) => path(f) ?? "" };
  }, [topology, objectName, width, height]);

  // Pinch-zoom + pan via d3-zoom (touch pinch supported natively).
  useEffect(() => {
    if (!svgRef.current || !gRef.current) return;
    const g = select(gRef.current);
    const zoomBehavior = d3zoom<SVGSVGElement, unknown>()
      .scaleExtent([1, 12])
      .on("zoom", (e) => g.attr("transform", e.transform.toString()));
    const svg = select(svgRef.current);
    svg.call(zoomBehavior);
    svg.on("dblclick.zoom", null);
    return () => { svg.on(".zoom", null); };
  }, [width, height]);

  return (
    <svg ref={svgRef} width={width} height={height} role="img" aria-label={ariaLabel}
      style={{ touchAction: "none", display: "block" }}>
      <defs>
        <pattern id="nodata-hatch" width={6} height={6} patternUnits="userSpaceOnUse"
          patternTransform="rotate(45)">
          <rect width={6} height={6} fill="var(--muted)" />
          <line x1={0} y1={0} x2={0} y2={6} stroke="var(--border)" strokeWidth={1} />
        </pattern>
      </defs>
      <g ref={gRef}>
        {features.map((f) => {
          const id = String(f.id);
          const v = valueById.get(id);
          const selected = id === selectedId;
          return (
            <path
              key={id}
              d={pathFor(f)}
              fill={featureFill(v, colorScale)}
              stroke={selected ? "var(--foreground)" : "var(--border)"}
              strokeWidth={selected ? 1.5 : 0.4}
              style={{ cursor: onFeatureClick ? "pointer" : "default", outline: "none" }}
              tabIndex={onFeatureClick ? 0 : -1}
              aria-label={nameById?.get(id) ?? id}
              onClick={() => onFeatureClick?.(id)}
              onKeyDown={(e) => { if (e.key === "Enter") onFeatureClick?.(id); }}
              onPointerMove={(e) => onFeatureHover?.(id, e)}
              onPointerLeave={() => onFeatureHover?.(null)}
            />
          );
        })}
      </g>
    </svg>
  );
}
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `cd web && npx jest choropleth-map -t featureFill`
Expected: PASS (2 assertions).

- [ ] **Step 6: Typecheck**

Run: `cd web && npx tsc --noEmit`
Expected: no errors in the new files. (If `topojson-specification`/`geojson` types are missing, add `npm i -D @types/geojson topojson-specification` and re-run.)

- [ ] **Step 7: Commit**

```bash
git add web/src/@/components/housing/choropleth-map.tsx web/src/@/components/housing/use-topojson.ts web/src/@/components/housing/__tests__/choropleth-map.test.tsx
git commit --no-verify -m "feat(housing): shared d3-geo ChoroplethMap core with pinch-zoom + lazy topojson hook"
```

---

### Task 4: National states map on `/housing` (clickable → state)

**Files:**
- Create: `web/src/@/components/housing/national-housing-map.tsx`
- Create: `web/src/@/components/housing/national-housing-map-loader.tsx`
- Create: `web/src/@/lib/housing/states.ts`
- Modify: `web/src/app/housing/page.tsx`

- [ ] **Step 1: State code/name/slug lookup**

Create `web/src/@/lib/housing/states.ts`:
```ts
/** ABS STE_CODE21 (string) → state code; plus slug/name helpers. */
export const STE_CODE_TO_STATE: Record<string, string> = {
  "1": "NSW", "2": "VIC", "3": "QLD", "4": "SA",
  "5": "WA", "6": "TAS", "7": "NT", "8": "ACT",
};
export const STATE_TO_STE_CODE: Record<string, string> = Object.fromEntries(
  Object.entries(STE_CODE_TO_STATE).map(([k, v]) => [v, k]),
);
export const STATE_NAMES: Record<string, string> = {
  NSW: "New South Wales", VIC: "Victoria", QLD: "Queensland", SA: "South Australia",
  WA: "Western Australia", TAS: "Tasmania", NT: "Northern Territory", ACT: "Australian Capital Territory",
};
export const ALL_STATES = ["NSW", "VIC", "QLD", "SA", "WA", "TAS", "NT", "ACT"];
export const stateSlug = (code: string) => code.toLowerCase();
export const slugToState = (slug: string) =>
  ALL_STATES.find((s) => s.toLowerCase() === slug.toLowerCase()) ?? null;
/** GCCSA region_code (from GetHousingOverview) → state, e.g. '1GSYD' → NSW. */
export const GCCSA_TO_STATE: Record<string, string> = {
  "1GSYD": "NSW", "2GMEL": "VIC", "3GBRI": "QLD", "4GADE": "SA",
  "5GPER": "WA", "6GHOB": "TAS", "7GDAR": "NT", "8ACTE": "ACT",
};
```

- [ ] **Step 2: National map component**

Create `web/src/@/components/housing/national-housing-map.tsx`:
```tsx
"use client";

import { useMemo } from "react";
import { useRouter } from "next/navigation";
import { scaleSequential } from "d3-scale";
import { interpolateBlues } from "d3-scale-chromatic";
import { ChoroplethMap } from "./choropleth-map";
import { useTopojson } from "./use-topojson";
import { STE_CODE_TO_STATE, STATE_NAMES, stateSlug } from "@/lib/housing/states";

/** value keyed by STE_CODE21 (the topojson feature id). */
export function NationalHousingMap({
  valueByStateCode,
}: {
  /** state code (NSW…) → metric value (e.g. median price). */
  valueByStateCode: Map<string, number>;
}) {
  const router = useRouter();
  const { data: topo } = useTopojson("/geo/states.topojson");

  const valueById = useMemo(() => {
    const m = new Map<string, number | null>();
    for (const [steCode, state] of Object.entries(STE_CODE_TO_STATE)) {
      const v = valueByStateCode.get(state);
      m.set(steCode, v ?? null);
    }
    return m;
  }, [valueByStateCode]);

  const nameById = useMemo(() => {
    const m = new Map<string, string>();
    for (const [steCode, state] of Object.entries(STE_CODE_TO_STATE)) m.set(steCode, STATE_NAMES[state]);
    return m;
  }, []);

  const colorScale = useMemo(() => {
    const vals = [...valueByStateCode.values()];
    const max = Math.max(1, ...vals);
    return scaleSequential(interpolateBlues).domain([0, max]);
  }, [valueByStateCode]);

  if (!topo) return <div className="h-[460px] w-full animate-pulse rounded-xl bg-muted" />;

  const objectName = Object.keys(topo.objects)[0]!;
  return (
    <ChoroplethMap
      topology={topo}
      objectName={objectName}
      valueById={valueById}
      nameById={nameById}
      colorScale={(v) => colorScale(v)}
      ariaLabel="Australian states by median house price — click a state to drill in"
      onFeatureClick={(steCode) => {
        const state = STE_CODE_TO_STATE[steCode];
        if (state) router.push(`/housing/${stateSlug(state)}`);
      }}
    />
  );
}
```
(Imports `scaleSequential`/`interpolateBlues` from the `d3` umbrella — if narrow imports fail, change to `from "d3-scale"`/`"d3-scale-chromatic"` and `npm i d3-scale d3-scale-chromatic @types/d3-scale @types/d3-scale-chromatic`.)

- [ ] **Step 3: ssr:false loader**

Create `web/src/@/components/housing/national-housing-map-loader.tsx`:
```tsx
"use client";

import dynamic from "next/dynamic";

export const NationalHousingMap = dynamic(
  () => import("./national-housing-map").then((m) => m.NationalHousingMap),
  { ssr: false, loading: () => <div className="h-[460px] w-full animate-pulse rounded-xl bg-muted" /> },
);
```

- [ ] **Step 4: Mount on `/housing` with state values from the existing overview**

In `web/src/app/housing/page.tsx`, after the `capitals` derivation, build a state-value map and render the map. Add the import at top:
```tsx
import { NationalHousingMap } from "@/components/housing/national-housing-map-loader";
import { GCCSA_TO_STATE } from "@/lib/housing/states";
```
Inside `HousingPage`, after `const capitals = ...`:
```tsx
  // Map GCCSA medians onto their state for the national choropleth.
  const valueByStateCode = new Map<string, number>();
  for (const m of capitals) {
    const st = GCCSA_TO_STATE[m.regionCode];
    if (st) valueByStateCode.set(st, m.value);
  }
```
Add a new section just above the "Capital-city medians" section:
```tsx
            <section className="space-y-3">
              <h2 className="font-serif text-2xl text-foreground">Explore by state</h2>
              <p className="text-sm text-muted-foreground">
                Shaded by greater-capital median house price. Click a state to drill into its suburbs.
              </p>
              <div className="rounded-xl border border-border bg-card p-3">
                <NationalHousingMap valueByStateCode={valueByStateCode} />
              </div>
            </section>
```

- [ ] **Step 5: Typecheck + lint**

Run: `cd web && npx tsc --noEmit && npx eslint src/@/components/housing/national-housing-map.tsx src/@/components/housing/national-housing-map-loader.tsx src/@/lib/housing/states.ts src/app/housing/page.tsx`
Expected: no errors.

- [ ] **Step 6: Verify in the running app**

Start the app (`make dev` from repo root, or `cd web && npm run dev`), confirm the LISTEN pid is yours: `lsof -nP -iTCP:3020 -sTCP:LISTEN`. Navigate to `http://localhost:3020/housing`. Expected: a map of Australia's states renders, states shaded by price, hovering shows the cursor pointer, pinch/scroll zooms and drags pan, clicking a state navigates to `/housing/<state>` (404 until Phase 4 — that's expected now). Screenshot before/after via Playwright MCP.

- [ ] **Step 7: Commit**

```bash
git add web/src/@/components/housing/national-housing-map.tsx web/src/@/components/housing/national-housing-map-loader.tsx web/src/@/lib/housing/states.ts web/src/app/housing/page.tsx
git commit --no-verify -m "feat(housing): national states choropleth on /housing, click-to-drill"
```

---

## Phase 2 — Census demographics ingestion

*Adds the `suburb_demographics` table (every AU SAL suburb), the `sal_code` bridge, and the collector ingester. DB + Go only.*

### Task 5: Migration `000055_add_suburb_demographics`

**Files:**
- Create: `services/migrations/000055_add_suburb_demographics.up.sql`
- Create: `services/migrations/000055_add_suburb_demographics.down.sql`

> Migration number is **000055**, not 000054 — `feat/residential-housing-crawl` already claims `000054_housing_licence_gate`, and `000053` is doubly used. Confirm before creating: `ls services/migrations | sort | tail -5`.

- [ ] **Step 1: Write the up migration**

Create `services/migrations/000055_add_suburb_demographics.up.sql`:
```sql
-- Suburb demographics from ABS Census 2021 (General Community Profile, SAL level),
-- keyed by ABS SAL_CODE21. CC-BY-4.0. The authoritative AU suburb registry for the
-- housing map (every SAL suburb appears here; price is joined in via sal_code).

CREATE TABLE IF NOT EXISTS suburb_demographics (
    sal_code                 TEXT PRIMARY KEY,        -- ABS SAL_CODE21
    sal_name                 TEXT NOT NULL,
    state_code               TEXT NOT NULL,           -- 'NSW' | 'VIC' | ...
    postcode                 TEXT,
    population               INTEGER,
    median_age               NUMERIC,
    median_weekly_hhd_income NUMERIC,                 -- median weekly household income
    median_weekly_per_income NUMERIC,                 -- median weekly personal income
    median_weekly_rent       NUMERIC,
    median_monthly_mortgage  NUMERIC,
    pct_owned_outright       NUMERIC,                 -- 0..100
    pct_owned_mortgage       NUMERIC,
    pct_rented               NUMERIC,
    dwelling_count           INTEGER,
    census_year              INTEGER NOT NULL DEFAULT 2021,
    source                   TEXT NOT NULL DEFAULT 'abs_census_2021_gcp',
    source_licence           TEXT NOT NULL DEFAULT 'CC-BY-4.0',
    fetched_at               TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_suburb_demographics_state ON suburb_demographics (state_code);
CREATE INDEX IF NOT EXISTS idx_suburb_demographics_name  ON suburb_demographics (sal_name);

-- Bridge existing priced regions (house_price_regions) to their SAL suburb.
ALTER TABLE house_price_regions ADD COLUMN IF NOT EXISTS sal_code TEXT;
CREATE INDEX IF NOT EXISTS idx_house_price_regions_sal ON house_price_regions (sal_code);
```

- [ ] **Step 2: Write the down migration**

Create `services/migrations/000055_add_suburb_demographics.down.sql`:
```sql
DROP INDEX IF EXISTS idx_house_price_regions_sal;
ALTER TABLE house_price_regions DROP COLUMN IF EXISTS sal_code;
DROP TABLE IF EXISTS suburb_demographics;
```

- [ ] **Step 3: Apply locally**

Run: `cd services && make migrate-up`
Expected: migrates to version 55, no error. Verify: `psql postgresql://admin:password@localhost:5438/shorts -c "\d suburb_demographics"` shows the table.

- [ ] **Step 4: Commit**

```bash
git add services/migrations/000055_add_suburb_demographics.up.sql services/migrations/000055_add_suburb_demographics.down.sql
git commit -m "feat(housing): migration 000055 — suburb_demographics + sal_code bridge"
```

---

### Task 6: Census ingester in the collector

**Files:**
- Create: `services/house-price-collector/census.go`
- Modify: `services/house-price-collector/main.go`
- Modify: `services/house-price-collector/store.go`

- [ ] **Step 1: Verify the ABS Census SAL data source (spike — capture the real columns)**

The ABS Data API exposes Census 2021 as SDMX. Confirm the SAL "Selected Medians and Averages" + "Selected Person/Dwelling counts" dataflows and capture real headers before writing the parser. Run:
```bash
# List Census dataflows (find the *_SAL General Community Profile tables)
curl -s -H "User-Agent: shorted-housing/1.0 (+https://shorted.com.au)" \
  "https://data.api.abs.gov.au/rest/dataflow/ABS?detail=allstubs" | grep -iE "census|C21|SAL|medians" | head -40
# Inspect one dataflow's structure (replace <FLOW> with the medians-by-SAL flow id found above)
curl -s -H "User-Agent: shorted-housing/1.0 (+https://shorted.com.au)" \
  -H "Accept: application/vnd.sdmx.data+csv;labels=both" \
  "https://data.api.abs.gov.au/rest/data/ABS,<FLOW>/all?startPeriod=2021&dimensionAtObservation=AllDimensions" | head -5
```
Record: the dataflow id(s), the dimension that carries the SAL region, and the measure codes for median_age / median weekly household income / median weekly personal income / median weekly rent / median monthly mortgage / population / dwelling count / tenure. Put these into the constants in Step 2.

> If the SDMX Census tables are not usable at SAL granularity, fall back to the ABS Census **GCP DataPack** (zipped CSV per SAL) — download once, parse the `G02`/`G01`/`G33` CSVs offline, and adapt `ingestCensus` to read those local files (still emitting `CensusRow`). Note the chosen path in the commit message.

- [ ] **Step 2: Write the census ingester (returns demographic rows, not Observations)**

Create `services/house-price-collector/census.go` (fill the `census*` constants from Step 1; the parser uses the existing `absColIndex`/`absCode`/`cell` helpers from `abs.go`):
```go
package main

import (
	"context"
	"strconv"
	"strings"
)

// CensusRow is one suburb's ABS Census 2021 demographic record (SAL level).
type CensusRow struct {
	SALCode               string
	SALName               string
	StateCode             string
	Postcode              string
	Population            *int
	MedianAge             *float64
	MedianWeeklyHhdIncome *float64
	MedianWeeklyPerIncome *float64
	MedianWeeklyRent      *float64
	MedianMonthlyMortgage *float64
	PctOwnedOutright      *float64
	PctOwnedMortgage      *float64
	PctRented             *float64
	DwellingCount         *int
}

// Confirmed in Step 1 against the ABS Data API. Each is an ABS dataflow id.
const (
	censusMediansFlow = "C21_G02_SAL" // Selected Medians and Averages by SAL — CONFIRM in Step 1
	censusCountsFlow  = "C21_G01_SAL" // Selected person/dwelling/tenure counts by SAL — CONFIRM in Step 1
)

// ingestCensus pulls ABS Census 2021 SAL demographics. It fetches the medians and
// the counts dataflows and merges them per SAL_CODE21.
func ingestCensus(ctx context.Context) ([]CensusRow, error) {
	byCode := map[string]*CensusRow{}

	medians, err := fetchABSCSV(ctx, censusMediansFlow, "all", "2021")
	if err != nil {
		return nil, err
	}
	mergeCensusMedians(medians, byCode)

	counts, err := fetchABSCSV(ctx, censusCountsFlow, "all", "2021")
	if err != nil {
		return nil, err
	}
	mergeCensusCounts(counts, byCode)

	out := make([]CensusRow, 0, len(byCode))
	for _, r := range byCode {
		if r.SALCode == "" {
			continue
		}
		out = append(out, *r)
	}
	return out, nil
}

// row(...) is the labelled-CSV helper: given a header index map, pull a SAL code
// + label from the region column. Column names come from Step 1.
func getOrInit(byCode map[string]*CensusRow, salCode, salName, state, postcode string) *CensusRow {
	r := byCode[salCode]
	if r == nil {
		r = &CensusRow{SALCode: salCode, SALName: salName, StateCode: state, Postcode: postcode}
		byCode[salCode] = r
	}
	return r
}

func fptr(s string) *float64 {
	v, err := strconv.ParseFloat(strings.TrimSpace(s), 64)
	if err != nil {
		return nil
	}
	return &v
}
func iptr(s string) *int {
	v, err := strconv.Atoi(strings.TrimSpace(s))
	if err != nil {
		return nil
	}
	return &v
}

// mergeCensusMedians / mergeCensusCounts parse the labelled-CSV header (via
// absColIndex) and assign measures per row. Column keys (left of ':') are taken
// from the real headers captured in Step 1 — adjust the string literals to match.
func mergeCensusMedians(rows [][]string, byCode map[string]*CensusRow) {
	if len(rows) < 2 {
		return
	}
	idx := absColIndex(rows[0])
	for _, row := range rows[1:] {
		salCode := absCode(cell(row, idx["SAL"]))      // region dimension key — CONFIRM
		if salCode == "" {
			continue
		}
		r := getOrInit(byCode, salCode, absLabel(cell(row, idx["SAL"])), "", "")
		if v := fptr(cell(row, idx["MEDIAN_AGE"])); v != nil {        // CONFIRM measure keys
			r.MedianAge = v
		}
		if v := fptr(cell(row, idx["MEDIAN_HH_INC_WEEKLY"])); v != nil {
			r.MedianWeeklyHhdIncome = v
		}
		if v := fptr(cell(row, idx["MEDIAN_PER_INC_WEEKLY"])); v != nil {
			r.MedianWeeklyPerIncome = v
		}
		if v := fptr(cell(row, idx["MEDIAN_RENT_WEEKLY"])); v != nil {
			r.MedianWeeklyRent = v
		}
		if v := fptr(cell(row, idx["MEDIAN_MORTGAGE_MONTHLY"])); v != nil {
			r.MedianMonthlyMortgage = v
		}
	}
}

func mergeCensusCounts(rows [][]string, byCode map[string]*CensusRow) {
	if len(rows) < 2 {
		return
	}
	idx := absColIndex(rows[0])
	for _, row := range rows[1:] {
		salCode := absCode(cell(row, idx["SAL"]))
		if salCode == "" {
			continue
		}
		r := getOrInit(byCode, salCode, absLabel(cell(row, idx["SAL"])), "", "")
		if v := iptr(cell(row, idx["TOT_P"])); v != nil {            // CONFIRM measure keys
			r.Population = v
		}
		if v := iptr(cell(row, idx["TOT_DWELLINGS"])); v != nil {
			r.DwellingCount = v
		}
		if v := fptr(cell(row, idx["PCT_OWNED_OUTRIGHT"])); v != nil {
			r.PctOwnedOutright = v
		}
		if v := fptr(cell(row, idx["PCT_OWNED_MORTGAGE"])); v != nil {
			r.PctOwnedMortgage = v
		}
		if v := fptr(cell(row, idx["PCT_RENTED"])); v != nil {
			r.PctRented = v
		}
	}
}
```

- [ ] **Step 3: Add the demographics upsert + run wiring to store.go**

Add to `services/house-price-collector/store.go`:
```go
// upsertDemographics idempotently writes Census suburb demographics (PK = sal_code).
func upsertDemographics(ctx context.Context, pool *pgxpool.Pool, rows []CensusRow) (int, error) {
	const q = `
		INSERT INTO suburb_demographics
			(sal_code, sal_name, state_code, postcode, population, median_age,
			 median_weekly_hhd_income, median_weekly_per_income, median_weekly_rent,
			 median_monthly_mortgage, pct_owned_outright, pct_owned_mortgage,
			 pct_rented, dwelling_count)
		VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
		ON CONFLICT (sal_code) DO UPDATE SET
			sal_name = EXCLUDED.sal_name, state_code = EXCLUDED.state_code,
			postcode = COALESCE(EXCLUDED.postcode, suburb_demographics.postcode),
			population = EXCLUDED.population, median_age = EXCLUDED.median_age,
			median_weekly_hhd_income = EXCLUDED.median_weekly_hhd_income,
			median_weekly_per_income = EXCLUDED.median_weekly_per_income,
			median_weekly_rent = EXCLUDED.median_weekly_rent,
			median_monthly_mortgage = EXCLUDED.median_monthly_mortgage,
			pct_owned_outright = EXCLUDED.pct_owned_outright,
			pct_owned_mortgage = EXCLUDED.pct_owned_mortgage,
			pct_rented = EXCLUDED.pct_rented,
			dwelling_count = EXCLUDED.dwelling_count, fetched_at = now()`
	batch := &pgx.Batch{}
	for _, r := range rows {
		batch.Queue(q, r.SALCode, r.SALName, r.StateCode, nullStr(r.Postcode),
			r.Population, r.MedianAge, r.MedianWeeklyHhdIncome, r.MedianWeeklyPerIncome,
			r.MedianWeeklyRent, r.MedianMonthlyMortgage, r.PctOwnedOutright,
			r.PctOwnedMortgage, r.PctRented, r.DwellingCount)
	}
	br := pool.SendBatch(ctx, batch)
	defer br.Close()
	n := 0
	for range rows {
		if _, err := br.Exec(); err != nil {
			return n, err
		}
		n++
	}
	return n, nil
}

func nullStr(s string) any {
	if strings.TrimSpace(s) == "" {
		return nil
	}
	return s
}
```
(Ensure `strings` is imported in store.go; add it if not.)

- [ ] **Step 4: Add the `census` mode to main.go**

In `services/house-price-collector/main.go`, update the flag usage string and switch:
```go
	mode := flag.String("mode", "all", "official | crawl | census | refresh | all")
```
Add a case before `default`:
```go
	case "census":
		runCensus(ctx, pool)
```
And add `runCensus` near `runOfficial`:
```go
// runCensus ingests ABS Census 2021 SAL demographics into suburb_demographics.
// 5-yearly data — run manually / one-off, not on the daily scheduler.
func runCensus(ctx context.Context, pool *pgxpool.Pool) {
	rows, err := ingestCensus(ctx)
	if err != nil {
		log.Printf("[census] ingest error: %v", err)
		_ = updateRun(ctx, pool, "abs_census", nil, 0, "error", err.Error())
		return
	}
	n, err := upsertDemographics(ctx, pool, rows)
	if err != nil {
		log.Printf("[census] upsert error after %d: %v", n, err)
		_ = updateRun(ctx, pool, "abs_census", nil, n, "error", err.Error())
		return
	}
	log.Printf("[census] upserted %d suburb demographics", n)
	_ = updateRun(ctx, pool, "abs_census", nil, n, "ok", "")
}
```

- [ ] **Step 5: Build the collector**

Run: `cd services && go build -o /tmp/hpc ./house-price-collector/`
Expected: compiles cleanly.

- [ ] **Step 6: Run the backfill locally + sanity check**

Run: `cd services && DATABASE_URL=postgresql://admin:password@localhost:5438/shorts go run ./house-price-collector/ -mode census`
Expected: `[census] upserted N suburb demographics` with N in the thousands. Verify:
```bash
psql postgresql://admin:password@localhost:5438/shorts -c "SELECT count(*), count(population), count(median_weekly_hhd_income) FROM suburb_demographics;"
```
Expected: a few thousand rows with mostly-populated columns. If columns are all NULL, the column keys in `census.go` don't match the real ABS headers — fix them per Step 1's captured headers and re-run.

- [ ] **Step 7: Commit**

```bash
git add services/house-price-collector/census.go services/house-price-collector/main.go services/house-price-collector/store.go
git commit -m "feat(housing): ABS Census 2021 SAL demographics ingester (census mode)"
```

---

### Task 7: Backfill `house_price_regions.sal_code` (price↔SAL bridge)

**Files:**
- Create: `services/migrations/000056_backfill_region_sal_code.up.sql`
- Create: `services/migrations/000056_backfill_region_sal_code.down.sql`

- [ ] **Step 1: Write the name+state match backfill**

Create `services/migrations/000056_backfill_region_sal_code.up.sql`:
```sql
-- Link priced suburbs (house_price_regions, region_type='suburb') to their ABS
-- SAL via normalised name + state. Imperfect by design — unmatched rows keep a
-- NULL sal_code and simply won't paint/merge with demographics.
UPDATE house_price_regions r
SET sal_code = d.sal_code
FROM suburb_demographics d
WHERE r.sal_code IS NULL
  AND r.region_type = 'suburb'
  AND r.state_code = d.state_code
  AND upper(trim(r.region_name)) = upper(trim(d.sal_name));
```

- [ ] **Step 2: Write the down**

Create `services/migrations/000056_backfill_region_sal_code.down.sql`:
```sql
UPDATE house_price_regions SET sal_code = NULL WHERE region_type = 'suburb';
```

- [ ] **Step 3: Apply + measure match rate**

Run: `cd services && make migrate-up`
Then quantify (don't assert "most matched" — measure it):
```bash
psql postgresql://admin:password@localhost:5438/shorts -c "SELECT count(*) total, count(sal_code) matched FROM house_price_regions WHERE region_type='suburb';"
```
Expected: prints the match count. Record it in the commit message. (A low rate is acceptable — demographics still cover all suburbs; price simply won't merge for unmatched ones.)

- [ ] **Step 4: Commit**

```bash
git add services/migrations/000056_backfill_region_sal_code.up.sql services/migrations/000056_backfill_region_sal_code.down.sql
git commit -m "feat(housing): backfill house_price_regions.sal_code (matched N/total suburbs)"
```

---

## Phase 3 — Suburb data RPCs (ListStateSuburbs + GetSuburbProfile)

### Task 8: Proto definitions + generate

**Files:**
- Modify: `proto/shortedapi/shorts/v1alpha1/shorts.proto`
- Generated: `web/src/gen/...`, `services/gen/...`

- [ ] **Step 1: Add the two RPCs to `service ShortedStocksService`**

In `proto/shortedapi/shorts/v1alpha1/shorts.proto`, after the `GetHousePriceSeries` rpc, add:
```proto
  // List all suburbs in a state with latest median price + key demographics.
  rpc ListStateSuburbs (ListStateSuburbsRequest) returns (ListStateSuburbsResponse) {
    option (shortedapi.options.v1.visibility) = VISIBILITY_PUBLIC;
    option (gnostic.openapi.v3.operation) = {
      summary: "List State Suburbs",
      description: "Every suburb (ABS SAL) in a state with its latest median house price and key ABS Census demographics — powers the state choropleth + suburb list."
    };
  }

  // Full per-suburb profile: identity, demographics, headline price, comparison baselines.
  rpc GetSuburbProfile (GetSuburbProfileRequest) returns (GetSuburbProfileResponse) {
    option (shortedapi.options.v1.visibility) = VISIBILITY_PUBLIC;
    option (gnostic.openapi.v3.operation) = {
      summary: "Get Suburb Profile",
      description: "A single suburb's rich profile — ABS Census demographics, latest median house price with QoQ/YoY, and state/national comparison baselines."
    };
  }
```

- [ ] **Step 2: Add the messages after `GetHousePriceSeriesResponse`**

```proto
message ListStateSuburbsRequest {
  string state_code = 1; // 'NSW' | 'VIC' | ... (required)
  string query = 2;      // optional case-insensitive name substring
  int32 limit = 3;       // optional; default 5000
}

// One suburb summary for the map + list (keyed by ABS SAL code).
message SuburbSummary {
  string sal_code = 1;
  string sal_name = 2;
  string state_code = 3;
  string postcode = 4;
  double latest_median_price = 5;            // 0 if no price data
  google.protobuf.Timestamp latest_period = 6;
  double yoy_pct = 7;
  int32  population = 8;
  double median_age = 9;
  double median_weekly_hhd_income = 10;
}

message ListStateSuburbsResponse {
  repeated SuburbSummary suburbs = 1;
}

message GetSuburbProfileRequest {
  string sal_code = 1; // required
}

message SuburbDemographics {
  int32  population = 1;
  double median_age = 2;
  double median_weekly_hhd_income = 3;
  double median_weekly_per_income = 4;
  double median_weekly_rent = 5;
  double median_monthly_mortgage = 6;
  double pct_owned_outright = 7;
  double pct_owned_mortgage = 8;
  double pct_rented = 9;
  int32  dwelling_count = 10;
  int32  census_year = 11;
}

// State + national reference medians for the profile's comparison bars.
message ComparisonBaselines {
  double state_median_price = 1;
  double national_median_price = 2;
  double state_median_weekly_hhd_income = 3;
  double national_median_weekly_hhd_income = 4;
}

message GetSuburbProfileResponse {
  SuburbSummary summary = 1;
  SuburbDemographics demographics = 2;
  ComparisonBaselines baselines = 3;
}
```

- [ ] **Step 3: Generate**

Run: `cd proto && buf generate`
Expected: `web/src/gen/shorts/v1alpha1/shorts_pb.ts` and the Go `services/gen/...` gain `ListStateSuburbs`/`GetSuburbProfile` types and `listStateSuburbs`/`getSuburbProfile` on the service. Verify: `grep -c "ListStateSuburbs" web/src/gen/shorts/v1alpha1/shorts_pb.ts` returns > 0.

- [ ] **Step 4: Commit**

```bash
git add proto/shortedapi/shorts/v1alpha1/shorts.proto web/src/gen services/gen
git commit --no-verify -m "feat(housing): ListStateSuburbs + GetSuburbProfile proto + generated code"
```

---

### Task 9: Store layer — queries + 4-layer wiring

**Files:**
- Modify: `services/shorts/internal/store/shorts/postgres_house_prices.go`
- Modify: `services/shorts/internal/store/shorts/store.go`
- Modify: `services/shorts/internal/services/shorts/interfaces.go`
- Modify: `services/shorts/internal/services/shorts/adapters.go`
- Modify: `services/shorts/internal/services/shorts/cache.go`
- Modify: `services/shorts/internal/services/shorts/mocks/mock_interfaces.go`

- [ ] **Step 1: Add row structs + queries to `postgres_house_prices.go`**

Append:
```go
// SuburbSummaryRow is a suburb for the state map/list (SAL-spined, price LEFT-joined).
type SuburbSummaryRow struct {
	SALCode               string
	SALName               string
	StateCode             string
	Postcode              string
	LatestMedianPrice     float64
	LatestPeriod          *time.Time
	YoYPct                float64
	Population             int32
	MedianAge             float64
	MedianWeeklyHhdIncome float64
}

// SuburbProfileRow is the full per-suburb profile (demographics + headline price).
type SuburbProfileRow struct {
	Summary SuburbSummaryRow
	// full demographics
	MedianWeeklyPerIncome float64
	MedianWeeklyRent      float64
	MedianMonthlyMortgage float64
	PctOwnedOutright      float64
	PctOwnedMortgage      float64
	PctRented             float64
	DwellingCount         int32
	CensusYear            int32
	// baselines
	StateMedianPrice           float64
	NationalMedianPrice        float64
	StateMedianHhdIncome       float64
	NationalMedianHhdIncome    float64
}

// ListStateSuburbs returns every SAL suburb in a state, LEFT JOINed to its latest
// median price (via the sal_code bridge) and headline demographics.
func (s *postgresStore) ListStateSuburbs(stateCode, query string, limit int32) ([]*SuburbSummaryRow, error) {
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	if limit <= 0 || limit > 20000 {
		limit = 5000
	}
	const q = `
		SELECT d.sal_code, d.sal_name, d.state_code, COALESCE(d.postcode, ''),
		       COALESCE(h.value, 0), h.period, COALESCE(h.yoy_pct, 0),
		       COALESCE(d.population, 0), COALESCE(d.median_age, 0),
		       COALESCE(d.median_weekly_hhd_income, 0)
		FROM suburb_demographics d
		LEFT JOIN house_price_regions r ON r.sal_code = d.sal_code AND r.region_type = 'suburb'
		LEFT JOIN mv_housing_headline h ON h.region_code = r.region_code
		       AND h.measure = 'median_price'
		WHERE d.state_code = $1
		  AND ($2 = '' OR d.sal_name ILIKE '%' || $2 || '%')
		ORDER BY d.sal_name
		LIMIT $3`
	rows, err := s.db.Query(ctx, q, stateCode, query, limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []*SuburbSummaryRow
	for rows.Next() {
		var r SuburbSummaryRow
		if err := rows.Scan(&r.SALCode, &r.SALName, &r.StateCode, &r.Postcode,
			&r.LatestMedianPrice, &r.LatestPeriod, &r.YoYPct,
			&r.Population, &r.MedianAge, &r.MedianWeeklyHhdIncome); err != nil {
			return nil, err
		}
		out = append(out, &r)
	}
	return out, rows.Err()
}

// GetSuburbProfile returns one suburb's full demographics + headline price +
// state/national comparison baselines.
func (s *postgresStore) GetSuburbProfile(salCode string) (*SuburbProfileRow, error) {
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	const q = `
		SELECT d.sal_code, d.sal_name, d.state_code, COALESCE(d.postcode, ''),
		       COALESCE(h.value, 0), h.period, COALESCE(h.yoy_pct, 0),
		       COALESCE(d.population, 0), COALESCE(d.median_age, 0),
		       COALESCE(d.median_weekly_hhd_income, 0),
		       COALESCE(d.median_weekly_per_income, 0), COALESCE(d.median_weekly_rent, 0),
		       COALESCE(d.median_monthly_mortgage, 0), COALESCE(d.pct_owned_outright, 0),
		       COALESCE(d.pct_owned_mortgage, 0), COALESCE(d.pct_rented, 0),
		       COALESCE(d.dwelling_count, 0), COALESCE(d.census_year, 2021),
		       COALESCE((SELECT avg(value) FROM mv_housing_headline sh JOIN house_price_regions sr
		                 ON sr.region_code = sh.region_code
		                 WHERE sr.state_code = d.state_code AND sr.region_type = 'suburb'
		                 AND sh.measure = 'median_price'), 0),
		       COALESCE((SELECT value FROM mv_housing_headline WHERE region_code = 'AUS'
		                 AND measure = 'median_price' LIMIT 1), 0),
		       COALESCE((SELECT avg(median_weekly_hhd_income) FROM suburb_demographics
		                 WHERE state_code = d.state_code), 0),
		       COALESCE((SELECT avg(median_weekly_hhd_income) FROM suburb_demographics), 0)
		FROM suburb_demographics d
		LEFT JOIN house_price_regions r ON r.sal_code = d.sal_code AND r.region_type = 'suburb'
		LEFT JOIN mv_housing_headline h ON h.region_code = r.region_code AND h.measure = 'median_price'
		WHERE d.sal_code = $1
		LIMIT 1`
	var p SuburbProfileRow
	row := s.db.QueryRow(ctx, q, salCode)
	if err := row.Scan(
		&p.Summary.SALCode, &p.Summary.SALName, &p.Summary.StateCode, &p.Summary.Postcode,
		&p.Summary.LatestMedianPrice, &p.Summary.LatestPeriod, &p.Summary.YoYPct,
		&p.Summary.Population, &p.Summary.MedianAge, &p.Summary.MedianWeeklyHhdIncome,
		&p.MedianWeeklyPerIncome, &p.MedianWeeklyRent, &p.MedianMonthlyMortgage,
		&p.PctOwnedOutright, &p.PctOwnedMortgage, &p.PctRented, &p.DwellingCount, &p.CensusYear,
		&p.StateMedianPrice, &p.NationalMedianPrice, &p.StateMedianHhdIncome, &p.NationalMedianHhdIncome,
	); err != nil {
		return nil, err
	}
	return &p, nil
}
```
(If `QueryRow` returns `pgx.ErrNoRows` for a missing suburb, the handler maps it to `CodeNotFound` — see Task 10.)

- [ ] **Step 2: Wire the `Store` interface (`store/shorts/store.go`)**

Under the `// House-price tracker methods` group add:
```go
	ListStateSuburbs(stateCode, query string, limit int32) ([]*SuburbSummaryRow, error)
	GetSuburbProfile(salCode string) (*SuburbProfileRow, error)
```

- [ ] **Step 3: Wire the `ShortsStore` interface + `Cache` interface (`services/shorts/interfaces.go`)**

Under the house-price group (types prefixed `shortsstore.`):
```go
	ListStateSuburbs(stateCode, query string, limit int32) ([]*shortsstore.SuburbSummaryRow, error)
	GetSuburbProfile(salCode string) (*shortsstore.SuburbProfileRow, error)
```
In the `Cache` interface add:
```go
	GetStateSuburbsKey(stateCode, query string, limit int32) string
	GetSuburbProfileKey(salCode string) string
```

- [ ] **Step 4: Wire `StoreAdapter` passthrough (`adapters.go`)**

```go
func (s *StoreAdapter) ListStateSuburbs(stateCode, query string, limit int32) ([]*shorts.SuburbSummaryRow, error) {
	return s.store.ListStateSuburbs(stateCode, query, limit)
}

func (s *StoreAdapter) GetSuburbProfile(salCode string) (*shorts.SuburbProfileRow, error) {
	return s.store.GetSuburbProfile(salCode)
}
```

- [ ] **Step 5: Cache-key impls (`cache.go`)**

```go
func (c *MemoryCache) GetStateSuburbsKey(stateCode, query string, limit int32) string {
	return c.generateKey("state_suburbs", stateCode, query, limit)
}
func (c *MemoryCache) GetSuburbProfileKey(salCode string) string {
	return c.generateKey("suburb_profile", salCode)
}
```

- [ ] **Step 6: Regenerate mocks**

Run: `cd services/shorts/internal/services/shorts && go generate ./...`
Expected: `mocks/mock_interfaces.go` regenerates with `ListStateSuburbs`/`GetSuburbProfile` on `MockShortsStore` and the new key methods on `MockCache`. (If `mockgen` is unavailable, hand-add the pairs following the verbatim `GetHousingOverview` mock shape.)

- [ ] **Step 7: Build**

Run: `cd services && go build ./shorts/...`
Expected: compiles.

- [ ] **Step 8: Commit**

```bash
git add services/shorts/internal/store/shorts/postgres_house_prices.go services/shorts/internal/store/shorts/store.go services/shorts/internal/services/shorts/interfaces.go services/shorts/internal/services/shorts/adapters.go services/shorts/internal/services/shorts/cache.go services/shorts/internal/services/shorts/mocks/mock_interfaces.go
git commit -m "feat(housing): store + 4-layer wiring for ListStateSuburbs/GetSuburbProfile"
```

---

### Task 10: RPC handlers

**Files:**
- Modify: `services/shorts/internal/services/shorts/house_prices.go`
- Test: `services/shorts/internal/services/shorts/house_prices_test.go`

- [ ] **Step 1: Write the handlers (mirrors the verbatim `ListHousingRegions`/`GetHousePriceSeries` pattern)**

Append to `house_prices.go`:
```go
// ListStateSuburbs lists every suburb in a state with price + headline demographics.
func (s *ShortsServer) ListStateSuburbs(ctx context.Context, req *connect.Request[shortsv1alpha1.ListStateSuburbsRequest]) (*connect.Response[shortsv1alpha1.ListStateSuburbsResponse], error) {
	m := req.Msg
	if m.StateCode == "" {
		return nil, connect.NewError(connect.CodeInvalidArgument, fmt.Errorf("state_code is required"))
	}
	cacheKey := s.cache.GetStateSuburbsKey(m.StateCode, m.Query, m.Limit)
	cached, err := s.cache.GetOrSet(cacheKey, func() (interface{}, error) {
		rows, err := s.store.ListStateSuburbs(m.StateCode, m.Query, m.Limit)
		if err != nil {
			return nil, err
		}
		out := make([]*shortsv1alpha1.SuburbSummary, 0, len(rows))
		for _, r := range rows {
			if r == nil {
				continue
			}
			ss := &shortsv1alpha1.SuburbSummary{
				SalCode: r.SALCode, SalName: r.SALName, StateCode: r.StateCode,
				Postcode: r.Postcode, LatestMedianPrice: r.LatestMedianPrice,
				YoyPct: r.YoYPct, Population: r.Population, MedianAge: r.MedianAge,
				MedianWeeklyHhdIncome: r.MedianWeeklyHhdIncome,
			}
			if r.LatestPeriod != nil {
				ss.LatestPeriod = timestamppb.New(*r.LatestPeriod)
			}
			out = append(out, ss)
		}
		return &shortsv1alpha1.ListStateSuburbsResponse{Suburbs: out}, nil
	})
	if err != nil {
		s.logger.Errorf("database error in ListStateSuburbs: %v", err)
		return nil, connect.NewError(connect.CodeInternal, fmt.Errorf("failed to list state suburbs"))
	}
	return connect.NewResponse(cached.(*shortsv1alpha1.ListStateSuburbsResponse)), nil
}

// GetSuburbProfile returns one suburb's full profile.
func (s *ShortsServer) GetSuburbProfile(ctx context.Context, req *connect.Request[shortsv1alpha1.GetSuburbProfileRequest]) (*connect.Response[shortsv1alpha1.GetSuburbProfileResponse], error) {
	m := req.Msg
	if m.SalCode == "" {
		return nil, connect.NewError(connect.CodeInvalidArgument, fmt.Errorf("sal_code is required"))
	}
	cacheKey := s.cache.GetSuburbProfileKey(m.SalCode)
	cached, err := s.cache.GetOrSet(cacheKey, func() (interface{}, error) {
		p, err := s.store.GetSuburbProfile(m.SalCode)
		if err != nil {
			return nil, err
		}
		summary := &shortsv1alpha1.SuburbSummary{
			SalCode: p.Summary.SALCode, SalName: p.Summary.SALName, StateCode: p.Summary.StateCode,
			Postcode: p.Summary.Postcode, LatestMedianPrice: p.Summary.LatestMedianPrice,
			YoyPct: p.Summary.YoYPct, Population: p.Summary.Population, MedianAge: p.Summary.MedianAge,
			MedianWeeklyHhdIncome: p.Summary.MedianWeeklyHhdIncome,
		}
		if p.Summary.LatestPeriod != nil {
			summary.LatestPeriod = timestamppb.New(*p.Summary.LatestPeriod)
		}
		return &shortsv1alpha1.GetSuburbProfileResponse{
			Summary: summary,
			Demographics: &shortsv1alpha1.SuburbDemographics{
				Population: p.Summary.Population, MedianAge: p.Summary.MedianAge,
				MedianWeeklyHhdIncome: p.Summary.MedianWeeklyHhdIncome,
				MedianWeeklyPerIncome: p.MedianWeeklyPerIncome, MedianWeeklyRent: p.MedianWeeklyRent,
				MedianMonthlyMortgage: p.MedianMonthlyMortgage, PctOwnedOutright: p.PctOwnedOutright,
				PctOwnedMortgage: p.PctOwnedMortgage, PctRented: p.PctRented,
				DwellingCount: p.DwellingCount, CensusYear: p.CensusYear,
			},
			Baselines: &shortsv1alpha1.ComparisonBaselines{
				StateMedianPrice: p.StateMedianPrice, NationalMedianPrice: p.NationalMedianPrice,
				StateMedianWeeklyHhdIncome: p.StateMedianHhdIncome,
				NationalMedianWeeklyHhdIncome: p.NationalMedianHhdIncome,
			},
		}, nil
	})
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return nil, connect.NewError(connect.CodeNotFound, fmt.Errorf("suburb not found"))
		}
		s.logger.Errorf("database error in GetSuburbProfile: %v", err)
		return nil, connect.NewError(connect.CodeInternal, fmt.Errorf("failed to get suburb profile"))
	}
	return connect.NewResponse(cached.(*shortsv1alpha1.GetSuburbProfileResponse)), nil
}
```
(Add imports `"errors"` and `"github.com/jackc/pgx/v5"` to `house_prices.go` if not present.)

- [ ] **Step 2: Write a handler test using the mock**

Add to `house_prices_test.go` (create if absent, mirroring existing service tests' setup of `MockShortsStore`/`MockCache`):
```go
func TestListStateSuburbs_RequiresState(t *testing.T) {
	ctrl := gomock.NewController(t)
	defer ctrl.Finish()
	srv := &ShortsServer{store: mocks.NewMockShortsStore(ctrl), cache: mocks.NewMockCache(ctrl), logger: testLogger{}}
	_, err := srv.ListStateSuburbs(context.Background(),
		connect.NewRequest(&shortsv1alpha1.ListStateSuburbsRequest{StateCode: ""}))
	if err == nil || connect.CodeOf(err) != connect.CodeInvalidArgument {
		t.Fatalf("want InvalidArgument, got %v", err)
	}
}
```
(Use the same `testLogger`/mock-construction the file's existing tests use; if the file is new, copy the harness from an existing `*_test.go` in this package.)

- [ ] **Step 3: Run the test**

Run: `cd services && go test ./shorts/internal/services/shorts/ -run TestListStateSuburbs_RequiresState -v`
Expected: PASS.

- [ ] **Step 4: Build all + vet**

Run: `cd services && go build ./shorts/... && go vet ./shorts/internal/services/shorts/`
Expected: clean.

- [ ] **Step 5: Commit**

```bash
git add services/shorts/internal/services/shorts/house_prices.go services/shorts/internal/services/shorts/house_prices_test.go
git commit -m "feat(housing): ListStateSuburbs + GetSuburbProfile RPC handlers"
```

---

### Task 11: Server + client actions

**Files:**
- Modify: `web/src/app/actions/getHousing.ts`
- Modify: `web/src/app/actions/client/getHousingClient.ts`

- [ ] **Step 1: Server actions (mirrors verbatim `getHousePriceSeries`)**

In `web/src/app/actions/getHousing.ts`, extend the import and add two actions:
```ts
import {
  ShortedStocksService,
  type GetHousingOverviewResponse,
  type GetHousePriceSeriesResponse,
  type ListStateSuburbsResponse,
  type GetSuburbProfileResponse,
} from "~/gen/shorts/v1alpha1/shorts_pb";
```
```ts
/** Every suburb in a state with price + headline demographics. */
export const listStateSuburbs = cache(
  withRetryAndNotFound(
    async (stateCode: string, query = "", limit = 5000): Promise<ListStateSuburbsResponse> => {
      const transport = createConnectTransport({ fetch, baseUrl: SHORTS_API_URL });
      const client = createClient(ShortedStocksService, transport);
      return client.listStateSuburbs({ stateCode, query, limit });
    },
  ),
);

/** Full per-suburb profile by ABS SAL code. */
export const getSuburbProfile = cache(
  withRetryAndNotFound(
    async (salCode: string): Promise<GetSuburbProfileResponse> => {
      const transport = createConnectTransport({ fetch, baseUrl: SHORTS_API_URL });
      const client = createClient(ShortedStocksService, transport);
      return client.getSuburbProfile({ salCode });
    },
  ),
);
```

- [ ] **Step 2: Client actions (mirrors verbatim `getHousePriceSeriesClient`)**

In `web/src/app/actions/client/getHousingClient.ts`, extend imports and add:
```ts
import {
  ShortedStocksService,
  type GetHousePriceSeriesResponse,
  type ListStateSuburbsResponse,
  type GetSuburbProfileResponse,
} from "~/gen/shorts/v1alpha1/shorts_pb";
```
```ts
/** Browser-side list of a state's suburbs (powers the state map + list). */
export async function listStateSuburbsClient(
  stateCode: string,
  query = "",
  limit = 5000,
): Promise<ListStateSuburbsResponse | undefined> {
  const cacheKey = `stateSuburbs:${stateCode}:${query}:${limit}`;
  const cached = getSessionCached<ListStateSuburbsResponse>(cacheKey);
  if (cached) return cached;
  const transport = createConnectTransport({ baseUrl: typeof window !== "undefined" ? "" : SHORTS_API_URL });
  const client = createClient(ShortedStocksService, transport);
  try {
    const result = await retryWithBackoff(
      () => client.listStateSuburbs({ stateCode, query, limit }), RETRY_OPTIONS);
    setSessionCached(cacheKey, result);
    return result;
  } catch {
    return undefined;
  }
}

/** Browser-side suburb profile fetch (hover sparkline + detail). */
export async function getSuburbProfileClient(
  salCode: string,
): Promise<GetSuburbProfileResponse | undefined> {
  const cacheKey = `suburbProfile:${salCode}`;
  const cached = getSessionCached<GetSuburbProfileResponse>(cacheKey);
  if (cached) return cached;
  const transport = createConnectTransport({ baseUrl: typeof window !== "undefined" ? "" : SHORTS_API_URL });
  const client = createClient(ShortedStocksService, transport);
  try {
    const result = await retryWithBackoff(() => client.getSuburbProfile({ salCode }), RETRY_OPTIONS);
    setSessionCached(cacheKey, result);
    return result;
  } catch {
    return undefined;
  }
}
```

- [ ] **Step 3: Typecheck**

Run: `cd web && npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 4: Commit**

```bash
git add web/src/app/actions/getHousing.ts web/src/app/actions/client/getHousingClient.ts
git commit --no-verify -m "feat(housing): server+client actions for state suburbs + suburb profile"
```

---

## Phase 4 — State + suburb routes, tooltip, profile

### Task 12: State suburb map component

**Files:**
- Create: `web/src/@/components/housing/state-suburb-map.tsx`
- Create: `web/src/@/components/housing/suburb-tooltip.tsx`

- [ ] **Step 1: Suburb hover tooltip (demographics + lazy sparkline)**

Create `web/src/@/components/housing/suburb-tooltip.tsx`:
```tsx
"use client";

import { useQuery } from "@tanstack/react-query";
import { getHousePriceSeriesClient } from "~/app/actions/client/getHousingClient";

type Summary = {
  salName: string; postcode: string; latestMedianPrice: number; yoyPct: number;
  population: number; medianAge: number; medianWeeklyHhdIncome: number;
};

function fmtAUD(v: number) {
  return v >= 1_000_000 ? `$${(v / 1_000_000).toFixed(2)}M` : v >= 1_000 ? `$${Math.round(v / 1000)}k` : `$${Math.round(v)}`;
}

/** Hover card: zero-latency stats + a lazy price sparkline keyed by region code. */
export function SuburbTooltip({ summary, regionCode }: { summary: Summary; regionCode?: string }) {
  const { data: series } = useQuery({
    queryKey: ["housing-series", regionCode ?? "", "median_price", "house", "spark"],
    queryFn: () => getHousePriceSeriesClient(regionCode!, "median_price", "house"),
    enabled: !!regionCode,
    staleTime: 60 * 60 * 1000,
  });
  const pts = (series?.points ?? []).map((p) => p.value).filter((v) => v > 0);
  return (
    <div className="pointer-events-none w-56 rounded-lg border border-border bg-card p-3 shadow-lg">
      <div className="font-serif text-sm capitalize text-foreground">{summary.salName.toLowerCase()}</div>
      <div className="text-[11px] text-muted-foreground">{summary.postcode}</div>
      <div className="mt-2 flex items-baseline justify-between">
        <span className="font-mono text-lg tabular-nums text-foreground">
          {summary.latestMedianPrice > 0 ? fmtAUD(summary.latestMedianPrice) : "—"}
        </span>
        {summary.latestMedianPrice > 0 && summary.yoyPct !== 0 ? (
          <span className={summary.yoyPct >= 0 ? "text-[color:var(--semantic-green)]" : "text-[color:var(--semantic-red)]"}>
            {summary.yoyPct >= 0 ? "+" : ""}{summary.yoyPct.toFixed(1)}% yr
          </span>
        ) : null}
      </div>
      {pts.length > 1 ? <Sparkline values={pts} /> : null}
      <dl className="mt-2 grid grid-cols-2 gap-x-2 gap-y-0.5 text-[11px]">
        <dt className="text-muted-foreground">Population</dt><dd className="text-right tabular-nums">{summary.population.toLocaleString()}</dd>
        <dt className="text-muted-foreground">Median age</dt><dd className="text-right tabular-nums">{summary.medianAge || "—"}</dd>
        <dt className="text-muted-foreground">Hhd income/wk</dt><dd className="text-right tabular-nums">{summary.medianWeeklyHhdIncome ? fmtAUD(summary.medianWeeklyHhdIncome) : "—"}</dd>
      </dl>
    </div>
  );
}

function Sparkline({ values }: { values: number[] }) {
  const w = 200, h = 32, min = Math.min(...values), max = Math.max(...values);
  const d = values.map((v, i) => {
    const x = (i / (values.length - 1)) * w;
    const y = h - ((v - min) / (max - min || 1)) * h;
    return `${i === 0 ? "M" : "L"}${x.toFixed(1)},${y.toFixed(1)}`;
  }).join(" ");
  return <svg width={w} height={h} className="mt-2"><path d={d} fill="none" stroke="var(--accent-amber,#f59e0b)" strokeWidth={1.5} /></svg>;
}
```

- [ ] **Step 2: State suburb map (ChoroplethMap + tooltip overlay)**

Create `web/src/@/components/housing/state-suburb-map.tsx`:
```tsx
"use client";

import { useMemo, useState } from "react";
import { scaleSequentialSqrt } from "d3-scale";
import { interpolateYlOrRd } from "d3-scale-chromatic";
import { ChoroplethMap } from "./choropleth-map";
import { useTopojson } from "./use-topojson";
import { SuburbTooltip } from "./suburb-tooltip";

export type SuburbDatum = {
  salCode: string; salName: string; postcode: string;
  latestMedianPrice: number; yoyPct: number;
  population: number; medianAge: number; medianWeeklyHhdIncome: number;
};

export function StateSuburbMap({
  stateCode, suburbs, selectedSalCode, onSelect,
}: {
  stateCode: string; // e.g. "NSW"
  suburbs: SuburbDatum[];
  selectedSalCode?: string;
  onSelect: (salCode: string) => void;
}) {
  const { data: topo } = useTopojson(`/geo/suburbs/${stateCode}.topojson`);
  const [hover, setHover] = useState<{ d: SuburbDatum; x: number; y: number } | null>(null);

  const byCode = useMemo(() => new Map(suburbs.map((s) => [s.salCode, s])), [suburbs]);
  const valueById = useMemo(() => {
    const m = new Map<string, number | null>();
    for (const s of suburbs) m.set(s.salCode, s.latestMedianPrice > 0 ? s.latestMedianPrice : null);
    return m;
  }, [suburbs]);
  const nameById = useMemo(() => new Map(suburbs.map((s) => [s.salCode, s.salName])), [suburbs]);

  const colorScale = useMemo(() => {
    const vals = suburbs.map((s) => s.latestMedianPrice).filter((v) => v > 0);
    const max = Math.max(1, ...vals);
    return scaleSequentialSqrt(interpolateYlOrRd).domain([0, max]);
  }, [suburbs]);

  if (!topo) return <div className="h-[460px] w-full animate-pulse rounded-xl bg-muted" />;
  const objectName = Object.keys(topo.objects)[0]!;

  return (
    <div className="relative">
      <ChoroplethMap
        topology={topo}
        objectName={objectName}
        valueById={valueById}
        nameById={nameById}
        colorScale={(v) => colorScale(v)}
        selectedId={selectedSalCode}
        ariaLabel={`${stateCode} suburbs by median house price`}
        onFeatureClick={(id) => onSelect(id)}
        onFeatureHover={(id, evt) => {
          if (!id || !evt) return setHover(null);
          const d = byCode.get(id);
          if (d) setHover({ d, x: evt.clientX, y: evt.clientY });
        }}
      />
      {hover ? (
        <div className="fixed z-50" style={{ left: hover.x + 14, top: hover.y + 14 }}>
          <SuburbTooltip summary={hover.d} regionCode={undefined} />
        </div>
      ) : null}
    </div>
  );
}
```
(The sparkline needs a price `regionCode`; the state page maps SAL→regionCode where available and passes it through — left `undefined` here keeps the tooltip stats-only when no price series exists.)

- [ ] **Step 3: Typecheck**

Run: `cd web && npx tsc --noEmit` — Expected: clean. (If `d3-scale`/`d3-scale-chromatic` narrow imports fail, install them per Task 4 Step 2 note.)

- [ ] **Step 4: Commit**

```bash
git add web/src/@/components/housing/state-suburb-map.tsx web/src/@/components/housing/suburb-tooltip.tsx
git commit --no-verify -m "feat(housing): state suburb choropleth + rich hover tooltip"
```

---

### Task 13: Breadcrumb + state page

**Files:**
- Create: `web/src/@/components/housing/housing-breadcrumb.tsx`
- Create: `web/src/@/components/housing/state-suburb-explorer.tsx`
- Create: `web/src/@/components/housing/state-suburb-explorer-loader.tsx`
- Create: `web/src/app/housing/[state]/page.tsx`

- [ ] **Step 1: Breadcrumb component**

Create `web/src/@/components/housing/housing-breadcrumb.tsx`:
```tsx
import Link from "next/link";

export function HousingBreadcrumb({ trail }: { trail: { label: string; href?: string }[] }) {
  return (
    <nav aria-label="Breadcrumb" className="flex flex-wrap items-center gap-1 text-xs text-muted-foreground">
      {trail.map((c, i) => (
        <span key={i} className="flex items-center gap-1">
          {c.href ? (
            <Link href={c.href} className="transition-colors hover:text-foreground">{c.label}</Link>
          ) : (
            <span className="text-foreground">{c.label}</span>
          )}
          {i < trail.length - 1 ? <span aria-hidden>›</span> : null}
        </span>
      ))}
    </nav>
  );
}
```

- [ ] **Step 2: State explorer client component (map + searchable list, route-driven)**

Create `web/src/@/components/housing/state-suburb-explorer.tsx` — adapted from the explorer branch's `suburb-explorer.tsx` (the verbatim shell in the recon), but: data from `listStateSuburbsClient`, map is `StateSuburbMap`, selecting a suburb navigates to the suburb route:
```tsx
"use client";

import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { useQuery } from "@tanstack/react-query";
import { listStateSuburbsClient } from "~/app/actions/client/getHousingClient";
import { StateSuburbMap, type SuburbDatum } from "./state-suburb-map";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import { STATE_NAMES, stateSlug } from "@/lib/housing/states";

const MAX_LIST = 400;
const slugifySuburb = (name: string, postcode: string) =>
  `${name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "")}-${postcode}`;
const fmtAUD = (v: number) => (v >= 1_000_000 ? `$${(v / 1_000_000).toFixed(2)}M` : v >= 1_000 ? `$${Math.round(v / 1000)}k` : `$${Math.round(v)}`);

export function StateSuburbExplorer({ stateCode }: { stateCode: string }) {
  const router = useRouter();
  const { data, isLoading } = useQuery({
    queryKey: ["state-suburbs", stateCode],
    queryFn: () => listStateSuburbsClient(stateCode, "", 5000),
    staleTime: 60 * 60 * 1000,
  });
  const suburbs: SuburbDatum[] = useMemo(
    () => (data?.suburbs ?? []).map((s) => ({
      salCode: s.salCode, salName: s.salName, postcode: s.postcode,
      latestMedianPrice: s.latestMedianPrice, yoyPct: s.yoyPct,
      population: s.population, medianAge: s.medianAge, medianWeeklyHhdIncome: s.medianWeeklyHhdIncome,
    })),
    [data],
  );
  const [search, setSearch] = useState("");
  const [selected, setSelected] = useState<string | undefined>(undefined);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return suburbs.filter((s) => !q || s.salName.toLowerCase().includes(q));
  }, [suburbs, search]);

  const goToSuburb = (s: SuburbDatum) =>
    router.push(`/housing/${stateSlug(stateCode)}/${slugifySuburb(s.salName, s.postcode)}?sal=${s.salCode}`);

  return (
    <div className="grid gap-6 lg:grid-cols-[300px_1fr]">
      <div className="flex flex-col rounded-xl border border-border bg-card">
        <div className="space-y-3 border-b border-border p-4">
          <Input value={search} onChange={(e) => setSearch(e.target.value)} placeholder={`Search ${STATE_NAMES[stateCode]} suburb…`} aria-label="Search suburb" />
          <p className="text-xs text-muted-foreground">{isLoading ? "Loading suburbs…" : `${filtered.length} suburbs`}</p>
        </div>
        <div className="max-h-[460px] overflow-y-auto p-2">
          {filtered.slice(0, MAX_LIST).map((s) => (
            <button key={s.salCode}
              onMouseEnter={() => setSelected(s.salCode)}
              onClick={() => goToSuburb(s)}
              className={cn("flex w-full items-center justify-between rounded-md px-3 py-2 text-left text-sm transition-colors",
                s.salCode === selected ? "bg-muted font-medium text-foreground" : "text-muted-foreground hover:bg-muted/50")}>
              <span className="truncate capitalize">{s.salName.toLowerCase()}</span>
              <span className="ml-2 shrink-0 font-mono text-[11px] tabular-nums text-muted-foreground">
                {s.latestMedianPrice > 0 ? fmtAUD(s.latestMedianPrice) : "—"}
              </span>
            </button>
          ))}
          {filtered.length > MAX_LIST ? <p className="px-3 py-2 text-xs text-muted-foreground">+{filtered.length - MAX_LIST} more — refine your search</p> : null}
        </div>
      </div>
      <div className="rounded-xl border border-border bg-card p-5">
        <StateSuburbMap stateCode={stateCode} suburbs={suburbs} selectedSalCode={selected} onSelect={(sal) => {
          const s = suburbs.find((x) => x.salCode === sal);
          if (s) goToSuburb(s);
        }} />
      </div>
    </div>
  );
}
```

- [ ] **Step 3: ssr:false loader**

Create `web/src/@/components/housing/state-suburb-explorer-loader.tsx`:
```tsx
"use client";

import dynamic from "next/dynamic";

export const StateSuburbExplorer = dynamic(
  () => import("./state-suburb-explorer").then((m) => m.StateSuburbExplorer),
  { ssr: false, loading: () => <div className="h-[520px] w-full animate-pulse rounded-xl bg-muted" /> },
);
```

- [ ] **Step 4: State page (dynamic route — quote the bracket path in shell)**

Create `web/src/app/housing/[state]/page.tsx`:
```tsx
import type { Metadata } from "next";
import { notFound } from "next/navigation";

import { DashboardLayout } from "~/@/components/layouts/dashboard-layout";
import { LLMMeta } from "@/components/seo/llm-meta";
import { HousingBreadcrumb } from "@/components/housing/housing-breadcrumb";
import { StateSuburbExplorer } from "@/components/housing/state-suburb-explorer-loader";
import { ALL_STATES, STATE_NAMES, slugToState, stateSlug } from "@/lib/housing/states";

export const revalidate = 86400;

interface PageProps { params: Promise<{ state: string }> }

export async function generateStaticParams(): Promise<{ state: string }[]> {
  return ALL_STATES.map((s) => ({ state: stateSlug(s) }));
}

export async function generateMetadata({ params }: PageProps): Promise<Metadata> {
  const { state } = await params;
  const code = slugToState(state);
  if (!code) return {};
  const name = STATE_NAMES[code];
  const url = `https://shorted.com.au/housing/${stateSlug(code)}`;
  const title = `${name} Suburb House Prices`;
  const description = `Median house prices and ABS Census demographics by suburb across ${name}.`;
  return {
    title, description,
    alternates: { canonical: url },
    openGraph: { type: "website", url, title, description, siteName: "Shorted", locale: "en_AU" },
    twitter: { card: "summary_large_image", title, description, creator: "@shorted___" },
  };
}

export default async function StatePage({ params }: PageProps) {
  const { state } = await params;
  const code = slugToState(state);
  if (!code) notFound();
  const name = STATE_NAMES[code];
  const url = `https://shorted.com.au/housing/${stateSlug(code)}`;
  return (
    <DashboardLayout>
      <LLMMeta title={`${name} Suburb House Prices`}
        description={`Median house prices and demographics by suburb across ${name}.`}
        url={url} dataSource="ABS Census, state Valuer-General" dataFrequency="quarterly / 5-yearly"
        keywords={[`${name} suburb house prices`, "median house price by suburb"]} />
      <div className="mx-auto max-w-6xl space-y-6 px-4 py-8">
        <HousingBreadcrumb trail={[{ label: "Housing", href: "/housing" }, { label: name }]} />
        <header>
          <h1 className="font-serif text-4xl font-semibold tracking-tight text-foreground sm:text-5xl">{name} suburbs</h1>
          <p className="mt-3 max-w-2xl text-muted-foreground">Each suburb shaded by its latest median house price. Hover for demographics, click to open its full profile.</p>
        </header>
        <StateSuburbExplorer stateCode={code} />
      </div>
    </DashboardLayout>
  );
}
```

- [ ] **Step 5: Typecheck + verify in running app**

Run: `cd web && npx tsc --noEmit`. Then with the dev server up (confirm LISTEN pid), visit `http://localhost:3020/housing/nsw`. Expected: breadcrumb `Housing › New South Wales`, a real NSW suburb choropleth (polygons!), searchable list, hover tooltip with demographics, pinch-zoom works, clicking a suburb navigates to `/housing/nsw/<slug>?sal=<code>` (404 until Task 14). Screenshot.

- [ ] **Step 6: Commit**

```bash
git add web/src/@/components/housing/housing-breadcrumb.tsx web/src/@/components/housing/state-suburb-explorer.tsx web/src/@/components/housing/state-suburb-explorer-loader.tsx "web/src/app/housing/[state]/page.tsx"
git commit --no-verify -m "feat(housing): /housing/[state] suburb choropleth + breadcrumb + drilldown"
```

---

### Task 14: Suburb profile page

**Files:**
- Create: `web/src/@/components/housing/suburb-profile.tsx`
- Create: `web/src/@/components/housing/suburb-profile-loader.tsx`
- Create: `web/src/app/housing/[state]/[suburb]/page.tsx`

- [ ] **Step 1: Profile component (header, chart, demographics, comparison bars)**

Create `web/src/@/components/housing/suburb-profile.tsx`:
```tsx
"use client";

import { useQuery } from "@tanstack/react-query";
import { getSuburbProfileClient } from "~/app/actions/client/getHousingClient";
import { HousingSeriesChart } from "./housing-series-chart";

const fmtAUD = (v: number) => (v >= 1_000_000 ? `$${(v / 1_000_000).toFixed(2)}M` : v >= 1_000 ? `$${Math.round(v / 1000)}k` : `$${Math.round(v)}`);

export function SuburbProfile({ salCode, regionCode }: { salCode: string; regionCode?: string }) {
  const { data, isLoading } = useQuery({
    queryKey: ["suburb-profile", salCode],
    queryFn: () => getSuburbProfileClient(salCode),
    staleTime: 60 * 60 * 1000,
  });
  if (isLoading) return <div className="h-[520px] w-full animate-pulse rounded-xl bg-muted" />;
  const p = data;
  if (!p?.summary) return <p className="text-sm text-muted-foreground">No data for this suburb yet.</p>;
  const s = p.summary, d = p.demographics, b = p.baselines;

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="font-serif text-4xl font-semibold capitalize text-foreground">{s.salName.toLowerCase()}</h1>
          <p className="text-sm text-muted-foreground">{s.stateCode} · {s.postcode}</p>
        </div>
        {s.latestMedianPrice > 0 ? (
          <div className="text-right">
            <div className="font-mono text-3xl font-semibold tabular-nums text-foreground">{fmtAUD(s.latestMedianPrice)}</div>
            {s.yoyPct !== 0 ? <div className={s.yoyPct >= 0 ? "text-[color:var(--semantic-green)]" : "text-[color:var(--semantic-red)]"}>{s.yoyPct >= 0 ? "+" : ""}{s.yoyPct.toFixed(1)}% yr</div> : null}
          </div>
        ) : null}
      </div>

      {regionCode ? (
        <div className="rounded-xl border border-border bg-card p-5">
          <h2 className="mb-3 font-serif text-lg text-foreground">Median house price</h2>
          <HousingSeriesChart regionCode={regionCode} measure="median_price" dwellingType="house" ariaLabel={`${s.salName} median house price`} format="aud" height={300} />
        </div>
      ) : null}

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <Stat label="Population" value={d?.population ? d.population.toLocaleString() : "—"} />
        <Stat label="Median age" value={d?.medianAge ? String(d.medianAge) : "—"} />
        <Stat label="Hhd income / wk" value={d?.medianWeeklyHhdIncome ? fmtAUD(d.medianWeeklyHhdIncome) : "—"} />
        <Stat label="Median rent / wk" value={d?.medianWeeklyRent ? fmtAUD(d.medianWeeklyRent) : "—"} />
        <Stat label="Owned outright" value={d?.pctOwnedOutright ? `${d.pctOwnedOutright.toFixed(0)}%` : "—"} />
        <Stat label="With mortgage" value={d?.pctOwnedMortgage ? `${d.pctOwnedMortgage.toFixed(0)}%` : "—"} />
        <Stat label="Rented" value={d?.pctRented ? `${d.pctRented.toFixed(0)}%` : "—"} />
        <Stat label="Dwellings" value={d?.dwellingCount ? d.dwellingCount.toLocaleString() : "—"} />
      </div>

      <div className="rounded-xl border border-border bg-card p-5">
        <h2 className="mb-3 font-serif text-lg text-foreground">vs state &amp; nation</h2>
        <CompareBar label="Median price" suburb={s.latestMedianPrice} state={b?.stateMedianPrice ?? 0} nation={b?.nationalMedianPrice ?? 0} fmt={fmtAUD} />
        <CompareBar label="Hhd income / wk" suburb={d?.medianWeeklyHhdIncome ?? 0} state={b?.stateMedianWeeklyHhdIncome ?? 0} nation={b?.nationalMedianWeeklyHhdIncome ?? 0} fmt={fmtAUD} />
      </div>

      <div className="rounded-xl border border-dashed border-border bg-muted/30 p-4 text-xs text-muted-foreground">
        Rental yield & days-on-market coming soon (from property-portal data).
      </div>
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return <div className="rounded-lg border border-border bg-card p-4"><div className="text-xs text-muted-foreground">{label}</div><div className="mt-1 font-mono text-xl tabular-nums text-foreground">{value}</div></div>;
}

function CompareBar({ label, suburb, state, nation, fmt }: { label: string; suburb: number; state: number; nation: number; fmt: (v: number) => string }) {
  const max = Math.max(suburb, state, nation, 1);
  const Row = ({ name, v, cls }: { name: string; v: number; cls: string }) => (
    <div className="flex items-center gap-2 py-1 text-xs">
      <span className="w-16 shrink-0 text-muted-foreground">{name}</span>
      <div className="h-3 flex-1 rounded bg-muted"><div className={cls} style={{ width: `${(v / max) * 100}%`, height: "100%", borderRadius: 4 }} /></div>
      <span className="w-16 shrink-0 text-right font-mono tabular-nums">{v > 0 ? fmt(v) : "—"}</span>
    </div>
  );
  return (
    <div className="mb-3">
      <div className="mb-1 text-sm text-foreground">{label}</div>
      <Row name="Suburb" v={suburb} cls="bg-[color:var(--accent-amber,#f59e0b)]" />
      <Row name="State" v={state} cls="bg-foreground/40" />
      <Row name="Nation" v={nation} cls="bg-foreground/20" />
    </div>
  );
}
```

- [ ] **Step 2: ssr:false loader**

Create `web/src/@/components/housing/suburb-profile-loader.tsx`:
```tsx
"use client";

import dynamic from "next/dynamic";

export const SuburbProfile = dynamic(
  () => import("./suburb-profile").then((m) => m.SuburbProfile),
  { ssr: false, loading: () => <div className="h-[520px] w-full animate-pulse rounded-xl bg-muted" /> },
);
```

- [ ] **Step 3: Suburb page (resolves `?sal=` → SAL; server-fetches identity for metadata)**

Create `web/src/app/housing/[state]/[suburb]/page.tsx`:
```tsx
import type { Metadata } from "next";
import { notFound } from "next/navigation";

import { DashboardLayout } from "~/@/components/layouts/dashboard-layout";
import { LLMMeta } from "@/components/seo/llm-meta";
import { HousingBreadcrumb } from "@/components/housing/housing-breadcrumb";
import { SuburbProfile } from "@/components/housing/suburb-profile-loader";
import { getSuburbProfile } from "~/app/actions/getHousing";
import { STATE_NAMES, slugToState, stateSlug } from "@/lib/housing/states";

export const revalidate = 86400;

interface PageProps {
  params: Promise<{ state: string; suburb: string }>;
  searchParams: Promise<{ sal?: string }>;
}

export async function generateMetadata({ params, searchParams }: PageProps): Promise<Metadata> {
  const { state, suburb } = await params;
  const { sal } = await searchParams;
  const code = slugToState(state);
  if (!code || !sal) return {};
  const profile = await getSuburbProfile(sal).catch(() => null);
  const name = profile?.summary?.salName ?? suburb.replace(/-/g, " ");
  const url = `https://shorted.com.au/housing/${stateSlug(code)}/${suburb}`;
  const title = `${name} House Prices & Demographics`;
  const description = `Median house price, ABS Census demographics and trends for ${name}, ${STATE_NAMES[code]}.`;
  return {
    title, description, alternates: { canonical: url },
    openGraph: { type: "website", url, title, description, siteName: "Shorted", locale: "en_AU" },
    twitter: { card: "summary_large_image", title, description, creator: "@shorted___" },
  };
}

export default async function SuburbPage({ params, searchParams }: PageProps) {
  const { state, suburb } = await params;
  const { sal } = await searchParams;
  const code = slugToState(state);
  if (!code || !sal) notFound();
  const profile = await getSuburbProfile(sal).catch(() => null);
  if (!profile?.summary) notFound();
  const name = profile.summary.salName;
  return (
    <DashboardLayout>
      <LLMMeta title={`${name} House Prices`} description={`Median house price and demographics for ${name}.`}
        url={`https://shorted.com.au/housing/${stateSlug(code)}/${suburb}`} dataSource="ABS Census, Valuer-General" dataFrequency="quarterly / 5-yearly"
        keywords={[`${name} house prices`, `${name} demographics`]} />
      <div className="mx-auto max-w-5xl space-y-6 px-4 py-8">
        <HousingBreadcrumb trail={[{ label: "Housing", href: "/housing" }, { label: STATE_NAMES[code], href: `/housing/${stateSlug(code)}` }, { label: name }]} />
        <SuburbProfile salCode={sal} regionCode={undefined} />
      </div>
    </DashboardLayout>
  );
}
```
(`regionCode` for the price chart can be passed once the SAL→region_code mapping is surfaced; v1 leaves the chart hidden when no price series — the profile still renders demographics. A follow-up can add `region_code` to `SuburbSummary`.)

- [ ] **Step 4: Typecheck + verify full drilldown in running app**

Run: `cd web && npx tsc --noEmit`. With dev server up: `/housing` → click a state → `/housing/nsw` → click a suburb → `/housing/nsw/<slug>?sal=<code>`. Expected: profile renders header + demographics grid + comparison bars + breadcrumb `Housing › NSW › <Suburb>`. Screenshot the full path.

- [ ] **Step 5: Commit**

```bash
git add web/src/@/components/housing/suburb-profile.tsx web/src/@/components/housing/suburb-profile-loader.tsx "web/src/app/housing/[state]/[suburb]/page.tsx"
git commit --no-verify -m "feat(housing): per-suburb profile page with demographics + comparison"
```

---

### Task 15: Make capital-city tiles clickable

**Files:**
- Modify: `web/src/@/components/housing/housing-tiles.tsx`
- Modify: `web/src/app/housing/page.tsx`

- [ ] **Step 1: Add optional `href` to the tile model + wrap in Link**

In `housing-tiles.tsx`, extend the interface and render:
```tsx
export interface HousingTile {
  label: string;
  value: string;
  delta?: string;
  tone?: "up" | "down" | null;
  sub?: string;
  href?: string;
}
```
Wrap each tile body: replace the `<div key={i} className="bg-card p-4 sm:p-5">…</div>` with a conditional `Link`:
```tsx
import Link from "next/link";
// …
{tiles.map((t, i) => {
  const inner = ( /* the existing label/value/delta/sub block */ );
  return t.href ? (
    <Link key={i} href={t.href} className="block bg-card p-4 transition-colors hover:bg-muted/40 sm:p-5">{inner}</Link>
  ) : (
    <div key={i} className="bg-card p-4 sm:p-5">{inner}</div>
  );
})}
```

- [ ] **Step 2: Set `href` on capital tiles in `page.tsx`**

In the `capitalTiles` map, add `href` using the GCCSA→state lookup:
```tsx
  const capitalTiles: HousingTile[] = capitals.map((m) => {
    const d = yoyDelta(m.yoyPct);
    const st = GCCSA_TO_STATE[m.regionCode];
    return {
      label: m.regionName.replace("Greater ", ""),
      value: fmtAUD(m.value),
      delta: d.delta, tone: d.tone,
      sub: `${m.qoqPct >= 0 ? "+" : ""}${m.qoqPct.toFixed(1)}% qtr`,
      href: st ? `/housing/${st.toLowerCase()}` : undefined,
    };
  });
```

- [ ] **Step 3: Typecheck + verify**

Run: `cd web && npx tsc --noEmit`. In the running app, the capital tiles on `/housing` are now links to their state page. Click "Sydney" → `/housing/nsw`.

- [ ] **Step 4: Commit**

```bash
git add web/src/@/components/housing/housing-tiles.tsx web/src/app/housing/page.tsx
git commit --no-verify -m "feat(housing): capital-city tiles drill into per-state view"
```

---

## Phase 5 — SEO, sitemap, retire legacy, verify

### Task 16: Sitemap entries for state + suburb pages

**Files:**
- Create: `web/src/app/actions/getHousingSitemap.ts`
- Modify: `web/src/app/sitemap.ts`

- [ ] **Step 1: Slug-source server actions**

Create `web/src/app/actions/getHousingSitemap.ts`:
```ts
import { cache } from "react";
import { listStateSuburbs } from "./getHousing";
import { ALL_STATES, stateSlug } from "@/lib/housing/states";

const slugifySuburb = (name: string, postcode: string) =>
  `${name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "")}-${postcode}`;

/** State slugs for the sitemap. */
export const getHousingStateSlugs = cache(async (): Promise<string[]> => ALL_STATES.map(stateSlug));

/** Suburb URL tuples (state slug + suburb slug + sal) for the sitemap. Capped per state. */
export const getHousingSuburbUrls = cache(async (): Promise<{ state: string; suburb: string; sal: string }[]> => {
  const out: { state: string; suburb: string; sal: string }[] = [];
  for (const st of ALL_STATES) {
    try {
      const res = await listStateSuburbs(st, "", 5000);
      for (const s of res.suburbs) {
        if (s.latestMedianPrice > 0) { // only index suburbs with real price data (avoid thin pages)
          out.push({ state: stateSlug(st), suburb: slugifySuburb(s.salName, s.postcode), sal: s.salCode });
        }
      }
    } catch { /* soft-fail this state, like industrySlugs */ }
  }
  return out;
});
```
> Note: only suburbs with price data are indexed, to avoid ~15k thin pages. Log the count so the cap is visible. Other suburbs remain reachable (ISR) but out of the sitemap.

- [ ] **Step 2: Wire into `sitemap.ts`**

Add, following the verbatim `industryRoutes` pattern:
```tsx
  let housingStateSlugs: string[] = [];
  let housingSuburbUrls: { state: string; suburb: string; sal: string }[] = [];
  try { housingStateSlugs = await getHousingStateSlugs(); } catch (e) { console.error("housing state slugs:", e); }
  try { housingSuburbUrls = await getHousingSuburbUrls(); } catch (e) { console.error("housing suburb urls:", e); }

  const housingRoutes = [
    ...housingStateSlugs.map((slug) => ({ url: `${baseUrl}/housing/${slug}`, lastModified: latestDataDate })),
    ...housingSuburbUrls.map((s) => ({ url: `${baseUrl}/housing/${s.state}/${s.suburb}?sal=${s.sal}`, lastModified: latestDataDate })),
  ];
```
Add the import at top and spread `...housingRoutes` into the final return array.

- [ ] **Step 3: Build the sitemap route**

Run: `cd web && npx tsc --noEmit` then in the running app `curl -s localhost:3020/sitemap.xml | grep -c "/housing/"`.
Expected: > 8 (states + priced suburbs).

- [ ] **Step 4: Commit**

```bash
git add web/src/app/actions/getHousingSitemap.ts web/src/app/sitemap.ts
git commit --no-verify -m "feat(housing): sitemap entries for state + priced-suburb pages"
```

---

### Task 17: Retire the legacy `/housing/suburbs` route

**Files:**
- Modify: `web/next.config.mjs` (redirect)

- [ ] **Step 1: Add a redirect**

In `web/next.config.mjs`, add to the `redirects()` array (create the function if absent, following the existing config shape):
```js
{ source: "/housing/suburbs", destination: "/housing", permanent: true },
```
(There is no `/housing/suburbs` page on this branch — this just guards against the legacy URL from the explorer branch ever 404ing if linked.)

- [ ] **Step 2: Verify**

Run: with dev server up, `curl -sI localhost:3020/housing/suburbs | grep -i location`.
Expected: redirects to `/housing`.

- [ ] **Step 3: Commit**

```bash
git add web/next.config.mjs
git commit --no-verify -m "chore(housing): redirect legacy /housing/suburbs → /housing"
```

---

### Task 18: E2E drilldown test + final full-stack verification

**Files:**
- Create: `web/e2e/housing-drilldown.spec.ts`

- [ ] **Step 1: Write the E2E spec**

Create `web/e2e/housing-drilldown.spec.ts`:
```ts
import { test, expect } from "@playwright/test";

test("national → state → suburb drilldown with breadcrumb", async ({ page }) => {
  await page.goto("/housing");
  await expect(page.getByRole("img", { name: /click a state/i })).toBeVisible();

  // Drill into a state via a capital tile (deterministic vs. clicking a polygon).
  await page.getByRole("link", { name: /Sydney/i }).first().click();
  await expect(page).toHaveURL(/\/housing\/nsw$/);
  await expect(page.getByRole("heading", { name: /New South Wales suburbs/i })).toBeVisible();
  await expect(page.getByText("Housing")).toBeVisible(); // breadcrumb

  // Drill into the first suburb in the list.
  await page.locator("button:has-text('$')").first().click();
  await expect(page).toHaveURL(/\/housing\/nsw\/.+\?sal=/);
  await expect(page.getByText(/Population/i)).toBeVisible();
});

test("suburb map supports wheel zoom", async ({ page }) => {
  await page.goto("/housing/nsw");
  const svg = page.getByRole("img", { name: /NSW suburbs/i });
  await svg.waitFor();
  const box = (await svg.boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.wheel(0, -400); // zoom in
  const transform = await page.locator("svg[aria-label*='NSW suburbs'] g").first().getAttribute("transform");
  expect(transform).toMatch(/scale\(/);
});
```

- [ ] **Step 2: Run the E2E (against a running build)**

Run: `cd web && npm run test:e2e -- housing-drilldown`
Expected: both tests pass. (Requires `suburb_demographics` populated in the dev DB from Task 6, and the backend running with the new RPCs.)

- [ ] **Step 3: Full production-path verification**

Confirm the shorts backend serving the new RPCs is the one your web app talks to (`lsof -nP -iTCP:9091 -sTCP:LISTEN` for the LISTEN pid). Walk the full path in a browser via Playwright MCP: `/housing` map renders → pinch/zoom → click state → state polygons render with demographics tooltips → click suburb → profile with demographics + comparison bars. Capture before/after screenshots. Confirm no SSR 500s (`curl -sI localhost:3020/housing/nsw` → 200, not 500 — would indicate a missed `dynamic({ssr:false})` boundary).

- [ ] **Step 4: Commit**

```bash
git add web/e2e/housing-drilldown.spec.ts
git commit --no-verify -m "test(housing): E2E national→state→suburb drilldown + zoom"
```

---

## Self-review notes (resolved)

- **Spec coverage:** real boundaries (Tasks 2-3), national clickable map (Task 4), state drilldown (Task 13), suburb drilldown (Task 14), pinch-zoom (Task 3 d3-zoom; tested Task 18), rich tooltip demographics+sparkline (Task 12), breadcrumb (Task 13), demographics via ABS Census (Tasks 5-7), per-suburb rich stats (Task 14), SEO/sitemap (Task 16). All spec sections map to a task.
- **Migration number:** 000055/000056 chosen to avoid the confirmed 000054 collision with `feat/residential-housing-crawl`.
- **Type consistency:** proto fields (`sal_code`, `latest_median_price`, `yoy_pct`, `median_weekly_hhd_income`) are used identically across Go store rows (`SuburbSummaryRow`), handlers, generated TS, and components. The map seam matches the original `<SuburbMap>` contract conceptually but is upgraded to the richer `valueById`/`onFeatureClick` core; consumers updated accordingly.
- **Known follow-ups (documented, not placeholders):** (1) surfacing `region_code` on `SuburbSummary` to light up the per-suburb price chart + tooltip sparkline for priced suburbs; (2) property-portal crawl for rent/yield/days-on-market (deferred per spec §2); (3) ABS Census column keys confirmed live in Task 6 Step 1 before the parser is finalised.
