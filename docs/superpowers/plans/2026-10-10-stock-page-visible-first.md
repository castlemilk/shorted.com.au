# Stock page: useful information first — implementation plan

> The spec was amended during execution: its section 6 (review rulings) and its inline "ruled" notes changed what this plan says in places. Where the two differ, the spec governs.

Spec (binding): `docs/superpowers/specs/2026-10-10-stock-page-visible-first-design.md`.
Read it before your task; the section ids (D1-D7, G1-G7) below refer to it.

## Global Constraints

- **Worktree:** `/Users/benebsworth/projects/shorted.com.au/.claude/worktrees/charts-sync-2026-10`,
  branch `feat/stock-page-visible-first`. Work only here. Never touch
  `/Users/benebsworth/projects/shorted.com.au` (the main checkout holds another
  session's uncommitted work).
- **Git:** never `git stash`, never push, never open a PR, never rewrite
  history.
  - Commit your task as one or more conventional commits (`feat(web): ...`,
    `fix(web): ...`, `test(web): ...`, `docs: ...`).
  - End every commit message with this exact trailer line:
    `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
- **No subagents.** Do not dispatch subagents, reviewers or helpers. Review
  comes from the controller after your report.
- **Commands** (run from `web/`):
  - Unit tests: `npx jest <paths>`. Run the suites for every file you touched,
    plus `src/app/shorts` and `src/@/components/charts` when you touch them.
  - Types: `npx tsc --noEmit -p tsconfig.json`. It must pass. `strict` and
    `noUncheckedIndexedAccess` are on.
  - Lint: `npx eslint <changed files>`, with no new errors.
  - Storybook interaction tests and Playwright must run on Node 22, because
    Playwright 1.52 hangs on Node 24.19:
    `PATH=/Users/benebsworth/.nvm/versions/node/v22.20.0/bin:$PATH npx vitest run --project=storybook <story files>`.
  - Go: never run `go clean -cache`.
- **Next.js rules** (CLAUDE.md "Stock page" and "SSR Issues"):
  - Charts are client-only, via `next/dynamic` with `ssr: false`.
  - Never import `@connectrpc/connect` into a module a server component can
    reach.
  - Every tab page keeps the literal ISR trio: `revalidate`,
    `dynamicParams = true`, and an empty `generateStaticParams`.
  - Nothing under `web/src/app/shorts/[stockCode]/` may read `searchParams`,
    `cookies()` or `headers()`, or use `no-store` / `force-dynamic`.
  - `web/src/app/shorts/__tests__/isr-source-safety.test.ts` and
    `ssr-import-safety.test.ts` must pass.
- **Design rules** (DESIGN.md):
  - Mono numerals with `tabular-nums`.
  - One lit surface per view: the header readout's `shadow-terminal-inset`.
  - Red and green only for market direction (the price change). Short-interest
    change and the short series' readout entry stay foreground.
  - Targets: a 24px floor everywhere, and 40px for primary phone controls.
  - Borders 1px, radii <= 6px, no grey drop shadows.
- **Report:** write your full report to the report file named in your dispatch.
  Return only: status (DONE / DONE_WITH_CONCERNS / NEEDS_CONTEXT / BLOCKED),
  commit SHAs, a one-line test summary, and concerns. If the plan conflicts with
  the code or the spec, follow the spec and say so in the report.

---

### Task 1: Readout model (pure) and percentage-point short series

**Goal:** a pure, fully tested module the strip (Task 2) renders, plus the
short series carrying `measureMode`. No visual change in this task.

**Files**
- Create `web/src/@/components/charts/chart-readout.ts`.
- Create `web/src/@/components/charts/__tests__/chart-readout.test.ts`.
- Modify `web/src/@/components/charts/chart-views.ts`: the short series built by
  `buildChartView` gets `measureMode: "absolute", measureUnit: "pp"`.
- Modify `web/src/@/components/charts/__tests__/chart-views.test.ts`: assert it.
- Modify `web/src/@/components/charts/StockChart.tsx`: only replace the inline
  delta maths inside `measureInfo` with `seriesDelta`. No other behaviour
  change.

**Exports of `chart-readout.ts`** (use these names)

```ts
export const READOUT_ONE_ROW_MIN_WIDTH = 640;
export const READOUT_OHLC_MIN_WIDTH = 900;
export const READOUT_ROW_H_ONE = 28;
export const READOUT_ROW_H_TWO = 44;
export const READOUT_MIN_PLOT = 160;

export type ReadoutTone = "up" | "down" | "flat";
export interface ReadoutDelta { value: number; text: string; tone: ReadoutTone; colored: boolean }
export interface ReadoutEntry {
  id: string; label: string; color: string;
  value: string | null;          // null when the series has no point to show
  change: ReadoutDelta | null;   // latest and measure states only
  dateNote: string | null;       // e.g. "5 Oct" when its point is on another Sydney day than the headline
  ohlc: { open: string; high: string; low: string; close: string } | null;
}
export type ReadoutState = "latest" | "hover" | "pinned" | "measure";
export interface ReadoutModel { state: ReadoutState; headline: string; entries: ReadoutEntry[] }
export type ReadoutFormat = (series: ChartSeriesSpec, v: number) => string;

export function formatReadoutDate(t: number): string;       // "9 Oct 2026" (en-AU, Australia/Sydney)
export function formatReadoutShortDate(t: number): string;  // "9 Oct"
export function readoutDayKey(t: number): string;           // Sydney calendar day, e.g. "2026-10-09"
export function seriesDelta(series: ChartSeriesSpec, a: ChartPoint, b: ChartPoint): ReadoutDelta;
export function buildLatestReadout(a: { series: ChartSeriesSpec[]; zoomed: boolean; viewMode: "absolute" | "normalized"; format: ReadoutFormat }): ReadoutModel;
export function buildPointReadout(a: { series: ChartSeriesSpec[]; entries: { series: ChartSeriesSpec; point: ChartPoint }[]; pinned: boolean; format: ReadoutFormat }): ReadoutModel;
export function buildMeasureReadout(a: { series: ChartSeriesSpec[]; ta: number; tb: number }): ReadoutModel;
export function readoutStripHeight(width: number): number;  // >= 640 ? 28 : 44
export function resolveReadoutMode(a: { requested: "strip" | "tooltip"; width: number; height: number; reservedH: number }): "strip" | "tooltip";
```

**Semantics**
- **`seriesDelta`:**
  - `series.measureMode === "absolute"`: `value = b.v - a.v`, two decimals,
    text like `+0.21 pp` (sign, absolute value, a space, the unit when there is
    one), `colored: false`.
  - Otherwise (relative): `value = a.v !== 0 ? (b.v - a.v) / a.v * 100 : 0`,
    one decimal, text like `+3.1%`, `colored: true`.
  - Round before deriving the sign, and normalise -0 to 0 (`Number(x.toFixed(d)) || 0`).
    The tone is `up` / `down` / `flat` from the rounded value. The sign is `+`,
    `-` or none.
- **Dates:** one module-level `Intl.DateTimeFormat("en-AU", { day: "numeric",
  month: "short", year: "numeric", timeZone: "Australia/Sydney" })` and a
  short-date twin without the year. `readoutDayKey` uses `en-CA` with Sydney's
  time zone (or equivalent) to give `YYYY-MM-DD`.
- **`buildLatestReadout`:**
  - For each series in order, take its first and last point.
  - The headline time is the max of every series' last `t`. The headline is
    `Latest · <date>` when `!zoomed`, or `<date>` when zoomed.
  - Entry:
    - `value = format(series, last.v)`.
    - `change = seriesDelta(series, first, last)`. It is null when the view mode
      is `"normalized"` or the series has fewer than two points.
    - `dateNote = formatReadoutShortDate(last.t)` when
      `readoutDayKey(last.t) !== readoutDayKey(headlineT)`.
    - `ohlc` comes from the last point when open, high, low and close are all
      numbers (each `toFixed(2)`); otherwise null.
  - A series with no points keeps an entry with `value`, `change`, `dateNote`
    and `ohlc` all null.
- **`buildPointReadout`:**
  - The headline is the date of the first entry's point.
  - One entry per series in `series` order, matched by `series.id`. A series
    without a hover entry gets value null.
  - `change: null`. `dateNote` is set when the point's day differs from the
    first entry's day. `ohlc` comes from the point.
  - The state is `pinned` or `hover`.
- **`buildMeasureReadout`:**
  - The headline is `<date ta> → <date tb>`.
  - Per series: `nearest(points, ta)` and `nearest(points, tb)` (import `nearest`
    from `chart-tooltip.ts`), then `change = seriesDelta`.
  - `value: null`. When either end is missing, `change` is null.
  - The state is `measure`.
- **`resolveReadoutMode`:** `"tooltip"` when requested; otherwise `"tooltip"`
  when `height - readoutStripHeight(width) - reservedH < READOUT_MIN_PLOT`, else
  `"strip"`.

**Tests** (`chart-readout.test.ts`): cover every rule above.
- `seriesDelta`: relative, absolute with `pp`, -0, a zero base, and the sign and
  tone.
- Latest: unzoomed and zoomed headlines.
- A short series ending four days before price: its entry carries a `dateNote`
  and price does not.
- A series with no points keeps its row with nulls.
- The normalised view has no change; a single point has no change.
- OHLC is present only when the last point has all four values.
- Point readout: a `dateNote`, and the missing-series row.
- Measure: the arrow headline and the deltas.
- `readoutStripHeight` at 639, 640 and 1200.
- `resolveReadoutMode`: requested tooltip, too short, and the strip.

**Done when** the new and touched suites pass, `npx jest src/@/components/charts`
passes, and tsc is clean.

---

### Task 2: StockChart readout strip

**Goal:** D5 in full. The default `readout="strip"` renders a fixed-height strip
above the svg. `readout="tooltip"` is today's behaviour, byte for byte.

**Files**
- Modify `web/src/@/components/charts/types.ts`: add
  `readout?: "strip" | "tooltip"` to the props type `StockChart` accepts.
- Modify `web/src/@/components/charts/StockChart.tsx`.
- Modify `web/src/@/components/charts/chart-tooltip.tsx` only if you need a
  helper, for example a reading at a given time for keyboard stepping.
- Create a strip component, for example
  `web/src/@/components/charts/chart-readout-strip.tsx`: `React.memo`, no
  `"use client"` needed because it is imported by `StockChart`'s client tree.
- Modify `web/src/@/components/charts/__tests__/StockChart.touch.test.tsx`.
- Modify `web/src/@/components/charts/StockChart.stories.tsx`.
- Modify `web/src/@/components/widgets/stock-chart-widget.tsx` and
  `time-series-widget.tsx`: pass `readout="tooltip"`.
- Modify `web/src/@/components/charts/StockChartEmbed.tsx`: pass
  `readout={chartHeight >= 260 ? "strip" : "tooltip"}`, and render the Combined
  legend row only in tooltip mode. Keep the As-of caption.
- Do not change `strategy-levels-chart.tsx`'s height (360). It takes the strip
  default. If its test stand-in types the props, add `readout` there.

**Behaviour**
- **Mode:** `const mode = resolveReadoutMode({ requested: readout ?? "strip", width, height, reservedH: margin.top + margin.bottom + brushH + oscH })`.
  `stripH = mode === "strip" ? readoutStripHeight(width) : 0`. The svg gets
  `height - stripH` with `style={{ display: "block" }}`, and `mainH` is derived
  from the svg height. The outer wrapper keeps the total `height`.
- **Strip mode:**
  - Render the strip as the first child of `[data-chart-container]`, before the
    svg, with no floating tooltip and no floating measure card.
  - The model comes from Task 1:
    - measure state: `buildMeasureReadout` (from `measureInfo`'s `ta` / `tb`);
    - pinned or hover: `buildPointReadout` on `active`, with `pinned =
      isPinnedView`;
    - otherwise: `buildLatestReadout(renderSeries, zoomed: filtered !== null,
      viewMode)`.
  - The format function uses the axis formats exactly as `TooltipContent` does.
- **Strip markup:**
  - Attributes: `data-chart-readout`, `data-readout-state={state}`,
    `data-pinned` when pinned, and `data-chart="measure-readout"` while
    measuring; `aria-live="off"`; `style={{ height: stripH }}`.
  - Classes: mono `text-xs`, `tabular-nums`, `whitespace-nowrap`,
    `overflow-hidden`.
  - One row at >= 640: headline, entries, OHLC when `width >= 900` and the
    model has OHLC, then the Pinned chip at the end.
  - Two rows below 640: row 1 is the headline with the Pinned chip
    right-aligned; row 2 is the entries.
- **Entry:** an 8px colour dot (`aria-hidden`), the label (muted), the value
  (foreground), the change, and the `dateNote` (muted, `· 5 Oct`).
  - The change is coloured `#16a34a` up and `#dc2626` down only when
    `change.colored`. A percentage-point change stays foreground with a `▲` or
    `▼`.
  - A null value shows `—`.
  - Give the value and change cells min widths so hovering does not jitter the
    row.
- **Pinned chip:** the text "Pinned" and a button. The button has
  `aria-label="Release pinned reading"`, `title="Tap the chart to move the
  reading; tap it again to release"`, and a target of at least 24px. On click:
  `unpin()`, then focus the chart container.
- **Announcer:** a persistent sibling `<div role="status" className="sr-only"
  data-chart-announcer>`, always rendered in both modes. On pin it gets one
  sentence, for example `Pinned 6 Oct 2026: Price $43.21, Short % 3.20%`; on
  unpin, `Reading released`. Never on a scrub.
- **Keyboard (both modes):**
  - The chart container gets `tabIndex={0}`, a focus-visible ring and an
    `aria-label` such as "Chart. Use the left and right arrow keys to step
    through readings, Escape to release."
  - ArrowLeft and ArrowRight pin the reading at the previous or next rendered
    point of the series with the most rendered points, starting from the last
    point when nothing is pinned. Home and End go to the first and last point.
    Escape unpins.
  - `preventDefault` only for the keys you handle.
- **Pin, hover, scrub, re-tap and the document press-outside unpin:** unchanged
  (`useChartPointer`). The strip sits inside the container, so a tap on it does
  not trip the press-outside unpin. In tooltip mode the old card keeps its
  guidance line. In strip mode there is no guidance line.
- **Performance:** memoise the latest model on
  `[renderSeries, leftAxis?.format, rightAxis?.format, viewMode, filtered]`, and
  build no `Intl` formatter per render.
- **Tooltip mode:** keep the existing floating tooltip, docking and floating
  measure card exactly as they are.

**Tests**
- In `StockChart.touch.test.tsx`, run each interaction suite whose assertions
  are mode-agnostic (pin, release, re-tap, document unpin, mouse hover) with
  `describe.each(["strip", "tooltip"] as const)`, with a helper that reads the
  reading from `[data-chart-readout]` in strip mode or `[data-chart-tooltip]` in
  tooltip mode. Keep the placement and docking suite with `readout="tooltip"`.
  Update the date helper to the en-AU / Sydney format where the strip is read.
- Add the G6 strip tests:
  - the svg `height` attribute equals the height prop minus 44 at width 360,
    and minus 28 at width 900;
  - the strip's inline height is identical in latest, hover, pinned and measure
    states, and when hovering a point with OHLC and one without;
  - no `position: absolute` descendant inside the container while hovering or
    pinned in strip mode;
  - the strip precedes the svg in document order;
  - the latest headline contains "Latest" and loses it after a zoom (brush or
    measure commit);
  - no change in the normalised view;
  - a series with no points in range keeps its row;
  - `data-readout-state` follows the state;
  - the announcer text changes on pin and on unpin;
  - focus moves to the container after release;
  - ArrowRight, ArrowLeft, Home, End and Escape behave as specified;
  - the MIN_PLOT fallback renders a tooltip at height 200.
- Stories: `TooltipTracksCursor` and `MobileTouchPinned` get `args.readout =
  "tooltip"` (or the equivalent), so they keep testing the card. Add a
  `ReadoutStrip` story with a play function that asserts the strip's
  `getBoundingClientRect().height` is equal before hover, during hover and when
  pinned, and that the svg's box does not intersect the strip.
  `MeasureAndZoom` must still pass: the strip carries
  `data-chart="measure-readout"` while measuring and its text has a signed
  number, `%` and `pp`.
- Run `npx jest src/@/components/charts src/@/components/widgets src/@/components/strategy`
  and the storybook project for `StockChart.stories.tsx` and
  `StockChartEmbed.stories.tsx` (Node 22).

---

### Task 3: StockChartPanel: phone controls, CSS height, settings store, shared skeleton

**Files**
- Modify `web/src/@/components/charts/StockChartPanel.tsx`.
- Modify `web/src/@/components/charts/StockChart.tsx`: the `height` prop becomes
  optional. Without it, `StockChart` uses `ParentSize`'s measured height, and
  its wrapper fills the parent (`height: 100%`). With it, behaviour is
  unchanged. Return null while the measured height is under 10.
- Create `web/src/@/components/charts/chart-prefs.ts` and
  `__tests__/chart-prefs.test.ts`.
- Create `web/src/@/components/charts/stock-chart-section.tsx`: server-safe, no
  `"use client"`, no Connect imports. It exports:
  - `CHART_BOX_HEIGHT_CLASS = "h-[360px] sm:h-[420px]"`;
  - `StockChartHeading({ title = "Price & short interest", id = "stock-chart-heading" })`:
    an `h2` (`text-lg font-semibold tracking-tight`) and the hint "Toggle
    series, zoom, and compare · ASIC daily, T+4" in a span that is
    `hidden sm:inline`, laid out as today's layout heading row (`mb-2`);
  - `StockChartPanelSkeleton()`: the same rows as the panel, see below. Mark it
    `aria-hidden`; the route `loading.tsx` owns `role="status"`.
- Modify `web/src/@/components/charts/StockChartPanel.stories.tsx`: add a
  390x900 phone story and a `prefsKey` story.
- Add a panel unit test, for example
  `web/src/@/components/charts/__tests__/StockChartPanel.test.tsx`, mocking
  `useStockChartData` and `StockChart`.

**Behaviour**
- **Props:** add `prefsKey?: string`. Keep `defaultPeriod` and `defaultView`.
  `height?: number`: when given, the chart box is that many px; when omitted,
  the box uses `CHART_BOX_HEIGHT_CLASS` and `StockChart` gets no height. The
  loading, empty and error boxes use the same class or height.
- **Controls with CSS grid areas, one instance of each control:**
  - Below `sm`:
    - areas `"view embed" / "legend legend" / "chart chart" / "period period" / "toggles toggles"`;
    - the top row is `h-10`;
    - the period row is `h-10`, its segmented buttons are evenly spaced
      (`flex-1`) with `min-h-10` targets;
    - the toggles row (corr chip, SMA 20, Divergence) is `h-9`,
      `flex-nowrap overflow-x-auto`.
  - At `sm` and up:
    - areas `"view toggles period embed" / "legend legend legend legend" / "chart chart chart chart"`;
    - one `h-8` row, with the toggles right-aligned before the period control,
      as today.
  - The legend area (the divergence legend) renders only when divergence is on,
    as today.
  - Gaps are `gap-3`.
  - Buttons: `min-h-10 sm:min-h-0`; keep today's sizes from `sm`.
- **Settings store (`chart-prefs.ts`):** a module-level store.
  - The period lives under `period:<STOCKCODE>`.
  - `view`, `showMA` and `showDivergence` live under `prefsKey`.
  - Export `useChartPrefs({ stockCode, prefsKey, defaults })` returning
    `[prefs, setPrefs]`. With no `prefsKey` it is plain local state with
    nothing stored; the period is still read from and written to the per-stock
    key only when a `prefsKey` is given.
  - Initialise from the store on first render (the panel is client-only).
  - Export a test-only reset.
- **Skeleton:** the heading row is not included (the pages render
  `StockChartHeading` themselves). Then:
  - the top controls row (`h-10 sm:h-8`);
  - `mt-3` and a box with `CHART_BOX_HEIGHT_CLASS`;
  - below `sm` only: `mt-3` with an `h-10` period row and `mt-3` with an `h-9`
    toggles row.

  These match the panel exactly, so a hydrated panel lands on the skeleton's
  footprint.
- **Tests:**
  - The store: defaults, per-stock period sharing across two keys, per-key view,
    no persistence without a key, and the reset.
  - The panel: choosing 6M, unmounting and remounting with the same `prefsKey`
    restores 6M; Short interest's default view stands when its key is empty.
  - The skeleton and panel use the same height class constant (import it in
    both).
  - Run `npx jest src/@/components/charts` and the storybook project for
    `StockChartPanel.stories.tsx` (Node 22).

---

### Task 4: StockHeader and the sticky tab bar (components)

**Files**
- Create `web/src/@/components/company/stock-header.tsx`: a server component,
  no `"use client"`, no Connect imports.
- Create `web/src/@/components/company/__tests__/stock-header.test.tsx`.
- Modify `web/src/@/components/company/stock-tab-nav.tsx`.
- Modify `web/src/@/components/company/__tests__/stock-tab-nav.test.tsx`.
- Do NOT wire the header into the layout yet (Task 5 does).

**StockHeader** (spec D1)
- Props: `{ stockCode: string; stock: Stock; change30d: number | null; asOf: Date | null }`.
  `Stock` comes from `~/gen/stocks/v1alpha1/stocks_pb`.
- Name: `cleanCompanyName(stock.name || stockCode, stockCode)` from
  `web/src/app/shorts/[stockCode]/stock-page-shared.ts`. Industry from
  `stock.industry`.
- **Identity:**
  - A fixed box: `relative h-10 w-10 shrink-0 sm:h-12 sm:w-12`.
  - Inside it, `<Suspense fallback={<placeholder of the same box>}>` around an
    async `StockHeaderLogo` that awaits `getStockDetails(stockCode)` (cached).
    It renders `CompanyLogo` filling the box (pass `size={48}` and classes so
    the image is `h-full w-full object-contain`) and, when
    `enrichmentStatus === "completed"`, a 14px sparkle badge at the box's
    corner (`role="img"`, `aria-label="AI-enhanced data available"`).
  - A null or failed details read renders the logo fallback (`CompanyLogo`'s
    own fallback).
  - Next to the box: a line with the code (mono, semibold) and the industry
    `Badge`, omitted when empty. Under it, the name as
    `<h2 className="font-mono text-lg font-bold leading-tight line-clamp-2 sm:line-clamp-1 sm:text-xl">`,
    with `title` set to the full name.
- **Readout:** a `<dl>` with three items.
  - **Short interest:** the value `percentageShorted.toFixed(2) + "%"` in large
    mono (`text-2xl`). Under it, when `change30d !== null`: `▲` / `▼` / `–`, then
    `Math.abs(change30d).toFixed(2) + " pp"`, then "30d". It is always
    foreground: no red, no green, no amber. When `asOf` is known, "as of
    <formatAsOfDate(asOf)>".
  - **Reported shorts:** `formatNumber(stock.reportedShortPositions)`.
  - **Shares on issue:** `formatNumber(stock.totalProductInIssue, 3)`.
  - Labels are uppercase mono 10-11px and muted. Values are `tabular-nums`.
- **Container:** `<section aria-labelledby={nameId} className="mb-4 rounded-lg border bg-card shadow-terminal-inset ...">`.
  Below `sm` the identity sits above the readout; from `sm` the identity is
  left and the readout right, in one row. Move the One Bloom comment from
  `company-stats-view.tsx` here.
- **Height budgets** (D1): <= 140px on a phone with a one-line name and <= 165px
  with two lines; <= 110px on desktop. Keep padding tight (`px-4 py-3`).
- **Tests:**
  - The code, the `h2` name, the badge, and the short % to two decimals.
  - The change with an arrow and "pp" when non-null; omitted when null.
  - No `text-red`, `text-green` or `text-amber` class on the change.
  - Reported shorts and shares on issue are formatted.
  - "as of" shows when `asOf` is set and is omitted when null.
  - Exactly one element with `shadow-terminal-inset`.
  - The logo fallback renders in the same box classes (mock `getStockDetails`
    and `CompanyLogo`).

**StockTabNav** (spec D2)
- Render a fragment: a zero-height in-flow sentinel
  `<div ref={sentinelRef} aria-hidden="true" className="h-0" />`, then
  `<nav aria-label="Stock sections" className="sticky top-16 z-30 -mx-8 mb-4 border-b border-border bg-background/90 px-8 backdrop-blur supports-[backdrop-filter]:bg-background/75">`.
- The list keeps `ref={listRef}` and `relative`, as `flex h-11 items-stretch
  gap-1 overflow-x-auto`.
- Links:
  - classes `relative inline-flex shrink-0 items-center px-3 font-mono text-sm
    transition-colors`;
  - active: `font-semibold text-foreground` plus a 2px Burnt Amber underline at
    the bottom (`bg-primary`), drawn with a pseudo-element or a span;
  - inactive: `text-muted-foreground hover:text-foreground`;
  - no opaque `bg-muted` track.
- Keep: `prefetch={false}`, intent prefetch (`onPointerEnter`, `onTouchStart`,
  `onFocus`), `aria-current`, and the active-tab horizontal scroll effect.
- Add:
  - `scroll={false}` on each `Link`.
  - `onClick={() => { pendingClick.current = true; }}`.
  - An isomorphic layout effect
    (`typeof window !== "undefined" ? useLayoutEffect : useEffect`) keyed on
    `active`. It skips the first run. When `pendingClick.current` is true, it
    resets the flag, then computes
    `dockY = sentinel.getBoundingClientRect().top + window.scrollY - (parseFloat(getComputedStyle(nav).top) || 64)`;
    if `window.scrollY > dockY + 1` it calls
    `window.scrollTo({ top: dockY, left: window.scrollX })`.
- **Tests:**
  - Each link has scroll disabled (extend the existing `next/link` mock to
    expose it).
  - With `scrollY` above `dockY`, a click then a pathname change calls
    `scrollTo` with `dockY`.
  - With `scrollY` below `dockY` there is no call.
  - A pathname change without a click (back or forward) makes no call.
  - The nav has the sticky classes.
  - The existing assertions still pass.

Run `npx jest src/@/components/company`.

---

### Task 5: Recompose the stock pages

**Files** (all under `web/src/` unless noted)
- `app/shorts/[stockCode]/layout.tsx`: the order becomes breadcrumbs (`mb-4`),
  then `<StockHeader stockCode stock change30d={deltas.change30d} asOf={latestShortDate} />`,
  then `<StockTabNav stockCode />`, then `{children}`.
  - Remove the login slot, the profile and stats grid, `ShortInterestSummary`,
    `StockThemeChips`, and the chart section with its `nextDynamic`.
  - Keep the same reads and the 404 / transient handling. Fix the comments.
- `app/shorts/[stockCode]/page.tsx` (Overview), body order per spec D4. Keep the
  JSON-LD and sr-only section first and unchanged. Then:
  - the chart section `<section aria-labelledby="stock-chart-heading" className="mb-4 min-w-0">`
    with `<StockChartHeading />` and a `nextDynamic` `StockChartPanel`
    (`ssr: false`, `loading: () => <StockChartPanelSkeleton />`,
    `prefsKey={`${stockCode}:overview`}`, `defaultView="combined"`), full width
    above the existing grid;
  - the About card `<section aria-labelledby="overview-about-heading" className="mb-4 rounded-lg border bg-card px-4 py-3">`:
    - an `h2` (`text-sm font-medium`) "About <companyName>";
    - the description from `getStockDetails(stockCode)` (wrap in `.catch(() => null)`),
      `enhancedSummary || summary`, in `<p className="mt-1 line-clamp-3 text-sm text-foreground">`,
      omitted when empty, followed by a "Company profile →" link to
      `stockTabHref(stockCode, "company")` with `prefetch={false}`;
    - `ShortInterestSummary` with a new `variant="bare"` (no border or
      background, same text);
    - `StockThemeChips` (`className="mt-3"`);
  - the login slot, moved verbatim from the layout:
    `<div className="login-slot"><SignedOutOnly><div className="overflow-hidden rounded-lg border border-primary/20"><LoginPromptBanner /></div></SignedOutOnly></div>`;
  - the existing grid, unchanged.

  New reads: `getShortInterestDeltas(stockCode)` (already non-throwing) and
  `getStockDetails`. Both are cached; add no other backend calls. Fix the
  sr-only section's comment that names the layout's `CompanyProfile`.
- `app/shorts/[stockCode]/short-interest-summary.tsx`: add
  `variant?: "card" | "bare"` (default `"card"`, today's markup). `"bare"` drops
  the border, background and padding.
- `app/shorts/[stockCode]/short-interest/page.tsx`: the chart section first,
  with `<StockChartHeading title="Short interest chart" />` and a `nextDynamic`
  `StockChartPanel` (`prefsKey={`${code}:short-interest`}`, `defaultView` set to
  `"short"` when the page has short history, otherwise `"combined"`, using the
  page's existing history check). Then the existing content. Fix the "chart is
  in the layout" comment.
- `app/shorts/[stockCode]/loading.tsx`: first an `h-7 mb-2` heading
  placeholder, then `<StockChartPanelSkeleton />`, then an About-card
  placeholder (`h-28 rounded-lg mb-4`), then the existing grid skeleton. Keep
  its `role` and `aria` attributes.
- `short-interest/loading.tsx`: the same heading placeholder and chart skeleton
  first, then the existing blocks.
- `app/shorts/[stockCode]/error.tsx`: derive the code from `usePathname()` or
  `window.location.pathname` with `/^\/shorts\/([^/]+)/i`, uppercased. Never
  use the last segment.
- `app/shorts/[stockCode]/strategy/page.tsx`: the element with
  `id="strategy-chart"` gets `scroll-mt-[124px]`. Correct the comment that says
  the levels chart shares the layout chart's cache: say it shares the Overview
  chart's 1y queries when the visitor came from a chart tab. Grep the tab pages
  for any other `id=` used as a hash target and give each the same scroll
  margin.
- `company/page.tsx`, `news/page.tsx`: comment fixes ("as the chart in the
  layout is").
- `@/components/company/company-insights-card.tsx` (Company tab): the accordion
  opens by default the item that holds the enhanced summary (`defaultValue`).
  Fix its stale "Renders on the Overview tab only" comment, and the one in
  `enriched-company-section.tsx`.
- `@/components/ui/login-prompt-banner.tsx`: one line, `h-11`, at every width.
  - A 16px Sparkles icon.
  - The text is `truncate text-sm`: below `sm` "Sign in for alerts and
    portfolios"; from `sm` "Sign in to unlock custom dashboards, portfolio
    tracking and real-time alerts".
  - `SignIn size="sm" variant="ghost"`, and the 32px dismiss button that still
    removes `html.anon`.
- `styles/critical-css.ts`: `.login-slot { min-height: 0; }` and
  `html.anon .login-slot { min-height: 46px; margin-bottom: 1rem; }`. Remove the
  breakpoint overrides. Update the comment: Overview only, one line, the 44px
  banner plus the 2px wrapper border. The controller re-measures in a browser.
- Delete `@/components/ui/companyProfile.tsx`, `companyStats.tsx`,
  `company-profile-view.tsx`, `company-stats-view.tsx`,
  `company-profile-with-retry.tsx` and `company-stats-with-retry.tsx`, after
  `grep -rn` confirms no importer outside tests and the layout. Delete or
  retarget their tests: `ui/__tests__/component-exports.test.ts` entries,
  `ui/__tests__/companyStats.test.tsx`, and the `page-all-imports`,
  `page-component-imports` and `page-ssr` name lists. Point the comments in
  `company/stock-evidence-panel.tsx` and `ui/company-info-view.tsx` at
  `StockHeader`.
- `app/shorts/__tests__/ssr-import-safety.test.ts`:
  - `CONNECT_ISLANDS`: `layout.tsx` gets none; `page.tsx` gets
    `StockChartPanel`; `short-interest/page.tsx` adds `StockChartPanel`.
  - `KNOWN_CLIENT_CONNECT`: remove `layout.tsx`'s
    `company-profile-with-retry` and `company-stats-with-retry`.
  - Update the doc comments and the list near the top.
- `app/shorts/[stockCode]/__tests__/layout.test.tsx`:
  - the order is breadcrumbs, header, tab-nav, child (mock `StockHeader` with a
    testid);
  - the as-of tests read the header mock's props (`asOf`);
  - keep the 404, transient and series-read-ordering tests;
  - add an assertion that the layout loads no `StockChartPanel`.
- `app/shorts/[stockCode]/__tests__/page-runtime.test.tsx`: `SignedOutOnly` and
  `<StockThemeChips` are now expected in `page.tsx`'s source, and the layout's
  source must contain neither `StockChartPanel` nor `ShortInterestSummary`.
- `page-old-api.test.tsx`: drop the dead layout-leftover mocks. Add an
  assertion that the Overview renders the short-interest prose (un-mock
  `ShortInterestSummary`; mock `getShortInterestDeltas` and `getStockDetails`).
- `short-interest/__tests__/page.test.tsx`: the island count becomes 4, with
  the chart island first. Adjust the heading assertions for the chart section's
  `h2`.

**Done when** `npx jest src/app/shorts src/@/components` passes, tsc is clean,
eslint shows no new errors on the changed files, and
`grep -rn "chart lives in the layout\|chart is in the layout\|chart in the layout" web/src`
finds nothing stale.

---

### Task 6: End-to-end specs

**Files:** `web/e2e/stock-tabs.spec.ts`, and `web/e2e/content-paint.spec.ts`
(update comments; keep its following-sibling tab-content lookup working; the
Overview still has `section[aria-labelledby="stock-chart-heading"]`).

**Build and run locally.** The recipe is in the header of `stock-tabs.spec.ts`:
`SKIP_ENV_VALIDATION=1 NEXT_PUBLIC_API_URL=https://api.shorted.com.au npx next build`,
then start on :3020 with the three API env vars, then the Playwright runner on
Node 22 with `--project=chromium --workers=1`.

**Changes to `stock-tabs.spec.ts`**
- Replace "every tab is a route; the chart node survives; back returns" with
  "every tab is a route; charts live on Overview and Short interest; settings
  survive; back returns". Check:
  - the seven links;
  - `[data-chart-container]` visible on Overview and Short interest, and count
    0 on Strategy (the levels chart is `[data-strategy-chart]`; check that its
    container is not counted, or scope to the section), Financials, Company,
    News and Community;
  - on Overview, press period `6M`, go to Financials then back to Overview via
    the tab bar, and the `6M` button is `aria-pressed=true`;
  - no new request for the chart's price or short series on that return
    (identify the request URLs from `use-stock-chart-data.ts` and its query
    hooks);
  - browser back returns to the previous tab.
- Community thread test: `[data-chart-container]` toHaveCount(0). Keep the
  single `<main>` and single nav assertions.
- 390px test: remove the scroll-into-view step and its comment. The bar is in
  the first screen now.
- New: "the chrome leaves the content in the first screen".
  - At 390x844: the nav's top <= 340 and the first visible block after the nav
    starts <= 400 on Overview, Financials and News (signed out).
  - At 1280x900: the nav's top <= 280.
  - On the phone Overview, `[data-chart-container]`'s top <= 480 and its bottom
    <= 844.
- New: "the tab bar docks and a docked switch keeps the new tab under it", at
  390 and 1280:
  - scroll to 1200 on Overview; the nav's `boundingBox().y` is between 60 and
    66;
  - click Company; after the URL changes the nav is still at 60-66 and the
    first visible block of the new tab starts at >= the nav's bottom and <= the
    nav's bottom + 40;
  - from the top of the page (`scrollY` 0) a click leaves `scrollY` at 0.
- New: "a phone tap pins the readout without moving the plot", at 390x844 on
  Overview:
  - record the plot svg's top;
  - tap the left third of the plot;
  - `[data-chart-readout][data-pinned]` is visible and the svg's top is
    unchanged;
  - the layout-shift sum is 0, from a PerformanceObserver started before the
    tap.
- New: "first load and a tab switch shift nothing", at 390 and 1280:
  - collect layout-shift entries (`buffered: true`, `hadRecentInput` false)
    after load plus 3s;
  - then click Short interest, wait 3s, and add those entries;
  - the sum is < 0.02 each;
  - the `.login-slot` height is the same at `domcontentloaded` and after the
    banner mounts.
- Keep the redirect, canonical, Strategy-level and ISR-cache tests.

Do not weaken an assertion to make it pass. If an app bug makes a test fail,
leave the test, report the bug as a concern, and say which spec goal it misses.

---

### Task 7: Documentation, bundle baseline, visual baselines

- **`CLAUDE.md`, the "Stock page (one route per tab)" section:**
  - rewrite the layout composition: breadcrumbs, `StockHeader`, the sticky
    `StockTabNav`;
  - the charts on Overview and Short interest only, with settings via
    `prefsKey`;
  - the Strategy cache sentence;
  - the readout strip (default) versus tooltip (widgets);
  - the banner on Overview only;
  - the `KNOWN_CLIENT_CONNECT` sentence (the two retry twins are gone).

  Keep the section's style: short paragraphs and dated facts.
- **Supersession notes:**
  - `docs/superpowers/specs/2026-10-09-stock-page-tab-routes-design.md`: a
    "Superseded in part by 2026-10-10-stock-page-visible-first-design.md"
    note at the top, listing the layout chrome, the chart in the layout and
    the theme chips in the layout.
  - `docs/superpowers/plans/2026-10-09-stock-page-tab-routes.md`: a one-line
    "historical; superseded in part" note at the top.
- **Bundle:** after a local `next build`, run `node scripts/bundle-budget.mjs`.
  Every route must be within budget; lower a budget only when it is more than
  15 kB slack and say so. Refresh `docs/perf/bundle-baseline.json` with the
  repo's baseline command, as `docs/perf` or the script's usage documents.
- **Visual baselines:** copy `web/` to a temp dir without `node_modules` and
  `.next` (for example `rsync -a --exclude node_modules --exclude .next web/ "$TMP/web/"`),
  then run the README's Docker recipe (`web/tests/visual/README.md`) there with
  `npm run test:visual:update`. Never run it on the worktree's own `web/`: its
  `npm ci` would replace the Mac's `node_modules` with Linux binaries. Copy back
  only the changed PNGs under `web/tests/visual/__screenshots__/`, check the
  changed set is only chart stories (StockChart, StockChartPanel,
  StockPriceShortChart), then run the recipe once more without `:update` in the
  temp copy to confirm green.
