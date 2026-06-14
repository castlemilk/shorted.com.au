# Stock Charts: Shared Performant Core + Consolidated Per-Stock View

**Date:** 2026-06-14
**Status:** Approved
**Scope:** `web/` only — no backend changes. Builds a shared chart core, consolidates the per-stock view onto it, and migrates the dashboard chart widgets onto it (retiring the duplicated chart monoliths).

## Problem

Charts are duplicated and unoptimized:

- The **per-stock page** (`web/src/app/shorts/[stockCode]/page.tsx`) renders **three** separate charts — short-position trends (`ui/chart.tsx` → `ui/unified-brush-chart.tsx`), price history (`ui/market-chart.tsx` → `unified-brush-chart`), and a dual-axis price+short overlay (`ui/short-price-overlay-chart.tsx` via `company/short-price-overlay.tsx`) — built on the **older, simpler** wrappers.
- The **dashboard widgets** (`widgets/stock-chart-widget.tsx`, `widgets/time-series-widget.tsx`) use the **more capable but 1355-line** `ui/multi-series-chart.tsx` (dual-axis, indicators, oscillator panel). Its scale/brush/tooltip logic largely **duplicates** `unified-brush-chart`.
- **No decimation anywhere**: full-history ranges (5y/max ≈ 1,300–4,000 trading days) render every point; volume renders **one `<Bar>` SVG node per point** (~4,000 DOM nodes). Tooltips recompute scales + bisect on every mousemove. The core chart components have **no Storybook stories** (only the widgets do).

## Decisions (from brainstorming)

| Decision | Choice |
|---|---|
| Strategy | One **shared, optimized, storied SVG (@visx) chart core** used by per-stock page AND dashboard widgets; no new charting dependency |
| Per-stock layout | **Consolidate** the three charts into one primary dual-axis chart (price + short %, volume, brush, period selector) |
| Quality priorities | Interaction polish (crosshair/synced tooltip/smooth brush), mobile/touch, indicators on per-stock, distinctive visual identity |
| Performance priorities | Large-history decimation (LTTB), initial load/bundle, fewer re-renders |
| Widget migration | **In scope** — migrate `stock-chart-widget` + `time-series-widget` onto the core, retire `multi-series-chart` + `unified-brush-chart` |

## Architecture: a small composable chart system

New home: `web/src/@/components/charts/` (focused units replacing the 689- and 1355-line monoliths). Each file has one responsibility and is independently testable.

```
charts/
  chart-theme.ts          color/gradient/typography tokens; dark/light parity  → visual identity
  decimate.ts             LTTB downsampling (pure, unit-tested)
  use-chart-scales.ts     memoized time / multi value-axis / volume scales
  chart-primitives.tsx    Axes, Grid, Crosshair, VolumePath (single path),
                          SeriesArea, SeriesLine, BrushOverview
  chart-tooltip.tsx       pointer-driven synced tooltip (no per-move scale recompute)
  indicators.ts           memoized wrapper over the existing technical-indicators lib
                          (SMA/EMA/Bollinger overlays; RSI/MACD oscillators)
  StockChart.tsx          the composed core — the only chart component consumers mount
  StockChart.stories.tsx
  StockPriceShortChart.tsx        consolidated per-stock chart (built on StockChart)
  StockPriceShortChart.stories.tsx
```

### `StockChart` props (the superset both surfaces need)

```ts
interface ChartSeries {
  id: string;
  label: string;
  data: { t: number; v: number }[];   // epoch ms + value (already merged/normalized)
  axis: "left" | "right";             // dual-axis assignment
  kind: "line" | "area";
  color: string;                       // from chart-theme
}

interface StockChartProps {
  series: ChartSeries[];               // 1..N (per-stock = 1–2; widgets = N)
  volume?: { t: number; v: number }[]; // rendered as ONE path, desktop only
  indicators?: IndicatorConfig[];      // overlays (on a series' axis) + oscillators (own panel)
  height?: number;
  showBrush?: boolean;                 // brush/zoom overview band
  leftAxis?: AxisConfig; rightAxis?: AxisConfig;  // format, label, domain hints
  variant?: "full" | "compact";        // compact hides axis labels/volume/brush
}
```

`StockChart` composes the primitives, owns the decimated render data + scales (memoized), the crosshair/tooltip, the brush, and an optional oscillator sub-panel. It does **not** fetch data or own period state — consumers pass ready series. This keeps it pure, storyable, and reusable.

## Data flow (no backend changes)

- Reuse `useShortTimeSeries(code, period)` and `useHistoricalData(code, period)` (TanStack Query) — the per-stock chart uses `useStockChartData` (combined) or both directly.
- Merge short + price series by date; map protobuf `TimeSeriesPoint` / `HistoricalDataPoint` → `{ t, v }`.
- **Decimate after fetch**, memoized by `(code, period, pixelWidth)`: target ~2 points per horizontal pixel, only above a ~600-point threshold. The brush overview uses a harder-decimated copy.
- LTTB preserves visual shape; additionally **force-keep the global min/max points** (short-position spikes must survive) — the protobuf already carries precomputed `max`/`min`, used as a correctness check in tests.

## Per-stock view (Phase B)

`StockPriceShortChart.tsx` (dynamic-imported, `ssr:false`) owns period state + data fetching and renders one `StockChart`:
- Dual-axis: **price left** (AUD), **short % right**; both series color-coded to their axis.
- Volume (desktop), brush/zoom, period selector (1m…max), series toggles (price / short / volume), optional SMA + Bollinger toggles (off by default), a Pearson **correlation badge** (logic ported from `short-price-overlay.tsx`).
- Mobile/touch: touch-driven tooltip, volume hidden, responsive sizing, legible ticks.

`web/src/app/shorts/[stockCode]/page.tsx`: replace the three chart sections with one `<StockPriceShortChart stockCode={...} />`. After verifying no other importers, **retire** `ui/chart.tsx`, `ui/market-chart.tsx`, `ui/short-price-overlay-chart.tsx`, `company/short-price-overlay.tsx`, `hooks/use-market-data.ts` (if unused elsewhere).

## Widget migration (Phase C)

- `stock-chart-widget.tsx` and `time-series-widget.tsx` build their `series[]` (multi-stock, shorts/market, per-stock axis) + `indicators[]` from settings and render `StockChart` instead of `MultiSeriesChart`. Settings UI and indicator selection are unchanged; only the rendering layer swaps.
- After both migrate, **retire** `ui/multi-series-chart.tsx` and `ui/unified-brush-chart.tsx` (verify no remaining importers; the MDX `article-series-chart` is independent and stays).
- The existing widget Storybook stories must stay green through the swap (they assert behavior, not internal markup); update assertions only where DOM structure legitimately changes, and refresh visual baselines once.

**Out of scope:** MDX/editorial charts (`news/mdx/*`), candlestick/OHLC rendering, real-time streaming, any new charting dependency, backend/API/proto changes.

## Performance

- LTTB decimation (the headline win) + global-extrema preservation.
- Volume as a single `AreaClosed`/path (eliminates ~4,000 DOM nodes at max range).
- Memoized scales, merged series, decimated data, and indicator computations (keyed by code/period/width).
- Dynamic import of the chart system so the stock page shell paints first.
- Pointer-driven tooltip that bisects against the (smaller) decimated array, not raw data, and doesn't rebuild scales per move.

Validation: extend `web/scripts/perf-benchmark.mjs` to add `/shorts/<code>` as a target (a real code that renders), capture a pre-change baseline, and record before/after in `docs/perf/PHASE-charts.md`. Expected: large-range render time and stock-page LCP/JS both drop.

## Quality

- **Interaction**: crosshair + synced dual-axis tooltip, smooth brush/zoom, clean axis ticks/typography.
- **Mobile/touch**: touch tooltips, responsive sizing, volume off on mobile, no layout thrash.
- **Indicators**: SMA + Bollinger on the per-stock view (toggles, off by default); widgets keep their full indicator set via the same `indicators.ts`.
- **Visual identity**: `chart-theme.ts` token set (price/short/volume colors, gradient fills, grid, crosshair) with dark/light parity, applied everywhere — no generic defaults.

## Testing & harness (per the Phase-1 dashboard harness)

| Layer | What |
|---|---|
| Unit (Jest) | `decimate.ts` — LTTB point-count target, endpoint + global-extrema preservation, determinism |
| Stories (Vitest browser) | `StockChart` and `StockPriceShortChart`: default/loading/error/empty/compact/mobile + period, dual-vs-single, indicators-on, multi-series (widget shape) variants |
| Visual (Playwright, bookworm) | baselines for the above (deterministic seeded fixtures, extend `mocks/fixtures/short-data.ts`) |
| Interaction (play fns) | period switch, series toggle, indicator toggle, tooltip/crosshair, brush |
| Migrated widget stories | stay green; refresh baselines once after the swap |

## Phasing (each phase ends with stories+visual green and a perf record where relevant)

- **Phase A** — core: `chart-theme`, `decimate` (+ unit tests), `use-chart-scales`, `chart-primitives`, `chart-tooltip`, `indicators`, `StockChart` + stories + visual baselines.
- **Phase B** — `StockPriceShortChart` + wire `/shorts/[stockCode]` + retire per-stock-only old charts + stories + perf before/after.
- **Phase C** — migrate both widgets onto `StockChart` + retire `multi-series-chart`/`unified-brush-chart` + keep widget stories green + refresh baselines.

## Risks

- **Decimation hides short spikes** → LTTB is shape-preserving and we force-keep global min/max; unit-tested against the protobuf-provided extrema.
- **Dual-axis is misleading** → color-coded axes + correlation badge; series toggles let users isolate.
- **Retiring old charts breaks importers** → grep importers before deleting each file; the MDX charts are independent and stay.
- **Core must be a true superset for widgets** (oscillator panel, N series, per-series axis) → designed into `StockChart` props from the start; Phase C is gated on the widget stories staying green.
- **Visual-baseline flake on charts** → deterministic seeded fixtures, animations disabled in the visual config, bookworm-rendered baselines (as established in Phase 1).
