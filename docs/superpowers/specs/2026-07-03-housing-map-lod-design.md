# Housing map — level-of-detail (LOD) suburb rendering

**Status:** IMPLEMENTED (2026-07-03) — approved with the recommended options
(zoom-scale switch + viewport culling + rich hover + SVG). Browser-validated with
real prod data; suburb DOM stays capped at 800 paths at any zoom (vs ~4,500 all-NSW).
**Date:** 2026-07-03
**Area:** `web/src/@/components/housing/housing-zoom-map.tsx`, new
`web/src/@/lib/housing/map-lod.ts` (+ tests), `web/src/app/housing/page.tsx`

## Outcome (as built)

- `map-lod.ts`: pure `detailLevelForScale` / `viewportInProjected` / `projectedCenter` /
  `cullFeatures` (generic, area-capped) / `focusedStateFor` (smallest containing bbox →
  ACT-over-NSW; nearest fallback) + `StateStat`. 14 unit tests.
- `housing-zoom-map.tsx`: hybrid model — `detail = k ≥ SUBURB_SWITCH_SCALE(4) || enteredState`;
  focused state follows the viewport centre past the switch, sticks to the clicked state
  below it; suburbs render viewport-culled (`CULL_CAP=800`) with precomputed path `d` +
  bounds; throttled (120ms) view updates + gesture-end flush; d3-zoom `end` clears the
  entered state below `EXIT_SCALE(1.5)`; state hover shows a `StateHoverCard`
  (median/YoY/QoQ/capital).
- `page.tsx`: builds `Map<state, StateStat>` from the same `GetHousingOverview` capitals.
- Validated: national=8 paths + rich hover; click NSW → 800 culled paths; deep zoom (k=21,
  Sydney) → still 800, viewport-local; zoom out → layer unmounts (8 paths). 0 console errors.
- NOT added: a Playwright e2e (needs full stack + prod data → flaky in CI); the bounded-DOM
  property is locked by the `cullFeatures` cap unit test + manual browser verification.
  Geometry simplification / Canvas (phase 5) deferred — culled SVG was smooth at k=21.

## Problem

The zoom map renders states nationally, and on entering a state it loads that
state's **entire** suburb TopoJSON (NSW/VIC/QLD ≈ 1.3 MB each, thousands of
suburbs) and renders **every** suburb `<path>` at once. Consequences:

- Thousands of SVG nodes mount on drill-in → slow first paint, janky pan/zoom, memory.
- Suburbs only appear on an explicit state **click**; manually zooming in does not reveal them.
- The national state hover shows only name + median — thin.

## Goals

1. Don't render all suburbs by default. Show per-suburb detail only past a zoom
   **switch point**, and only for suburbs **in the viewport**.
2. New **state-level hover stats** at the national level.
3. Optimise rendering speed + memory: bounded DOM node count at any zoom.

Non-goals (YAGNI): 3D/tilt, clustering labels, search-highlight changes, changing
the separate `/housing/[state]` page (this is the national zoom map only).

## Design

### 1. Zoom-driven LOD (the "switch point") — REC: zoom-scale threshold

Drive detail off the live d3-zoom scale `k` (already available in the zoom event
transform), not off an explicit click:

- `detailLevelForScale(k)` → `"national" | "suburb"` using a tuned
  `SUBURB_SWITCH_SCALE` (≈ the scale at which one state fills the viewport).
- Below threshold: render only the 8 state paths; suburb layer **unmounted**;
  state hover active.
- At/above threshold: resolve the **focused state** (below), lazy-load its
  suburb TopoJSON + rows, render **viewport-culled** suburbs.
- Clicking a state stays as a **shortcut**: `flyTo(frameOf(state))` pushes `k`
  past the threshold → the same LOD path reveals suburbs. Zooming back out below
  the threshold unmounts the suburb layer.

_Alternative considered:_ keep click-to-enter only and just optimise the render.
Rejected — it doesn't satisfy "allow zoom in then show per-suburb at a switch point".

### 2. Viewport culling — REC: only render visible suburbs

- Derive the current viewport rect in **projected** coordinates from the zoom
  transform + width/height.
- On suburb-topojson load, precompute each feature's projected bounds **once**.
- On pan/zoom (throttled to one pass per animation frame), `cullFeatures(features,
  viewport, cap)` returns only features whose bounds intersect the viewport (+ a
  small margin), capped at `CULL_CAP` (≈ 800; prefer larger-area features if over cap).
- Result: suburb DOM stays ≤ ~800 paths regardless of state size.

_Alternative considered:_ render the whole active state (simpler) — rejected on
perf; NSW alone is thousands of paths.

### 3. Focused-state resolution

At suburb zoom, the focused state = the state whose feature contains the viewport
**center** (fallback: largest viewport overlap). Panning across a border changes
it → load the new state's suburbs. Keep an **LRU of 1–2** parsed suburb topojsons
(react-query cache is already `staleTime/gcTime: Infinity`) so crossing back is instant.

### 4. State hover stats (new) — REC: rich card

On state hover (national level) show a small card: greater-capital **median**,
**YoY %**, **QoQ %**, capital-city name. Source = the housing-overview data the
`/housing` page already fetches for its tiles. Implementation: widen the map prop
from `valueByStateCode: Map<string, number>` to `Map<string, StateStat>`
(`{ median, yoyPct, qoqPct, capital }`); the server page builds it from the same
`GetHousingOverview` result. No new RPC.

### 5. Rendering tech — REC: SVG + culling + simplified geometry

Stay SVG (keeps CSS theming, crisp non-scaling strokes, trivial hover/click
hit-testing) but add culling (§2) and optional **zoom-appropriate geometry
simplification**: a lower-vertex suburb variant for the mid-zoom band, full detail
only at deep zoom (can be a build-time pre-simplification in `scripts/geo`).

_Open fork (my rec = SVG):_ Canvas for the suburb layer maxes throughput for
thousands of shapes but loses CSS styling and needs manual hit-testing/tooltips — a
larger rewrite. Recommendation: ship SVG + culling first; revisit Canvas only if
culled SVG still janks at deep zoom. **This is the one choice most worth confirming.**

## Components / files

- `housing-zoom-map.tsx` — refactor the growing component: extract LOD/culling/focus
  into small hooks so each is testable and the file stays focused:
  - `useZoomLevel()` — track `k`, expose `detailLevel` + current projected viewport.
  - `useFocusedState()` — resolve + lazy-load the focused state's suburbs (LRU).
  - `useViewportCull()` — precompute bounds, cull per frame.
- New **pure, dependency-free** helpers (unit-tested, colocated in `@/lib/housing/`):
  - `detailLevelForScale(k)`, `cullFeatures(features, viewport, cap)`,
    `focusedStateFor(center, stateFeatures)`. (`suburbLayerStatus` already exists.)
- `use-topojson.ts` — unchanged (already lazy + cached).
- `/housing` server page — build and pass the richer `StateStat` map.

## Testing

- **Unit (jest, pure):** `detailLevelForScale` (below/at/above threshold),
  `cullFeatures` (bounds-intersection, margin, cap ordering, empty), `focusedStateFor`
  (center-in-feature, border fallback).
- **Browser (Playwright):** (a) manual zoom past threshold reveals suburbs without a
  click; (b) zoom out unmounts them; (c) pan across a state border swaps the loaded
  state; (d) state hover shows the rich card; (e) assert suburb `<path>` count stays
  ≤ CULL_CAP via `page.evaluate` at deep zoom (the load-bearing perf assertion).

## Perf targets

- Suburb-layer DOM ≤ ~800 `<path>` at any time.
- No full-state (thousands-of-paths) mount.
- Pan/zoom culling work bounded to one rAF pass.

## Rollout

Incremental, behind the existing component (no API/DB change):
1. Pure helpers + unit tests.
2. Zoom-level LOD + unmount-below-threshold (suburbs still whole-state).
3. Viewport culling.
4. Rich state hover.
5. (Optional) geometry simplification / Canvas if still janky.
