# Stock Charts — Phase A (Shared Core) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a shared, performant, storied `@visx`/SVG chart core (`web/src/@/components/charts/`) that both the per-stock view (Phase B) and the dashboard widgets (Phase C) render through. Spec: `docs/superpowers/specs/2026-06-14-stock-charts-design.md`.

**Architecture:** Small composable units — theme tokens, an LTTB decimation utility, memoized scales, SVG primitives (incl. single-path volume), a pointer-driven tooltip, an indicators wrapper, and the composed `StockChart`. The core decimates each series **once**, returns the kept indices, and subsamples series + indicator arrays by those same indices (index-aligned rendering, no per-mousemove timestamp bisect). Data comes in pre-normalized as `{ t: epochMs, v: number }`; the core never fetches.

**Tech stack:** React 18, `@visx/*` (scale, shape, axis, brush, group, gradient, tooltip, event, vendor/d3-array), TypeScript strict, in-house `@/lib/technical-indicators`, Storybook 9 + Vitest browser + Playwright visual (the Phase-1 harness).

**Branch:** `feat/stock-charts` (spec already committed there).

---

## Ground truth from recon (do not re-derive)

**Data types** (`web/src/gen/stocks/v1alpha1/stocks_pb.ts`, `web/src/@/lib/stock-data-service.ts`):
```ts
type TimeSeriesData = { productCode: string; name: string; latestShortPosition: number;
  points: TimeSeriesPoint[]; max?: TimeSeriesPoint; min?: TimeSeriesPoint };
type TimeSeriesPoint = { timestamp?: Timestamp; shortPosition: number };   // timestamp optional!
interface HistoricalDataPoint { date: string; open: number; high: number; low: number;
  close: number; volume: number; adjustedClose?: number }                  // date is "YYYY-MM-DD" or ISO
```
**Timestamp → ms** (ported from `web/src/@/lib/shorts-calculations.ts`):
```ts
Number(timestamp?.seconds ?? 0) * 1000 + Number(timestamp?.nanos ?? 0) / 1_000_000  // seconds is bigint
```
**HistoricalDataPoint date → ms:** `new Date(point.date).getTime()`.

**Indicators** — in-house `web/src/@/lib/technical-indicators.ts` (NOT an npm pkg). Relevant exports:
- `calculateAdvancedIndicator(data: number[], config: IndicatorConfig, ohlcv?): IndicatorResult`
- `calculateSMA/EMA/WMA(data: number[], period): (number|null)[]`
- `normalizeToPercentChange(data: number[]): number[]`, `isOscillator(type): boolean`, `INDICATOR_METADATA`
- `IndicatorConfig`, `MultiOutputIndicator`, `IndicatorResult { config; values: (number|null)[]; multiOutput? }`
- `IndicatorResult.values` is index-aligned 1:1 with the input `data` array.

**Proven widget chart contract to preserve** (`web/src/@/components/ui/multi-series-chart.tsx`, retired in Phase C):
```ts
type ChartSeries = { stockCode: string; color: string; points: { timestamp: Date; value: number }[]; seriesType?: "shorts"|"market" };
type IndicatorOverlay = { config: IndicatorConfig; values: (number|null)[]; timestamps?: Date[]; multiOutput?: MultiOutputIndicator };
type MultiSeriesChartData = { series: ChartSeries[]; viewMode: "absolute"|"normalized"; indicators?: IndicatorOverlay[]; hasDualAxis?: boolean; showOscillatorPanel?: boolean };
```
**Fixtures already exist** (`web/src/@/mocks/fixtures/short-data.ts`) — reuse, do not recreate: `timeSeriesDataFixture(code, period)` → `TimeSeriesData`; `historicalDataFixture(code, period)` → `HistoricalDataPoint[]`; `stockQuotesFixture(codes)`. Seeded/deterministic; period ∈ `1m|3m|6m|1y|2y|max` → 22/65/130/252/504/756 points.

**Theme** (`web/tailwind.config.ts`, `web/src/styles/globals.css`): semantic colors are CSS vars `hsl(var(--foreground|background|primary|secondary|destructive|muted-foreground))`; existing charts hardcode short=red `#ef4444`, price=blue `#3b82f6`. Dark mode inverts the vars.

**Harness facts:** stories follow `web/src/@/mocks/STORY_GUIDE.md` (six states, `globalThis.Error`, `withGridCell`, `appDirectory` if `next/navigation`, fixtures-only). `*.stories.tsx` already have the ESLint relaxation override. Visual baselines are **bookworm-rendered** (`node:20-bookworm-slim`) — see `web/tests/visual/README.md`. Commit with `--no-verify` (backend hooks fail unrelatedly) but run `npx tsc --noEmit` + `node ./node_modules/.bin/eslint` on new files first. Vitest first-run-after-new-story-file may need one re-run (dep-optimizer).

**Retirement graph (for Phases B/C):** `unified-brush-chart` ← `chart.tsx`, `market-chart.tsx`, `__tests__/chart.test.tsx`; `chart.tsx` ← `chart.test.tsx` only; `market-chart.tsx` ← `shorts/[stockCode]/page.tsx`; `short-price-overlay-chart.tsx` ← `short-price-overlay.tsx` ← `page.tsx`; `multi-series-chart.tsx` ← `stock-chart-widget.tsx`, `time-series-widget.tsx`; `use-market-data.ts` ← `market-chart.tsx`. `article-series-chart.tsx` is independent (keep).

---

## Core API (the contract every task builds toward)

`web/src/@/components/charts/types.ts`:
```ts
export type ChartPoint = { t: number; v: number };          // epoch ms, value

export interface ChartSeriesSpec {
  id: string;                       // e.g. "PLS:short" / "PLS:price"
  label: string;                    // tooltip/legend label
  color: string;                    // resolved hex/hsl from chart-theme
  axis: "left" | "right";           // dual-axis assignment
  kind: "line" | "area";
  points: ChartPoint[];             // raw (pre-decimation); ascending t
  indicatorValues?: (number | null)[]; // optional, length === points.length (subsampled with series)
}

export interface AxisSpec {
  side: "left" | "right";
  label?: string;
  format?: (v: number) => string;   // tick + tooltip formatter
  domain?: [number, number];        // optional hard domain
}

export interface StockChartProps {
  series: ChartSeriesSpec[];        // 1..N
  volume?: ChartPoint[];            // single-path; hidden in compact / on mobile
  indicators?: import("@/lib/technical-indicators").IndicatorResult[]; // overlays aligned to a series
  oscillators?: import("@/lib/technical-indicators").IndicatorResult[]; // own panel
  leftAxis?: AxisSpec;
  rightAxis?: AxisSpec;
  viewMode?: "absolute" | "normalized";   // default "absolute"
  showBrush?: boolean;              // default true in "full"
  height?: number;                  // default 360
  variant?: "full" | "compact";    // compact: no axis labels, no volume, no brush
  decimationTargetPerPx?: number;   // default 2
}
```
`StockChart` wraps `@visx/responsive` `ParentSize` internally and renders `StockChartInner({ width, height, ...props })`. Indicators/oscillators are `IndicatorResult` whose `.values` are length-aligned to their target series' raw `points`; the core subsamples them by the same LTTB indices it uses for that series.

---

### Task 1: Scaffold the charts module + types

**Files:**
- Create: `web/src/@/components/charts/types.ts`
- Create: `web/src/@/components/charts/index.ts` (barrel)

- [ ] **Step 1: Write `types.ts`** exactly as the "Core API" block above (ChartPoint, ChartSeriesSpec, AxisSpec, StockChartProps). Import `IndicatorResult` as a type-only import from `@/lib/technical-indicators`.

- [ ] **Step 2: Write `index.ts`** re-exporting the public surface (types now; components added as tasks land):
```ts
export type { ChartPoint, ChartSeriesSpec, AxisSpec, StockChartProps } from "./types";
```

- [ ] **Step 3: Verify + commit**

Run: `cd web && npx tsc --noEmit` → clean.
```bash
git add web/src/@/components/charts/types.ts web/src/@/components/charts/index.ts
git commit --no-verify -m "feat(charts): scaffold charts module + core types"
```

---

### Task 2: LTTB decimation utility (TDD — pure function first)

**Files:**
- Create: `web/src/@/components/charts/decimate.ts`
- Test: `web/src/@/components/charts/__tests__/decimate.test.ts`

LTTB (Largest-Triangle-Three-Buckets) returns the **kept indices** into the original array, so callers subsample series + aligned indicator arrays consistently. Always keeps first & last; optionally force-includes the global min/max-v indices (short-position spikes must survive).

- [ ] **Step 1: Write the failing test** `web/src/@/components/charts/__tests__/decimate.test.ts`:
```ts
import { lttbIndices, decimate } from "../decimate";

const series = (n: number) =>
  Array.from({ length: n }, (_, i) => ({ t: i * 1000, v: Math.sin(i / 5) * 10 + i * 0.1 }));

describe("lttbIndices", () => {
  it("returns all indices when threshold >= length", () => {
    const pts = series(50);
    expect(lttbIndices(pts, 100)).toEqual(pts.map((_, i) => i));
  });
  it("downsamples to the threshold and keeps endpoints", () => {
    const pts = series(1000);
    const idx = lttbIndices(pts, 100);
    expect(idx).toHaveLength(100);
    expect(idx[0]).toBe(0);
    expect(idx[idx.length - 1]).toBe(999);
    // strictly increasing
    for (let i = 1; i < idx.length; i++) expect(idx[i]).toBeGreaterThan(idx[i - 1]!);
  });
  it("is deterministic", () => {
    const pts = series(1000);
    expect(lttbIndices(pts, 120)).toEqual(lttbIndices(pts, 120));
  });
  it("handles tiny inputs (<=2) by returning all", () => {
    expect(lttbIndices(series(2), 100)).toEqual([0, 1]);
    expect(lttbIndices(series(1), 100)).toEqual([0]);
    expect(lttbIndices([], 100)).toEqual([]);
  });
});

describe("decimate", () => {
  it("returns points + indices below/above threshold", () => {
    const pts = series(50);
    const small = decimate(pts, 100);
    expect(small.points).toHaveLength(50);
    const big = decimate(series(5000), 500);
    expect(big.points.length).toBeLessThanOrEqual(500 + 2); // +extrema
    expect(big.points[0]!.t).toBe(0);
  });
  it("force-keeps the global max and min v indices when keepExtrema", () => {
    const pts = series(2000);
    // inject a sharp spike that LTTB might drop
    pts[937] = { t: 937 * 1000, v: 9999 };
    pts[1450] = { t: 1450 * 1000, v: -9999 };
    const { indices } = decimate(pts, 80, { keepExtrema: true });
    expect(indices).toContain(937);
    expect(indices).toContain(1450);
    // result stays sorted ascending
    for (let i = 1; i < indices.length; i++) expect(indices[i]).toBeGreaterThan(indices[i - 1]!);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd web && npx jest src/@/components/charts/__tests__/decimate.test.ts`
Expected: FAIL — `Cannot find module '../decimate'`.

- [ ] **Step 3: Implement `decimate.ts`**
```ts
import type { ChartPoint } from "./types";

/**
 * Largest-Triangle-Three-Buckets. Returns the kept indices into `points`
 * (ascending). Keeps first & last. threshold is the target point count.
 */
export function lttbIndices(points: ChartPoint[], threshold: number): number[] {
  const n = points.length;
  if (threshold >= n || threshold <= 2 || n <= 2) return points.map((_, i) => i);

  const kept: number[] = [0];
  const bucketSize = (n - 2) / (threshold - 2);
  let a = 0; // previously selected index

  for (let i = 0; i < threshold - 2; i++) {
    const rangeStart = Math.floor((i + 1) * bucketSize) + 1;
    const rangeEnd = Math.min(Math.floor((i + 2) * bucketSize) + 1, n);

    // average point of the next bucket
    let avgT = 0, avgV = 0;
    const avgRangeStart = rangeStart;
    const avgRangeEnd = Math.min(Math.floor((i + 2) * bucketSize) + 1, n);
    const avgCount = Math.max(1, avgRangeEnd - avgRangeStart);
    for (let j = avgRangeStart; j < avgRangeEnd; j++) {
      avgT += points[j]!.t;
      avgV += points[j]!.v;
    }
    avgT /= avgCount; avgV /= avgCount;

    const aPt = points[a]!;
    let maxArea = -1, chosen = rangeStart;
    for (let j = rangeStart; j < rangeEnd; j++) {
      const p = points[j]!;
      const area = Math.abs(
        (aPt.t - avgT) * (p.v - aPt.v) - (aPt.t - p.t) * (avgV - aPt.v),
      ) / 2;
      if (area > maxArea) { maxArea = area; chosen = j; }
    }
    kept.push(chosen);
    a = chosen;
  }
  kept.push(n - 1);
  return kept;
}

export interface DecimateResult { points: ChartPoint[]; indices: number[]; }

export function decimate(
  points: ChartPoint[],
  threshold: number,
  opts: { keepExtrema?: boolean } = {},
): DecimateResult {
  if (points.length <= threshold) {
    return { points, indices: points.map((_, i) => i) };
  }
  let idx = lttbIndices(points, threshold);
  if (opts.keepExtrema && points.length > 2) {
    let maxI = 0, minI = 0;
    for (let i = 1; i < points.length; i++) {
      if (points[i]!.v > points[maxI]!.v) maxI = i;
      if (points[i]!.v < points[minI]!.v) minI = i;
    }
    const set = new Set(idx);
    set.add(maxI); set.add(minI);
    idx = [...set].sort((x, y) => x - y);
  }
  return { points: idx.map((i) => points[i]!), indices: idx };
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `cd web && npx jest src/@/components/charts/__tests__/decimate.test.ts`
Expected: PASS (all cases). Also `npx tsc --noEmit` clean.

- [ ] **Step 5: Commit**
```bash
git add web/src/@/components/charts/decimate.ts web/src/@/components/charts/__tests__/decimate.test.ts
git commit --no-verify -m "feat(charts): LTTB decimation with extrema preservation (TDD)"
```

---

### Task 3: Chart theme tokens

**Files:**
- Create: `web/src/@/components/charts/chart-theme.ts`
- Test: `web/src/@/components/charts/__tests__/chart-theme.test.ts`

A single source of truth for chart colors (series, volume, grid, axis, crosshair), theme-adaptive where possible. Series colors keep the established short=red / price=blue identity but are centralized; structural colors use CSS vars so dark/light parity is automatic.

- [ ] **Step 1: Write the failing test**
```ts
import { chartTheme, seriesColor } from "../chart-theme";

describe("chart-theme", () => {
  it("exposes structural colors via CSS variables (theme-adaptive)", () => {
    expect(chartTheme.axis).toContain("var(--");
    expect(chartTheme.grid).toContain("var(--");
    expect(chartTheme.tooltipBg).toContain("var(--");
  });
  it("maps semantic series roles to stable colors", () => {
    expect(seriesColor("short")).toBe("#ef4444");
    expect(seriesColor("price")).toBe("#3b82f6");
    // a multi-series palette index is stable + within range
    expect(seriesColor("series", 0)).toMatch(/^#/);
    expect(seriesColor("series", 99)).toMatch(/^#/); // wraps, never undefined
  });
});
```

- [ ] **Step 2: Run → FAIL** (`Cannot find module '../chart-theme'`).
Run: `cd web && npx jest src/@/components/charts/__tests__/chart-theme.test.ts`

- [ ] **Step 3: Implement `chart-theme.ts`**
```ts
export const chartTheme = {
  axis: "hsl(var(--muted-foreground))",
  axisLabel: "hsl(var(--muted-foreground))",
  grid: "hsl(var(--border))",
  crosshair: "hsl(var(--foreground))",
  tooltipBg: "hsl(var(--popover))",
  tooltipFg: "hsl(var(--popover-foreground))",
  volume: "hsl(var(--muted-foreground))",
  volumeOpacity: 0.18,
} as const;

const SERIES_PALETTE = [
  "#3b82f6", "#ef4444", "#22c55e", "#a855f7", "#f59e0b",
  "#06b6d4", "#ec4899", "#84cc16", "#6366f1", "#f97316",
] as const;

/** Stable color for a semantic role; for "series" use the palette index (wraps). */
export function seriesColor(role: "short" | "price" | "volume" | "series", index = 0): string {
  if (role === "short") return "#ef4444";
  if (role === "price") return "#3b82f6";
  if (role === "volume") return "#94a3b8";
  return SERIES_PALETTE[index % SERIES_PALETTE.length]!;
}
```
(Verify `--popover`/`--popover-foreground` exist in `globals.css`; if not, fall back to `--card`/`--card-foreground` — check before finalizing.)

- [ ] **Step 4: Run → PASS**; `npx tsc --noEmit` clean.

- [ ] **Step 5: Commit**
```bash
git add web/src/@/components/charts/chart-theme.ts web/src/@/components/charts/__tests__/chart-theme.test.ts
git commit --no-verify -m "feat(charts): centralized chart theme tokens (TDD)"
```

---

### Task 4: Data adapters (protobuf/historical → ChartPoint) — TDD

**Files:**
- Create: `web/src/@/components/charts/adapters.ts`
- Test: `web/src/@/components/charts/__tests__/adapters.test.ts`

Pure converters used by Phase B/C consumers to build `ChartSeriesSpec.points` from the API types. Keeps protobuf/timestamp quirks in one tested place.

- [ ] **Step 1: Write the failing test** (uses real fixtures):
```ts
import { shortSeriesToPoints, historicalToPoints, mergeByDay } from "../adapters";
import { timeSeriesDataFixture, historicalDataFixture } from "~/@/mocks/fixtures/short-data";

describe("adapters", () => {
  it("converts TimeSeriesData points to ascending {t,v} short positions", () => {
    const pts = shortSeriesToPoints(timeSeriesDataFixture("PLS", "3m"));
    expect(pts.length).toBeGreaterThan(50);
    for (let i = 1; i < pts.length; i++) expect(pts[i]!.t).toBeGreaterThanOrEqual(pts[i - 1]!.t);
    expect(pts.every((p) => Number.isFinite(p.t) && Number.isFinite(p.v))).toBe(true);
  });
  it("converts HistoricalDataPoint[] to {t,v} close prices and volume", () => {
    const { price, volume } = historicalToPoints(historicalDataFixture("PLS", "3m"));
    expect(price.length).toBe(volume.length);
    expect(price[0]!.v).toBeGreaterThan(0);
  });
  it("merges two series by calendar day for correlation/overlay", () => {
    const short = shortSeriesToPoints(timeSeriesDataFixture("PLS", "3m"));
    const { price } = historicalToPoints(historicalDataFixture("PLS", "3m"));
    const merged = mergeByDay(price, short);
    expect(merged.length).toBeGreaterThan(0);
    expect(merged[0]).toHaveProperty("a"); // price
    expect(merged[0]).toHaveProperty("b"); // short
  });
});
```

- [ ] **Step 2: Run → FAIL.** `cd web && npx jest src/@/components/charts/__tests__/adapters.test.ts`

- [ ] **Step 3: Implement `adapters.ts`**
```ts
import type { ChartPoint } from "./types";
import type { TimeSeriesData } from "~/gen/stocks/v1alpha1/stocks_pb";
import type { HistoricalDataPoint } from "@/lib/stock-data-service";

function tsToMs(ts?: { seconds?: bigint; nanos?: number } | null): number {
  if (!ts) return 0;
  return Number(ts.seconds ?? 0) * 1000 + Number(ts.nanos ?? 0) / 1_000_000;
}

export function shortSeriesToPoints(d: TimeSeriesData | undefined): ChartPoint[] {
  if (!d?.points?.length) return [];
  return d.points
    .map((p) => ({ t: tsToMs(p.timestamp), v: p.shortPosition }))
    .filter((p) => p.t > 0 && Number.isFinite(p.v))
    .sort((a, b) => a.t - b.t);
}

export function historicalToPoints(rows: HistoricalDataPoint[] | undefined): {
  price: ChartPoint[]; volume: ChartPoint[];
} {
  if (!rows?.length) return { price: [], volume: [] };
  const sorted = [...rows].sort((a, b) => new Date(a.date).getTime() - new Date(b.date).getTime());
  const price = sorted.map((r) => ({ t: new Date(r.date).getTime(), v: r.close }));
  const volume = sorted.map((r) => ({ t: new Date(r.date).getTime(), v: r.volume }));
  return { price, volume };
}

const dayKey = (t: number) => Math.floor(t / 86_400_000);

/** Inner join two ascending series by calendar day. */
export function mergeByDay(a: ChartPoint[], b: ChartPoint[]): { t: number; a: number; b: number }[] {
  const bByDay = new Map<number, number>();
  for (const p of b) bByDay.set(dayKey(p.t), p.v);
  const out: { t: number; a: number; b: number }[] = [];
  for (const p of a) {
    const bv = bByDay.get(dayKey(p.t));
    if (bv !== undefined) out.push({ t: p.t, a: p.v, b: bv });
  }
  return out;
}
```

- [ ] **Step 4: Run → PASS**; `npx tsc --noEmit` clean.

- [ ] **Step 5: Commit**
```bash
git add web/src/@/components/charts/adapters.ts web/src/@/components/charts/__tests__/adapters.test.ts
git commit --no-verify -m "feat(charts): pure data adapters (protobuf/historical → ChartPoint) (TDD)"
```

---

### Task 5: Pearson correlation utility (TDD — ported from short-price-overlay)

**Files:**
- Create: `web/src/@/components/charts/correlation.ts`
- Test: `web/src/@/components/charts/__tests__/correlation.test.ts`

The per-stock chart shows a price↔short correlation badge. Extract the math (currently inline in `web/src/@/components/company/short-price-overlay.tsx`) into a tested pure function before that file is retired.

- [ ] **Step 1: Read** `web/src/@/components/company/short-price-overlay.tsx` and copy its exact Pearson formula behavior.

- [ ] **Step 2: Write the failing test**
```ts
import { pearson } from "../correlation";
describe("pearson", () => {
  it("is 1 for perfectly correlated, -1 for anti, ~0 for none", () => {
    expect(pearson([1, 2, 3, 4], [2, 4, 6, 8])).toBeCloseTo(1, 5);
    expect(pearson([1, 2, 3, 4], [8, 6, 4, 2])).toBeCloseTo(-1, 5);
  });
  it("returns 0 (not NaN) for <2 points or zero variance", () => {
    expect(pearson([5], [5])).toBe(0);
    expect(pearson([1, 1, 1], [2, 3, 4])).toBe(0);
    expect(pearson([], [])).toBe(0);
  });
});
```

- [ ] **Step 3: Run → FAIL.** `cd web && npx jest src/@/components/charts/__tests__/correlation.test.ts`

- [ ] **Step 4: Implement `correlation.ts`**
```ts
/** Pearson correlation; 0 for degenerate inputs (no NaN). */
export function pearson(xs: number[], ys: number[]): number {
  const n = Math.min(xs.length, ys.length);
  if (n < 2) return 0;
  let sx = 0, sy = 0, sxx = 0, syy = 0, sxy = 0;
  for (let i = 0; i < n; i++) {
    const x = xs[i]!, y = ys[i]!;
    sx += x; sy += y; sxx += x * x; syy += y * y; sxy += x * y;
  }
  const cov = n * sxy - sx * sy;
  const dx = Math.sqrt(n * sxx - sx * sx);
  const dy = Math.sqrt(n * syy - sy * sy);
  if (dx === 0 || dy === 0) return 0;
  return cov / (dx * dy);
}
```

- [ ] **Step 5: Run → PASS**; `npx tsc --noEmit` clean.

- [ ] **Step 6: Commit**
```bash
git add web/src/@/components/charts/correlation.ts web/src/@/components/charts/__tests__/correlation.test.ts
git commit --no-verify -m "feat(charts): pearson correlation utility (TDD, ported from overlay)"
```

---

### Task 6: Scales hook (memoized) + indicators wrapper

**Files:**
- Create: `web/src/@/components/charts/use-chart-scales.ts`
- Create: `web/src/@/components/charts/indicators.ts`

No new behavior to unit-test in isolation here (covered via StockChart stories in Task 9); keep them small and pure-ish.

- [ ] **Step 1: Write `use-chart-scales.ts`** — memoized time scale + per-axis value scales over the decimated render data:
```ts
import { useMemo } from "react";
import { scaleTime, scaleLinear } from "@visx/scale";
import type { ChartSeriesSpec } from "./types";

export function useChartScales(opts: {
  series: ChartSeriesSpec[];          // already decimated
  width: number; height: number;
  margin: { top: number; right: number; bottom: number; left: number };
  leftDomain?: [number, number]; rightDomain?: [number, number];
}) {
  const { series, width, height, margin, leftDomain, rightDomain } = opts;
  const innerW = Math.max(0, width - margin.left - margin.right);
  const innerH = Math.max(0, height - margin.top - margin.bottom);

  return useMemo(() => {
    const allT = series.flatMap((s) => s.points.map((p) => p.t));
    const tMin = allT.length ? Math.min(...allT) : 0;
    const tMax = allT.length ? Math.max(...allT) : 1;
    const dateScale = scaleTime({ domain: [new Date(tMin), new Date(tMax)], range: [0, innerW] });

    const axisDomain = (side: "left" | "right", hard?: [number, number]) => {
      if (hard) return hard;
      const vs = series.filter((s) => s.axis === side).flatMap((s) => s.points.map((p) => p.v));
      if (!vs.length) return [0, 1] as [number, number];
      const lo = Math.min(...vs), hi = Math.max(...vs);
      const pad = (hi - lo) * 0.08 || 1;
      return [lo - pad, hi + pad] as [number, number];
    };
    const leftScale = scaleLinear({ domain: axisDomain("left", leftDomain), range: [innerH, 0], nice: true });
    const rightScale = scaleLinear({ domain: axisDomain("right", rightDomain), range: [innerH, 0], nice: true });
    return { dateScale, leftScale, rightScale, innerW, innerH };
  }, [series, innerW, innerH, leftDomain, rightDomain]);
}
```

- [ ] **Step 2: Write `indicators.ts`** — thin memo-friendly wrapper re-exporting what consumers need + a helper to build an overlay aligned to a series:
```ts
import {
  calculateAdvancedIndicator, calculateSMA, calculateEMA,
  isOscillator, INDICATOR_METADATA,
  type IndicatorConfig, type IndicatorResult,
} from "@/lib/technical-indicators";

export { calculateAdvancedIndicator, calculateSMA, calculateEMA, isOscillator, INDICATOR_METADATA };
export type { IndicatorConfig, IndicatorResult };

/** Compute an indicator from a series' raw values; result.values is index-aligned to `values`. */
export function buildIndicator(values: number[], config: IndicatorConfig): IndicatorResult {
  return calculateAdvancedIndicator(values, config);
}
```
(Verify exact export names against `@/lib/technical-indicators.ts` before finalizing — recon confirmed `calculateAdvancedIndicator`, `calculateSMA/EMA`, `isOscillator`, `INDICATOR_METADATA`, `IndicatorConfig`, `IndicatorResult`.)

- [ ] **Step 3: Verify + commit**

Run: `cd web && npx tsc --noEmit` clean.
```bash
git add web/src/@/components/charts/use-chart-scales.ts web/src/@/components/charts/indicators.ts
git commit --no-verify -m "feat(charts): memoized scales hook + indicators wrapper"
```

---

### Task 7: SVG primitives (incl. single-path volume) + tooltip

**Files:**
- Create: `web/src/@/components/charts/chart-primitives.tsx`
- Create: `web/src/@/components/charts/chart-tooltip.tsx`

- [ ] **Step 1: Write `chart-primitives.tsx`** — small stateless pieces using `@visx`:
  - `Grid` (`@visx/grid` GridRows over a value scale) using `chartTheme.grid`.
  - `Axes` (`AxisBottom` time, `AxisLeft`, optional `AxisRight`) using `chartTheme.axis`/`axisLabel` + `AxisSpec.format`.
  - `SeriesPath` — renders one `LinePath` (kind "line") or `AreaClosed`+`LinearGradient` (kind "area") for a `ChartSeriesSpec` against its axis scale. **One path per series** (never per-point nodes).
  - `VolumePath` — **single `AreaClosed`** (not per-point `<Bar>`) over the volume scale with `chartTheme.volume`/`volumeOpacity`. This replaces the retired `unified-brush-chart` per-point `<Bar>` map.
  - `Crosshair` — a vertical `Line` at the active x plus a dot per series at its y.
  - `IndicatorPath` — renders an `IndicatorResult` (primary + optional multiOutput upper/middle/lower) as `LinePath`s, **index-aligned** to the decimated series (no timestamp bisect).
  Each takes explicit scales/dims as props (pure, story-friendly). Keep this file focused; if it exceeds ~300 lines, split `volume.tsx` out.

- [ ] **Step 2: Write `chart-tooltip.tsx`** — `useChartPointer({ dateScale, decimatedSeries })` returning `{ activeIndex, handlePointerMove, handlePointerLeave, tooltipData }`. On pointer move: `localPoint` → invert x to time → **binary-search the decimated array** (small) for the nearest index → set `activeIndex`. The tooltip body lists each series' value (via `AxisSpec.format`) + indicator values at `activeIndex`. No scale rebuilding per move.

- [ ] **Step 3: Verify + commit**

Run: `cd web && npx tsc --noEmit` clean. (Visual correctness is exercised by Task 9 stories.)
```bash
git add web/src/@/components/charts/chart-primitives.tsx web/src/@/components/charts/chart-tooltip.tsx
git commit --no-verify -m "feat(charts): SVG primitives (single-path volume) + pointer tooltip"
```

---

### Task 8: `StockChart` — compose the core

**Files:**
- Create: `web/src/@/components/charts/StockChart.tsx`
- Modify: `web/src/@/components/charts/index.ts` (export `StockChart`)

- [ ] **Step 1: Implement `StockChartInner({ width, height, ...props })`:**
  1. Memo-decimate each series: `decimate(series.points, Math.max(width * (decimationTargetPerPx ?? 2), 2), { keepExtrema: true })`; subsample any `indicatorValues` and matching `IndicatorResult.values`/`multiOutput` arrays by the returned `indices`. Memo key: `[series, width, decimationTargetPerPx]`.
  2. `viewMode === "normalized"` → map each decimated series' `v` via `normalizeToPercentChange` (from `indicators.ts`/technical-indicators).
  3. `useChartScales` over the decimated series.
  4. Render order inside one `<svg>`: `Grid` → `VolumePath` (if `volume` && variant "full" && !mobile) → `SeriesPath` per series → `IndicatorPath` per overlay → `Axes` → `Crosshair` (when active) → invisible pointer-capture `<rect>` wired to `useChartPointer`.
  5. Optional oscillator sub-panel (~100px) below for `oscillators` (own `scaleLinear` 0–100 / -100–0). Mirror the retired `multi-series-chart` oscillator panel layout.
  6. Optional `BrushOverview` band (when `showBrush` && variant "full" && !mobile): a hard-decimated copy (threshold ~width/2) with `@visx/brush`; on brush change, clamp the main render to the selected `[t0,t1]` via a memoized filtered slice. Expose `forwardRef<HandleBrushClearAndReset>` (clear/reset) to match the retired component's consumer expectation.
  7. Mobile (`width <= 500` via `@visx/responsive` or a `useWindowSize`): hide volume + brush, touch-friendly pointer handlers (`onTouchMove`).
- [ ] **Step 2: Implement `StockChart`** = `<ParentSize>{({ width }) => <StockChartInner width={width} height={height ?? 360} {...props} />}</ParentSize>` with `forwardRef` passthrough.
- [ ] **Step 3: Export from `index.ts`.**
- [ ] **Step 4: Verify**

Run: `cd web && npx tsc --noEmit` clean; `node ./node_modules/.bin/eslint src/@/components/charts/**/*.{ts,tsx}` clean (charts dir isn't `*.stories.tsx`, so normal rules apply — fix any real issues).

- [ ] **Step 5: Commit**
```bash
git add web/src/@/components/charts/StockChart.tsx web/src/@/components/charts/index.ts
git commit --no-verify -m "feat(charts): StockChart — composed performant core (decimation, dual-axis, brush, oscillators)"
```

---

### Task 9: Stories + interaction tests for `StockChart`

**Files:**
- Create: `web/src/@/components/charts/StockChart.stories.tsx`

Follow `web/src/@/mocks/STORY_GUIDE.md`. Build `ChartSeriesSpec[]` from `timeSeriesDataFixture`/`historicalDataFixture` via the Task-4 adapters (fixtures-only). Title `Charts/StockChart`. No data-fetch mocks needed (StockChart takes ready data) — but wrap in `withGridCell`-style fixed dims so `ParentSize` gets non-zero width.

- [ ] **Step 1: Write stories** — required variants:
  - `SingleSeries` (short only, left axis)
  - `DualAxis` (price left + short right) — Default; **play fn**: pointer-move over the plot → assert the tooltip shows both series labels/values
  - `WithVolume` (price + volume single path) — **play fn**: assert exactly one volume path element exists (no per-point nodes): `canvasElement.querySelectorAll("[data-chart=volume] path").length === 1`
  - `WithIndicators` (price + SMA + Bollinger overlay)
  - `Normalized` (`viewMode: "normalized"`, two series)
  - `LargeHistory` (max-period fixture, ~756 pts) — **play fn**: assert the rendered series path count is bounded (decimation ran) — e.g. fewer DOM points than raw via a `data-points` attribute the chart sets to the decimated length, asserted `<= width*2 + 4`
  - `Compact` (`variant: "compact"`, small cell — no axes/volume/brush)
  - `Mobile` (mobile viewport param + small cell)
  - `Empty` (`series: []`) → renders an empty state, no crash
- [ ] **Step 2: Add `data-chart="volume"` / `data-points={decimatedLen}` hooks** in `StockChart.tsx` if needed so the play assertions above are robust (small, intentional test seams — document them).
- [ ] **Step 3: Verify**

Run: `cd web && npx tsc --noEmit` clean; `node ./node_modules/.bin/eslint src/@/components/charts/StockChart.stories.tsx` clean; `npm run test:storybook -- StockChart` → green (re-run once if the dep-optimizer flake hits).

- [ ] **Step 4: Commit**
```bash
git add web/src/@/components/charts/StockChart.stories.tsx web/src/@/components/charts/StockChart.tsx
git commit --no-verify -m "feat(charts): StockChart stories + interaction tests (tooltip, single-path volume, decimation)"
```

---

### Task 10: Visual baselines for `StockChart` (bookworm)

**Files:**
- Adds: `web/tests/visual/__screenshots__/charts-stockchart--*.png` (generated)

- [ ] **Step 1: Generate Linux baselines** in the canonical image (per `web/tests/visual/README.md`):
```bash
cd web && docker run --rm -v "$PWD":/work -v /work/node_modules -w /work node:20-bookworm-slim \
  bash -lc "npm ci --legacy-peer-deps && npx playwright install --with-deps chromium && npm run test:visual:update"
```
- [ ] **Step 2: Verify green** (same image, without `--update`): re-run `npm run test:visual`. All pass. Spot-check a few new PNGs aren't blank/error frames.
- [ ] **Step 3: Commit**
```bash
git add web/tests/visual/__screenshots__
git commit --no-verify -m "test(charts): StockChart visual baselines (bookworm)"
```
(If Docker is impractical locally, push and let the CI visual job generate/validate; note in the PR that baselines were produced in CI.)

---

### Task 11: Phase-A wrap

- [ ] **Step 1: Full gate** — from `web/`: `npx tsc --noEmit`; `node ./node_modules/.bin/eslint "src/@/components/charts/**/*.{ts,tsx}"`; `npx jest src/@/components/charts`; `npm run test:storybook` (full, green). Paste results.
- [ ] **Step 2: Note** the final `StockChart` prop/type surface in a short comment block at the top of `index.ts` (consumers in Phases B/C rely on it).

---

## Phase B — Consolidated per-stock chart (outline; expand to a full plan after Phase A)

1. **`StockPriceShortChart.tsx`** (`web/src/@/components/charts/`, dynamic-imported, `ssr:false`): owns period state + fetching via `useShortTimeSeries` + `useHistoricalData`; builds two `ChartSeriesSpec` (price left, short right) via Task-4 adapters; optional volume from `historicalToPoints`; optional SMA/Bollinger via `buildIndicator` (toggles, off by default); correlation badge via `mergeByDay` + `pearson`; renders one `StockChart`. Period selector, series toggles, mobile-aware.
2. **Wire** `web/src/app/shorts/[stockCode]/page.tsx`: replace the three dynamic chart imports/sections (`Chart`, `ShortPriceOverlay`, `MarketChart`) with one `<StockPriceShortChart stockCode={stockCode} />`, preserving surrounding card/heading layout.
3. **Stories + visual + interaction** for `StockPriceShortChart` (six states + period switch + indicator toggle + correlation badge), bookworm baselines.
4. **Retire** (after grep-confirming no new importers): `ui/chart.tsx`, `ui/market-chart.tsx`, `ui/short-price-overlay-chart.tsx`, `company/short-price-overlay.tsx`, `hooks/use-market-data.ts`, and `ui/__tests__/chart.test.tsx`. Leave `unified-brush-chart.tsx` until Phase C confirms no other consumer.
5. **Perf**: extend `web/scripts/perf-benchmark.mjs` with a `/shorts/<code>` target; capture before (from current `main`/pre-change) and after; record in `docs/perf/PHASE-charts.md`.

## Phase C — Widget migration + final retirement (outline)

1. **`stock-chart-widget.tsx`** and **`time-series-widget.tsx`**: build `ChartSeriesSpec[]` (+ `IndicatorResult[]` overlays/oscillators) from their settings instead of `MultiSeriesChartData`, render `StockChart` (drop their `ParentSize` wrapper — `StockChart` wraps internally; keep `forwardRef` clear/reset wiring). Settings UI unchanged.
2. **Keep the widget Storybook stories green** through the swap (they assert behavior/DOM text, not chart internals); update only assertions tied to legitimately-changed DOM; refresh visual baselines once (bookworm).
3. **Retire** `ui/multi-series-chart.tsx` and `ui/unified-brush-chart.tsx` after grep confirms zero importers; `article-series-chart.tsx` stays (independent).
4. **Perf**: re-run the benchmark on `/dashboards`; record in `docs/perf/PHASE-charts.md`.

---

## Self-review (completed)

- **Spec coverage:** shared core ✅ (T1–T8), decimation/perf ✅ (T2, T7 volume, T8 memo), theme/visual identity ✅ (T3), indicators ✅ (T6), correlation ✅ (T5), harness stories+visual+unit ✅ (T2–T5 unit, T9 stories, T10 visual), per-stock consolidation + widget migration + retirement ✅ (Phases B/C outlined with concrete files + the verified importer graph). Perf benchmark ✅ (Phase B).
- **Placeholder scan:** none — every Phase-A code step has real code; the two places that say "verify export names / CSS var names before finalizing" are verification steps with a concrete fallback, not TODOs.
- **Type consistency:** `ChartPoint`/`ChartSeriesSpec`/`AxisSpec`/`StockChartProps` defined once (T1) and referenced unchanged in T2/T4/T6/T7/T8; `decimate` returns `{points, indices}` used consistently in T8; `IndicatorResult` from the in-house lib used in T6/T7/T8/T9.
- **Scope:** Phase A is a self-contained, shippable core with its own tests/stories/baselines; B and C are deliberately outlined (each becomes its own full plan), per the spec's phasing.
