/**
 * The chart indicators: one registry for every chart surface (the stock page,
 * the share page, the Discord Activity). Pure, with no React and no client directive:
 * server code reaches it through chart-views.ts, so it imports only types from
 * chart-views (a value import back would be a module cycle).
 */
import type { ChartPeriod, ChartViewId } from "./chart-views";
import { INDICATOR_COLORS } from "./chart-theme";
import {
  DAY_MS,
  bollinger,
  ema,
  macd,
  rsi,
  sma,
  timeWindowMean,
  wma,
  type Series,
} from "./chart-indicator-math";
import type { ChartPoint, OscillatorSpec, SeriesIndicator } from "./types";

export const CHART_INDICATOR_IDS = [
  "sma20",
  "sma50",
  "ema20",
  "wma20",
  "short-avg-30d",
  "sma200",
  "bb20",
  "rsi14",
  "macd",
  "short-avg-90d",
] as const;

export type ChartIndicatorId = (typeof CHART_INDICATOR_IDS)[number];
/** Base indicators are free to everyone; advanced ones need a session. */
export type IndicatorTier = "base" | "advanced";
/** The series an indicator is computed on. */
export type IndicatorTarget = "price" | "short";
/** A line, a band (upper and lower around a middle line) or a panel under the chart. */
export type IndicatorKind = "line" | "band" | "panel";
/** Whether the visitor may see the advanced indicators. */
export type IndicatorAccess = "signed-in" | "signed-out" | "checking";

export interface ChartIndicatorDef {
  id: ChartIndicatorId;
  /** The label in the menu. */
  label: string;
  /** The label on the in-plot legend and the panel caption. */
  legendLabel: string;
  /** The menu item's hint (a title; no em dashes, per DESIGN.md). */
  description: string;
  tier: IndicatorTier;
  target: IndicatorTarget;
  kind: IndicatorKind;
  /** History the indicator needs before its first value: sessions, or days for short interest. */
  lookback: number;
  color: string;
  dash?: string;
}

/** Registry order: the menu, the legend and the drawing all follow it. */
export const CHART_INDICATORS: readonly ChartIndicatorDef[] = [
  {
    id: "sma20",
    label: "SMA 20",
    legendLabel: "SMA 20",
    description: "Simple average of the last 20 closes",
    tier: "base",
    target: "price",
    kind: "line",
    lookback: 19,
    color: INDICATOR_COLORS.sma20,
  },
  {
    id: "sma50",
    label: "SMA 50",
    legendLabel: "SMA 50",
    description: "Simple average of the last 50 closes",
    tier: "base",
    target: "price",
    kind: "line",
    lookback: 49,
    color: INDICATOR_COLORS.sma50,
  },
  {
    id: "ema20",
    label: "EMA 20",
    legendLabel: "EMA 20",
    description: "Exponential average of 20 sessions, weighted to recent closes",
    tier: "base",
    target: "price",
    kind: "line",
    lookback: 40,
    color: INDICATOR_COLORS.ema20,
    dash: "6,3",
  },
  {
    id: "wma20",
    label: "WMA 20",
    legendLabel: "WMA 20",
    description: "Weighted average of 20 sessions, the latest counting most",
    tier: "base",
    target: "price",
    kind: "line",
    lookback: 19,
    color: INDICATOR_COLORS.wma20,
    dash: "2,3",
  },
  {
    id: "short-avg-30d",
    label: "Short 30-day avg",
    legendLabel: "Short 30d avg",
    description: "Average short interest over the past 30 days",
    tier: "base",
    target: "short",
    kind: "line",
    lookback: 30,
    color: INDICATOR_COLORS.shortAverage,
    dash: "5,3",
  },
  {
    id: "sma200",
    label: "SMA 200",
    legendLabel: "SMA 200",
    description: "Simple average of the last 200 closes",
    tier: "advanced",
    target: "price",
    kind: "line",
    lookback: 199,
    color: INDICATOR_COLORS.sma200,
  },
  {
    id: "bb20",
    label: "Bollinger Bands",
    legendLabel: "BB 20",
    description: "20-session average with bands two standard deviations either side",
    tier: "advanced",
    target: "price",
    kind: "band",
    lookback: 19,
    color: INDICATOR_COLORS.bollinger,
    // The swatch only: the chart dashes the two bands itself.
    dash: "4,3",
  },
  {
    id: "rsi14",
    label: "RSI 14",
    legendLabel: "RSI 14",
    description: "Relative strength over 14 sessions, in a panel under the chart",
    tier: "advanced",
    target: "price",
    kind: "panel",
    lookback: 42,
    color: INDICATOR_COLORS.rsi,
  },
  {
    id: "macd",
    label: "MACD",
    legendLabel: "MACD 12 26 9",
    description: "12 and 26-session EMAs and a 9-session signal, in a panel under the chart",
    tier: "advanced",
    target: "price",
    kind: "panel",
    lookback: 61,
    color: INDICATOR_COLORS.macd,
  },
  {
    id: "short-avg-90d",
    label: "Short 90-day avg",
    legendLabel: "Short 90d avg",
    description: "Average short interest over the past 90 days",
    tier: "advanced",
    target: "short",
    kind: "line",
    lookback: 90,
    color: INDICATOR_COLORS.shortAverage,
    dash: "2,3",
  },
];

const DEF_BY_ID = Object.fromEntries(
  CHART_INDICATORS.map((def) => [def.id, def]),
) as Record<ChartIndicatorId, ChartIndicatorDef>;

export function indicatorDef(id: ChartIndicatorId): ChartIndicatorDef {
  return DEF_BY_ID[id];
}

export function isChartIndicatorId(value: unknown): value is ChartIndicatorId {
  return (
    typeof value === "string" &&
    (CHART_INDICATOR_IDS as readonly string[]).includes(value)
  );
}

/** The shared empty selection: a stable identity, so memos built on it do not churn. */
export const NO_INDICATORS: readonly ChartIndicatorId[] = Object.freeze([]);

/** The series id a target's chart series carries, so an indicator can find it. */
export function chartSeriesId(stockCode: string, target: IndicatorTarget): string {
  return `${stockCode}:${target}`;
}

/** The menu items for a view: the price items unless the view is short interest alone, and the reverse. */
export function menuIndicators(view: ChartViewId): ChartIndicatorDef[] {
  return CHART_INDICATORS.filter((def) =>
    def.target === "price" ? view !== "short" : view !== "price",
  );
}

/**
 * The indicators to draw: the selection that the view offers and the visitor may
 * see. Base ones are for everyone; advanced ones need a session. In registry order.
 */
export function visibleIndicators(
  selected: readonly ChartIndicatorId[],
  options: { view: ChartViewId; access: IndicatorAccess },
): ChartIndicatorId[] {
  const offered = new Set(menuIndicators(options.view).map((def) => def.id));
  const unlocked = options.access === "signed-in";
  return CHART_INDICATORS.filter(
    (def) =>
      selected.includes(def.id) &&
      offered.has(def.id) &&
      (def.tier === "base" || unlocked),
  ).map((def) => def.id);
}

/**
 * The selection that is ready to draw. With `waiting` (the per-indicator readiness
 * useIndicatorHistory returns), only the indicators still waiting for their history
 * are held back. Without it, every indicator of a target whose history is pending
 * is held back, the coarser rule the first callers used.
 */
export function readyIndicators(
  ids: readonly ChartIndicatorId[],
  pending: { price: boolean; short: boolean },
  waiting?: readonly ChartIndicatorId[],
): ChartIndicatorId[] {
  if (waiting) return ids.filter((id) => !waiting.includes(id));
  return ids.filter((id) => !pending[indicatorDef(id).target]);
}

/**
 * Adds or removes one indicator. Only one panel can show at a time, so adding a
 * panel removes the other. The result is in registry order.
 */
export function toggleIndicator(
  selected: readonly ChartIndicatorId[],
  id: ChartIndicatorId,
): ChartIndicatorId[] {
  const next = new Set(selected);
  if (next.has(id)) {
    next.delete(id);
  } else {
    next.add(id);
    if (indicatorDef(id).kind === "panel") {
      for (const def of CHART_INDICATORS) {
        if (def.kind === "panel" && def.id !== id) next.delete(def.id);
      }
    }
  }
  return CHART_INDICATORS.filter((def) => next.has(def.id)).map((def) => def.id);
}

// Warm-up. An indicator computed over the visible period alone starts late (a
// 50-day average needs 50 sessions before its first value). When its lookback is
// more than a tenth of the window on screen, the first longer period that covers it
// is fetched once, through the same query keys the period buttons use, and its
// earlier points are prepended before the indicator is computed. Short interest is
// never warmed up from max, whose points are weekly buckets. Nothing is fetched when
// history already held for the stock, for a longer period, covers the lookback
// (heldCovers).

/** The periods in screen order. Test: equal to CHART_PERIODS (chart-views.ts). */
export const PERIOD_ORDER: readonly ChartPeriod[] = ["1m", "3m", "6m", "1y", "2y", "max"];

/** Trading sessions in each price period (calendar spans back from today). */
export const PRICE_SESSIONS: Record<ChartPeriod, number> = {
  "1m": 21,
  "3m": 63,
  "6m": 126,
  "1y": 252,
  "2y": 504,
  max: 2520,
};

/** Calendar days in each short interest period (max is weekly buckets, never a warm-up source). */
export const SHORT_DAYS: Record<Exclude<ChartPeriod, "max">, number> = {
  "1m": 30,
  "3m": 91,
  "6m": 182,
  "1y": 365,
  "2y": 730,
};

const WARMUP_SHARE = 0.1;
const SHORT_SLACK_DAYS = 7;

type ShortPeriod = Exclude<ChartPeriod, "max">;

export interface WarmupPlan {
  /** The period to fetch price history from, or null when none is needed. */
  price: ChartPeriod | null;
  /** The period to fetch short interest history from, or null when none is needed. */
  short: ChartPeriod | null;
}

export function planWarmup(
  period: ChartPeriod,
  ids: readonly ChartIndicatorId[],
): WarmupPlan {
  let priceLookback = 0;
  let shortLookback = 0;
  for (const id of ids) {
    const def = indicatorDef(id);
    if (def.target === "price") priceLookback = Math.max(priceLookback, def.lookback);
    else shortLookback = Math.max(shortLookback, def.lookback);
  }
  // max has no longer period to fetch from, so nothing is warmed up for it.
  if (period === "max") return { price: null, short: null };

  const later = PERIOD_ORDER.slice(PERIOD_ORDER.indexOf(period) + 1);
  const sessions = PRICE_SESSIONS[period];
  const days = SHORT_DAYS[period];
  let price: ChartPeriod | null = null;
  let short: ChartPeriod | null = null;
  if (priceLookback > 0 && priceLookback / sessions > WARMUP_SHARE) {
    price =
      later.find((p) => PRICE_SESSIONS[p] - sessions >= priceLookback) ?? "max";
  }
  if (shortLookback > 0 && shortLookback / days > WARMUP_SHARE) {
    // Never max: that is weekly buckets, and a daily average cannot be read from them.
    short =
      later.find(
        (p): p is ShortPeriod =>
          p !== "max" && SHORT_DAYS[p] - days >= shortLookback + SHORT_SLACK_DAYS,
      ) ?? null;
  }
  return { price, short };
}

/**
 * Whether history already held for the period `held` reaches back far enough, before
 * the visible `period` starts, for the indicator's first value. It is planWarmup's own
 * arithmetic, so the warm-up is asked for only what the held history does not cover.
 * It needs no data: the plan does not wait for the visible series to arrive.
 */
export function heldCovers(
  def: ChartIndicatorDef,
  held: ChartPeriod | undefined,
  period: ChartPeriod,
): boolean {
  if (held === undefined) return false;
  if (def.target === "price") {
    return PRICE_SESSIONS[held] - PRICE_SESSIONS[period] >= def.lookback;
  }
  if (held === "max" || period === "max") return false;
  return SHORT_DAYS[held] - SHORT_DAYS[period] >= def.lookback + SHORT_SLACK_DAYS;
}

/**
 * The visible points with the earlier history in front of them. The visible
 * series wins from its first point on, so the two never overlap. `offset` is how
 * many history points came first, to cut them off the computed values again.
 */
export function withHistory(
  visible: readonly ChartPoint[],
  history: readonly ChartPoint[] | undefined,
): { points: ChartPoint[]; offset: number } {
  const first = visible[0];
  if (!first || !history?.length) return { points: [...visible], offset: 0 };
  const prior = history.filter((p) => p.t < first.t);
  return { points: [...prior, ...visible], offset: prior.length };
}

export interface IndicatorLayerInput {
  stockCode: string;
  /** The view as built: a Combined view that fell back to one series is that series' view. */
  view: ChartViewId;
  price: readonly ChartPoint[];
  short: readonly ChartPoint[];
  /** The indicators to draw. */
  ids: readonly ChartIndicatorId[];
  /**
   * Selected indicators still waiting for their history. A panel among them is
   * drawn empty, so the plot keeps its height while the history loads. A line or
   * a band waits unseen: drawn from the visible data alone, it would start late
   * and then jump left when the history lands.
   */
  pending?: readonly ChartIndicatorId[];
  history?: { price?: readonly ChartPoint[]; short?: readonly ChartPoint[] };
}

export interface IndicatorLayers {
  indicators: SeriesIndicator[];
  oscillators: OscillatorSpec[];
}

/**
 * The indicators as StockChart draws them, for one view. Each array has the
 * target series' visible length, index for index, so the chart's decimation
 * subsamples it the same way. Computed over the warm-up history, then cut back.
 */
export function buildIndicatorLayers(input: IndicatorLayerInput): IndicatorLayers {
  const indicators: SeriesIndicator[] = [];
  const oscillators: OscillatorSpec[] = [];
  const waiting = input.pending ?? [];

  for (const def of CHART_INDICATORS) {
    if (def.kind === "panel" || !input.ids.includes(def.id)) continue;
    if (!offeredOn(def, input)) continue;
    const layer = lineOrBand(def, input);
    if (layer) indicators.push(layer);
  }

  // One panel at a time. A selected one is drawn from its values, or not at all;
  // a waiting one is drawn empty, so the plot keeps its height while it loads.
  const panels = CHART_INDICATORS.filter(
    (def) => def.kind === "panel" && offeredOn(def, input),
  );
  const selected = panels.find((def) => input.ids.includes(def.id));
  if (selected) {
    const panel = panelOn(selected, input);
    if (panel) oscillators.push(panel);
  } else {
    const holding = panels.find((def) => waiting.includes(def.id));
    if (holding) oscillators.push(emptyPanel(holding, input));
  }
  return { indicators, oscillators };
}

/** Whether an indicator is drawn on this view, with data to draw from. */
function offeredOn(def: ChartIndicatorDef, input: IndicatorLayerInput): boolean {
  if (input.view === "short" && def.target === "price") return false;
  if (input.view === "price" && def.target === "short") return false;
  return (def.target === "price" ? input.price : input.short).length > 0;
}

/**
 * What an indicator computes from: the visible series with the warm-up history in
 * front of it, and `trim`, which cuts the computed values back to the visible
 * series' length, index for index.
 */
function computeOn(def: ChartIndicatorDef, input: IndicatorLayerInput) {
  const visible = def.target === "price" ? input.price : input.short;
  const history = def.target === "price" ? input.history?.price : input.history?.short;
  const { points, offset } = withHistory(visible, history);
  return {
    points,
    closes: points.map((p) => p.v),
    trim: (values: Series): Series => values.slice(offset),
  };
}

/** A price is never below zero: a band edge that crosses zero is drawn on it. */
function floorAtZero(values: Series): Series {
  return values.map((v) => (v === null ? null : Math.max(0, v)));
}

function lineOrBand(def: ChartIndicatorDef, input: IndicatorLayerInput): SeriesIndicator | null {
  const { points, closes, trim } = computeOn(def, input);
  const base = {
    id: def.id,
    seriesId: chartSeriesId(input.stockCode, def.target),
    label: def.legendLabel,
    color: def.color,
  };
  const line = (values: Series): SeriesIndicator | null =>
    values.some((v) => v !== null)
      ? { ...base, ...(def.dash ? { dash: def.dash } : {}), values }
      : null;
  switch (def.id) {
    case "sma20":
      return line(trim(sma(closes, 20)));
    case "sma50":
      return line(trim(sma(closes, 50)));
    case "sma200":
      return line(trim(sma(closes, 200)));
    case "ema20":
      return line(trim(ema(closes, 20)));
    case "wma20":
      return line(trim(wma(closes, 20)));
    case "short-avg-30d":
      return line(trim(timeWindowMean(points, 30 * DAY_MS)));
    case "short-avg-90d":
      return line(trim(timeWindowMean(points, 90 * DAY_MS)));
    case "bb20": {
      const bands = bollinger(closes, 20, 2);
      const upper = floorAtZero(trim(bands.upper));
      if (!upper.some((v) => v !== null)) return null;
      // The middle line is the values; StockChart dashes the two edges itself.
      return {
        ...base,
        values: floorAtZero(trim(bands.middle)),
        upper,
        lower: floorAtZero(trim(bands.lower)),
      };
    }
    case "rsi14":
    case "macd":
      return null; // a panel: see panelOn
    default: {
      const unreachable: never = def.id;
      void unreachable;
      return null;
    }
  }
}

function panelOn(def: ChartIndicatorDef, input: IndicatorLayerInput): OscillatorSpec | null {
  const { closes, trim } = computeOn(def, input);
  switch (def.id) {
    case "rsi14": {
      const values = trim(rsi(closes, 14));
      return values.some((v) => v !== null) ? rsiPanel(def, values) : null;
    }
    case "macd": {
      const lines = macd(closes, 12, 26, 9);
      const line = trim(lines.macd);
      return line.some((v) => v !== null) ? macdPanel(def, line, trim(lines.signal)) : null;
    }
    default:
      return null;
  }
}

/** A panel with no values yet: its place in the plot, drawn empty while its history loads. */
function emptyPanel(def: ChartIndicatorDef, input: IndicatorLayerInput): OscillatorSpec {
  const count = (def.target === "price" ? input.price : input.short).length;
  const none: Series = new Array<number | null>(count).fill(null);
  return def.id === "macd" ? macdPanel(def, none, none) : rsiPanel(def, none);
}

function rsiPanel(def: ChartIndicatorDef, values: Series): OscillatorSpec {
  return {
    id: def.id,
    label: def.label,
    caption: def.legendLabel,
    color: def.color,
    values,
    reference: [30, 70],
    domain: [0, 100],
  };
}

/** MACD's panel: the line and its signal, centred on zero with room over the largest value. */
function macdPanel(def: ChartIndicatorDef, line: Series, signal: Series): OscillatorSpec {
  let peak = 0;
  for (const v of [...line, ...signal]) {
    if (v !== null) peak = Math.max(peak, Math.abs(v));
  }
  const range = peak > 0 ? peak * 1.1 : 1;
  return {
    id: def.id,
    label: def.label,
    caption: def.legendLabel,
    color: def.color,
    values: line,
    extraLines: [{ values: signal, color: INDICATOR_COLORS.macdSignal, dash: "4,3" }],
    reference: [0],
    domain: [-range, range],
  };
}

/**
 * Whether the history loaded so far reaches back far enough, before the visible
 * series starts at `firstVisible`, for the indicator's first value to be there: its
 * lookback in sessions for price, and for short interest its lookback in days plus
 * the slack planWarmup allows.
 */
export function coversLookback(
  def: ChartIndicatorDef,
  points: readonly ChartPoint[] | undefined,
  firstVisible: number,
): boolean {
  if (!points?.length) return false;
  if (def.target === "price") {
    let prior = 0;
    for (const p of points) if (p.t < firstVisible) prior++;
    return prior >= def.lookback;
  }
  return points[0]!.t <= firstVisible - (def.lookback + SHORT_SLACK_DAYS) * DAY_MS;
}

/** The indicators that have something to draw: a line or a band, or a panel with a value. */
export function drawnIndicatorIds(layers: IndicatorLayers): Set<ChartIndicatorId> {
  const drawn = new Set<ChartIndicatorId>();
  for (const ind of layers.indicators) {
    if (isChartIndicatorId(ind.id)) drawn.add(ind.id);
  }
  for (const osc of layers.oscillators) {
    if (isChartIndicatorId(osc.id) && osc.values.some((v) => v !== null)) drawn.add(osc.id);
  }
  return drawn;
}

/**
 * The selected indicators with nothing to draw that are not waiting for history:
 * a series is there, but too short for them (a young listing). Not counted, so the
 * menu can say so, rather than show as on with no line.
 */
export function indicatorsWithoutValues(
  ids: readonly ChartIndicatorId[],
  state: {
    drawn: ReadonlySet<ChartIndicatorId>;
    waiting: readonly ChartIndicatorId[];
    hasData: Record<IndicatorTarget, boolean>;
  },
): ChartIndicatorId[] {
  return ids.filter(
    (id) =>
      !state.drawn.has(id) &&
      !state.waiting.includes(id) &&
      state.hasData[indicatorDef(id).target],
  );
}
