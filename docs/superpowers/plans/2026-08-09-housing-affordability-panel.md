# Housing Affordability Panel Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the frozen RPPI headline with the live derived index and add a lazy, attributed national affordability-and-credit panel to static ISR `/housing`.

**Architecture:** Keep headline data on the existing quarterly ISR overview call. Fetch every dark series client-side through `GetHousePriceSeries`, using the existing single-series chart plus a new client-only shared-scale comparison chart; gate all below-the-fold charts with `WhenVisible`.

**Tech Stack:** Next.js App Router, React Server Components, TypeScript, TanStack Query, Connect RPC, Visx, Tailwind, Jest/Testing Library, Playwright.

---

## Chunk 1: Chart data primitives

### Task 1: Add serializable chart transforms and compact formatting

**Files:**
- Create: `web/src/@/components/housing/series-data.ts`
- Create: `web/src/@/components/housing/series-data.test.ts`
- Modify: `web/src/@/components/housing/housing-series-chart.tsx`

- [ ] **Step 1: Write failing transform/formatter tests**

Test that `toSeriesPoints` converts protobuf-like points to dated values;
`transformSeries(points, "yoy")` compares the same UTC month one year earlier,
skips missing/zero bases, and returns percentages; and `formatHousingValue`
formats percent/index plus AUD values at dwelling, billion, and trillion scales.

- [ ] **Step 2: Run the test and verify the expected module-not-found failure**

Run: `cd web && npx jest src/@/components/housing/series-data.test.ts --runInBand`

- [ ] **Step 3: Implement the pure helpers and wire serializable keys**

Export `HousingSeriesFormat = "aud" | "percent" | "index"` and
`HousingSeriesTransform = "level" | "yoy"`. `HousingSeriesChart` gains an
optional `transform` prop, calls the helpers, and keeps functions entirely on
the client side.

- [ ] **Step 4: Re-run the focused test and confirm it passes**

Run: `cd web && npx jest src/@/components/housing/series-data.test.ts --runInBand`

- [ ] **Step 5: Commit**

Run: `git add web/src/@/components/housing/{series-data.ts,series-data.test.ts,housing-series-chart.tsx} && git commit -m "feat(housing): add affordability chart transforms"`

## Chunk 2: Multi-series comparison

### Task 2: Add a lazy client-only housing comparison chart

**Files:**
- Create: `web/src/@/components/housing/housing-multi-line-chart.tsx`
- Create: `web/src/@/components/housing/housing-comparison-chart.tsx`
- Modify: `web/src/@/components/housing/housing-charts.tsx`
- Create: `web/src/@/components/housing/housing-comparison-chart.test.tsx`
- Create: `web/src/@/components/housing/housing-multi-line-chart.test.ts`

- [ ] **Step 1: Write a failing component test**

Mock `getHousePriceSeriesClient` and the presentational chart. Assert the
comparison component requests each serialized measure, drops series with fewer
than two valid points, keeps successful series when another response is empty,
passes labelled transformed points to the renderer, and produces the no-data
state when every response is empty. Unit-test the presentational chart's shared
domain helper against the combined extent of all supplied series.

- [ ] **Step 2: Run the test and verify the missing component failure**

Run: `cd web && npx jest src/@/components/housing/housing-comparison-chart.test.tsx src/@/components/housing/housing-multi-line-chart.test.ts --runInBand`

- [ ] **Step 3: Implement comparison fetch and presentation**

`HousingComparisonChart` is a `"use client"` component using one TanStack query
with `Promise.all` over the existing client action. It accepts two or three
serializable `{ measure, label }` definitions and renders available series.
`HousingMultiLineChart` draws a shared time/value scale with amber, slate, and
rust lines, an accessible labelled SVG, legend, and hover tooltip. Export it
only through the existing `"use client"` `housing-charts.tsx` loader using
`dynamic(..., { ssr: false })`.

- [ ] **Step 4: Re-run focused comparison and existing chart-domain tests**

Run: `cd web && npx jest src/@/components/housing/housing-comparison-chart.test.tsx src/@/components/housing/housing-multi-line-chart.test.ts --runInBand`

- [ ] **Step 5: Commit**

Run: `git add web/src/@/components/housing/{housing-multi-line-chart.tsx,housing-multi-line-chart.test.ts,housing-comparison-chart.tsx,housing-comparison-chart.test.tsx,housing-charts.tsx} && git commit -m "feat(housing): compare affordability series"`

## Chunk 3: Route integration and QA

### Task 3: Build the affordability panel and wire the live derived index

**Files:**
- Create: `web/src/@/components/housing/affordability-panel.tsx`
- Create: `web/src/@/components/housing/affordability-panel.test.tsx`
- Modify: `web/src/app/housing/page.tsx`
- Create: `web/src/app/housing/__tests__/page.test.tsx`
- Create: `web/e2e/housing-affordability.spec.ts`

- [ ] **Step 1: Write a failing panel contract test**

Mock the chart loader and visibility gate. Assert the exact heading
`Affordability & credit`, the three group headings, exact chart membership for
all thirteen requested measures, the two comparison groups, `yoy` transforms
for rents and wages, `AUS` region keys, each descriptive tile's unit/frequency,
and exact source/table plus CC BY 4.0 label for every chart card. Assert the
module has no `"use client"` directive and hands only serializable definitions
to chart exports from the loader.

Also write a route test mocking `getHousingOverview` and heavy child modules.
Assert `price_index_derived` populates the BigStat and chart, no rendered text
mentions RPPI/8-capital/to 2021, `revalidate === 3600`, the component takes no
`searchParams`, and no server monthly-series action is imported or called.

- [ ] **Step 2: Run the component test and verify the missing panel failure**

Run: `cd web && npx jest src/@/components/housing/affordability-panel.test.tsx src/app/housing/__tests__/page.test.tsx --runInBand`

- [ ] **Step 3: Write and run the feature E2E red**

Add coverage for the live-derived headline/methodology, comparison legend
labels, per-card attribution, and affordability-measure RPC request bodies not
being observed before scrolling the lazy section near the viewport but being
observed afterward. The test may skip with a precise reason when the housing API
fixture is unavailable.

Run: `cd web && npx playwright test e2e/housing-affordability.spec.ts --project=chromium --reporter=line`

Expected: FAIL because the route has not yet rendered the new panel/index copy.

- [ ] **Step 4: Implement the panel and route wiring**

Create responsive descriptive tiles and grouped chart cards. Keep
`affordability-panel.tsx` a server component containing serializable definitions
only, and wrap every chart in `WhenVisible`. In `page.tsx`, look up
`price_index_derived`, replace all RPPI copy with the explicit Shorted/ABS
rebase methodology and CC BY 4.0 credit, add its `format="index"` chart, and
render the panel below the primary housing content. Preserve
`export const revalidate = 3600` and avoid server `searchParams`.

- [ ] **Step 5: Run Jest green**

Run:

`cd web && npx jest src/@/components/housing/series-data.test.ts src/@/components/housing/housing-comparison-chart.test.tsx src/@/components/housing/housing-multi-line-chart.test.ts src/@/components/housing/affordability-panel.test.tsx src/app/housing/__tests__/page.test.tsx --runInBand`

- [ ] **Step 6: Run the feature E2E green**

Run: `cd web && npx playwright test e2e/housing-affordability.spec.ts --project=chromium --reporter=line`

If the required API fixture is unavailable, record the exact skip/failure and
list the flow for hand verification.

- [ ] **Step 7: Run full required validation**

Run:

```bash
cd web
npx tsc --noEmit
npx jest src/@/components/housing/series-data.test.ts src/@/components/housing/housing-comparison-chart.test.tsx src/@/components/housing/housing-multi-line-chart.test.ts src/@/components/housing/affordability-panel.test.tsx src/app/housing/__tests__/page.test.tsx --runInBand
SKIP_VERSION_BUMP=1 npm run bundle:budget
```

After the bundle build, parse `.next/prerender-manifest.json` and assert
`routes["/housing"].initialRevalidateSeconds === 3600`. Record the bundle-budget
exit/result and `/housing` first-load JS from the generated report. Run
`git diff --check` and review the complete scoped diff.

- [ ] **Step 8: Commit**

Run: `git add web/src/@/components/housing/affordability-panel.tsx web/src/@/components/housing/affordability-panel.test.tsx web/src/app/housing/page.tsx web/src/app/housing/__tests__/page.test.tsx web/e2e/housing-affordability.spec.ts && git commit -m "feat(housing): surface affordability and credit panel"`
