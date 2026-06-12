/**
 * Deterministic fixture data for Storybook stories and unit tests.
 *
 * RULES:
 * - NEVER use Date.now(), Math.random(), or new Date() without arguments.
 * - All randomness is produced by a seeded Mulberry32 PRNG.
 * - All timestamps derive from FIXTURE_BASE_DATE (2026-06-01T00:00:00Z).
 */

import { create } from "@bufbuild/protobuf";
import { timestampFromDate } from "@bufbuild/protobuf/wkt";
import {
  TimeSeriesDataSchema,
  TimeSeriesPointSchema,
  type TimeSeriesData,
  type TimeSeriesPoint,
} from "~/gen/stocks/v1alpha1/stocks_pb";
import {
  GetTopShortsResponseSchema,
  type GetTopShortsResponse,
} from "~/gen/shorts/v1alpha1/shorts_pb";
import type { StockQuote, HistoricalDataPoint } from "~/@/lib/stock-data-service";

// ---------------------------------------------------------------------------
// Extended type for widget fields not present in the TimeSeriesData proto
// ---------------------------------------------------------------------------
/**
 * TimeSeriesData augmented with the extra fields that top-shorts widgets
 * read at runtime (cast from the API response via Object.assign).
 */
export type TimeSeriesDataWithWidgetFields = TimeSeriesData & {
  /**
   * Current short interest as a percentage of total shares in issue.
   * Unit: percentage points — e.g. 19.4 renders as "19.40%".
   * Derived from latestShortPosition * 100 (latestShortPosition is a decimal
   * fraction from the proto, e.g. 0.194 → 19.4%).
   */
  percentageShorted: number;
  /**
   * Percentage-point change in short interest over the trailing period.
   * Unit: percentage points — e.g. -0.85 renders as "-0.85%".
   * Realistic range: roughly ±2.5 pp.
   */
  shortPercentageChange: number;
  /** GICS industry string, e.g. "Materials". */
  industry: string;
};

// ---------------------------------------------------------------------------
// Fixed base date — NEVER replace with Date.now()
// ---------------------------------------------------------------------------
export const FIXTURE_BASE_DATE = new Date("2026-06-01T00:00:00Z");

// ---------------------------------------------------------------------------
// Mulberry32 — deterministic PRNG seeded per stock
// ---------------------------------------------------------------------------
function mulberry32(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let z = s;
    z = Math.imul(z ^ (z >>> 15), z | 1);
    z ^= z + Math.imul(z ^ (z >>> 7), z | 61);
    return ((z ^ (z >>> 14)) >>> 0) / 4294967296;
  };
}

// Simple hash from string to uint32
function hashStr(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h;
}

// ---------------------------------------------------------------------------
// Fixture stock definitions (ordered by descending short position)
// ---------------------------------------------------------------------------
interface StockFixtureDef {
  code: string;
  name: string;
  industry: string;
  latestShortPosition: number; // as a decimal fraction, e.g. 0.194
  basePrice: number; // approximate stock price in AUD
}

const FIXTURE_STOCKS: StockFixtureDef[] = [
  { code: "PLS", name: "Pilbara Minerals Limited", industry: "Materials", latestShortPosition: 0.194, basePrice: 2.85 },
  { code: "SYR", name: "Syrah Resources Limited", industry: "Materials", latestShortPosition: 0.151, basePrice: 0.42 },
  { code: "IEL", name: "IDP Education Limited", industry: "Consumer Discretionary", latestShortPosition: 0.128, basePrice: 14.20 },
  { code: "LTR", name: "Liontown Resources Limited", industry: "Materials", latestShortPosition: 0.112, basePrice: 0.68 },
  { code: "FLT", name: "Flight Centre Travel Group", industry: "Consumer Discretionary", latestShortPosition: 0.097, basePrice: 18.50 },
  { code: "CTT", name: "Cettire Limited", industry: "Consumer Discretionary", latestShortPosition: 0.089, basePrice: 1.32 },
  { code: "BOE", name: "Boss Energy Limited", industry: "Energy", latestShortPosition: 0.082, basePrice: 2.97 },
  { code: "DMP", name: "Domino's Pizza Enterprises", industry: "Consumer Discretionary", latestShortPosition: 0.076, basePrice: 32.40 },
  { code: "MIN", name: "Mineral Resources Limited", industry: "Materials", latestShortPosition: 0.068, basePrice: 21.10 },
  { code: "SLX", name: "Silex Systems Limited", industry: "Industrials", latestShortPosition: 0.059, basePrice: 4.65 },
];

// Periods supported by historicalDataFixture
const PERIOD_DAYS: Record<string, number> = {
  "1m": 22,
  "3m": 65,
  "6m": 130,
  "1y": 252,
  "2y": 504,
  "max": 756,
};

// ---------------------------------------------------------------------------
// Helper: subtract N calendar days from a fixed base date
// ---------------------------------------------------------------------------
function daysBeforeBase(n: number): Date {
  return new Date(FIXTURE_BASE_DATE.getTime() - n * 86_400_000);
}

// ---------------------------------------------------------------------------
// Build 90 TimeSeriesPoints for one stock
// ---------------------------------------------------------------------------
function buildPoints(def: StockFixtureDef): TimeSeriesPoint[] {
  const rand = mulberry32(hashStr(def.code));
  const points: TimeSeriesPoint[] = [];
  let value = def.latestShortPosition * 0.85; // start slightly below latest

  for (let i = 89; i >= 0; i--) {
    // Random walk: ±0.3% per day
    value = Math.max(0.001, value + (rand() - 0.5) * 0.006);
    const date = daysBeforeBase(i);
    points.push(
      create(TimeSeriesPointSchema, {
        timestamp: timestampFromDate(date),
        shortPosition: parseFloat(value.toFixed(4)),
      }),
    );
  }

  // Force last point to match the declared latestShortPosition
  const last = points[points.length - 1]!;
  (last as { shortPosition: number }).shortPosition = def.latestShortPosition;

  return points;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Returns 10 TimeSeriesDataWithWidgetFields entries with deterministic
 * 90-point series, ordered by descending latestShortPosition.
 *
 * Field semantics (verified against top-shorts-widget.tsx:102 and columns.tsx:99):
 * - percentageShorted = latestShortPosition * 100  (e.g. 0.194 → 19.4, renders "19.4%")
 * - shortPercentageChange: percentage-point delta, seeded range ±2.5 pp (renders "±X.XX%")
 */
export function topShortsFixture(): TimeSeriesDataWithWidgetFields[] {
  return FIXTURE_STOCKS.map((def) => {
    const points = buildPoints(def);
    const series = create(TimeSeriesDataSchema, {
      productCode: def.code,
      name: def.name,
      latestShortPosition: def.latestShortPosition,
      points,
    });

    // Extra fields read by widgets (percentageShorted, shortPercentageChange, industry)
    // These are not in the proto but the widget casts to TimeSeriesData & { ... }
    return Object.assign(series, {
      // percentageShorted: percentage points (0.194 → 19.4), rendered as "19.4%"
      percentageShorted: parseFloat((def.latestShortPosition * 100).toFixed(2)),
      // shortPercentageChange: pp delta in ±2.5 range, rendered as "±X.XX%"
      shortPercentageChange: parseFloat(
        ((mulberry32(hashStr(def.code + "_chg"))() - 0.5) * 5).toFixed(2),
      ),
      industry: def.industry,
    }) as TimeSeriesDataWithWidgetFields;
  });
}

/**
 * Wraps topShortsFixture() in a GetTopShortsResponse protobuf message.
 */
export function topShortsResponseFixture(): GetTopShortsResponse {
  return create(GetTopShortsResponseSchema, {
    timeSeries: topShortsFixture(),
  });
}

/**
 * Returns a Map<code, StockQuote> for the given list of codes.
 * Unknown codes fall back to a PLS-seeded default.
 */
export function stockQuotesFixture(codes: string[]): Map<string, StockQuote> {
  const map = new Map<string, StockQuote>();
  for (const code of codes) {
    const def = FIXTURE_STOCKS.find((s) => s.code === code);
    const rand = mulberry32(hashStr(code + "_quote"));
    const basePrice = def?.basePrice ?? 5.0;
    const change = parseFloat(((rand() - 0.5) * 0.4).toFixed(3));
    map.set(code, {
      symbol: code,
      price: parseFloat((basePrice + change).toFixed(3)),
      change,
      changePercent: parseFloat(((change / basePrice) * 100).toFixed(3)),
      previousClose: basePrice,
      volume: Math.floor(rand() * 5_000_000) + 100_000,
      high: parseFloat((basePrice + Math.abs(change) + rand() * 0.1).toFixed(3)),
      low: parseFloat((basePrice - Math.abs(change) - rand() * 0.1).toFixed(3)),
      open: parseFloat((basePrice + (rand() - 0.5) * 0.2).toFixed(3)),
    });
  }
  return map;
}

/**
 * Returns deterministic HistoricalDataPoint[] for the given stock code and period.
 * Period values: "1m" (22pts), "3m" (65pts), "6m" (130pts), "1y" (252pts), "2y" (504pts), "max" (756pts).
 */
export function historicalDataFixture(
  code: string,
  period = "3m",
): HistoricalDataPoint[] {
  const days = PERIOD_DAYS[period] ?? PERIOD_DAYS["3m"]!;
  const def = FIXTURE_STOCKS.find((s) => s.code === code);
  const basePrice = def?.basePrice ?? 5.0;
  const rand = mulberry32(hashStr(code + "_hist"));

  const points: HistoricalDataPoint[] = [];
  let close = basePrice * 0.9;

  for (let i = days - 1; i >= 0; i--) {
    close = Math.max(0.01, close + (rand() - 0.5) * basePrice * 0.02);
    const open = parseFloat((close + (rand() - 0.5) * basePrice * 0.01).toFixed(3));
    const high = parseFloat((Math.max(open, close) + rand() * basePrice * 0.005).toFixed(3));
    const low = parseFloat((Math.min(open, close) - rand() * basePrice * 0.005).toFixed(3));
    const date = daysBeforeBase(i);
    const dateStr = date.toISOString().slice(0, 10);

    points.push({
      date: dateStr,
      open,
      high,
      low,
      close: parseFloat(close.toFixed(3)),
      volume: Math.floor(rand() * 3_000_000) + 50_000,
      adjustedClose: parseFloat(close.toFixed(3)),
    });
  }

  // Pin the final point's close/adjustedClose to basePrice so quote cards and
  // chart endpoints agree on the displayed price.
  const terminal = points[points.length - 1];
  if (terminal) {
    const pinned = parseFloat(basePrice.toFixed(3));
    terminal.close = pinned;
    terminal.adjustedClose = pinned;
  }

  return points;
}
