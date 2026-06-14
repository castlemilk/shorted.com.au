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
  IndustryTreeMapSchema,
  StockSchema,
  TimeSeriesDataSchema,
  TimeSeriesPointSchema,
  TreemapShortPositionSchema,
  type IndustryTreeMap,
  type Stock,
  type TimeSeriesData,
  type TimeSeriesPoint,
} from "~/gen/stocks/v1alpha1/stocks_pb";
import {
  GetTopShortsResponseSchema,
  SearchStocksResponseSchema,
  GetMarketNewsResponseSchema,
  NewsArticleSchema,
  ScreenStocksResponseSchema,
  ScreenerStockSchema,
  type GetTopShortsResponse,
  type SearchStocksResponse,
  type GetMarketNewsResponse,
  type ScreenStocksResponse,
} from "~/gen/shorts/v1alpha1/shorts_pb";
import type {
  StockQuote,
  HistoricalDataPoint,
  CorrelationMatrix,
  SectorPerformance,
} from "~/@/lib/stock-data-service";
import type {
  SerializedTimeSeriesPoint,
  TooltipData,
} from "~/app/actions/tooltip/getTooltipData";

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
   * Equals latestShortPosition: the backend serves percentage points in the
   * proto too (getTopshorts.go maps mv_top_shorts.current_percent, e.g. 19.4,
   * straight into LatestShortPosition; columns.tsx renders it with
   * `.toFixed(2) + "%"`).
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
  // Percentage points, matching the backend proto (e.g. 19.4 → "19.40%").
  // getTopshorts.go maps mv_top_shorts.current_percent (already a percentage)
  // straight into LatestShortPosition, and point ShortPosition values come
  // from PERCENT_OF_TOTAL_PRODUCT_IN_ISSUE_REPORTED_AS_SHORT_POSITIONS.
  latestShortPosition: number;
  basePrice: number; // approximate stock price in AUD
}

const FIXTURE_STOCKS: StockFixtureDef[] = [
  { code: "PLS", name: "Pilbara Minerals Limited", industry: "Materials", latestShortPosition: 19.4, basePrice: 2.85 },
  { code: "SYR", name: "Syrah Resources Limited", industry: "Materials", latestShortPosition: 15.1, basePrice: 0.42 },
  { code: "IEL", name: "IDP Education Limited", industry: "Consumer Discretionary", latestShortPosition: 12.8, basePrice: 14.20 },
  { code: "LTR", name: "Liontown Resources Limited", industry: "Materials", latestShortPosition: 11.2, basePrice: 0.68 },
  { code: "FLT", name: "Flight Centre Travel Group", industry: "Consumer Discretionary", latestShortPosition: 9.7, basePrice: 18.50 },
  { code: "CTT", name: "Cettire Limited", industry: "Consumer Discretionary", latestShortPosition: 8.9, basePrice: 1.32 },
  { code: "BOE", name: "Boss Energy Limited", industry: "Energy", latestShortPosition: 8.2, basePrice: 2.97 },
  { code: "DMP", name: "Domino's Pizza Enterprises", industry: "Consumer Discretionary", latestShortPosition: 7.6, basePrice: 32.40 },
  { code: "MIN", name: "Mineral Resources Limited", industry: "Materials", latestShortPosition: 6.8, basePrice: 21.10 },
  { code: "SLX", name: "Silex Systems Limited", industry: "Industrials", latestShortPosition: 5.9, basePrice: 4.65 },
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
    // Random walk: ±0.3 percentage points per day
    value = Math.max(0.1, value + (rand() - 0.5) * 0.6);
    const date = daysBeforeBase(i);
    points.push(
      create(TimeSeriesPointSchema, {
        timestamp: timestampFromDate(date),
        shortPosition: parseFloat(value.toFixed(2)),
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
 * Field semantics (verified against top-shorts-widget.tsx:102, columns.tsx:99
 * and the backend getTopshorts.go, which serves percentage points):
 * - latestShortPosition / point shortPosition: percentage points (19.4 → "19.40%")
 * - min/max: lowest/highest point in the series (columns.tsx renders them as badges)
 * - percentageShorted = latestShortPosition (renders "19.4%")
 * - shortPercentageChange: percentage-point delta, seeded range ±2.5 pp (renders "±X.XX%")
 */
export function topShortsFixture(): TimeSeriesDataWithWidgetFields[] {
  return FIXTURE_STOCKS.map((def) => {
    const points = buildPoints(def);
    // The backend always sets min/max (getTopshorts.go); columns.tsx renders
    // them as the red/green range badges in the "Short" column.
    // Guard against empty points arrays: reduce without initial value throws on [].
    const minPoint = points.length
      ? points.reduce((a, b) => (b.shortPosition < a.shortPosition ? b : a))
      : undefined;
    const maxPoint = points.length
      ? points.reduce((a, b) => (b.shortPosition > a.shortPosition ? b : a))
      : undefined;
    const series = create(TimeSeriesDataSchema, {
      productCode: def.code,
      name: def.name,
      latestShortPosition: def.latestShortPosition,
      points,
      ...(minPoint !== undefined && { min: minPoint }),
      ...(maxPoint !== undefined && { max: maxPoint }),
    });

    // Extra fields read by widgets (percentageShorted, shortPercentageChange, industry)
    // These are not in the proto but the widget casts to TimeSeriesData & { ... }
    return Object.assign(series, {
      // percentageShorted: percentage points (19.4), rendered as "19.4%"
      percentageShorted: def.latestShortPosition,
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
 * Returns an IndustryTreeMap protobuf message built from FIXTURE_STOCKS.
 *
 * Shape matches what getIndustryTreeMap returns (verified against
 * industry-treemap-widget.tsx): `industries` is the distinct industry list
 * (drives the depth-1 sector groups when showSectorGrouping is on) and each
 * stock's `shortPosition` is in percentage points (sizes the treemap cells
 * via stratify().sum and feeds the green→red colorScale).
 *
 * Covers 4 industries — Materials ×4, Consumer Discretionary ×4, Energy ×1,
 * Industrials ×1 — so sector grouping renders multi-child and single-child
 * groups. Fully deterministic: values come straight from FIXTURE_STOCKS.
 */
export function industryTreemapFixture(): IndustryTreeMap {
  const industries = [...new Set(FIXTURE_STOCKS.map((s) => s.industry))];
  return create(IndustryTreeMapSchema, {
    industries,
    stocks: FIXTURE_STOCKS.map((def) =>
      create(TreemapShortPositionSchema, {
        industry: def.industry,
        productCode: def.code,
        shortPosition: def.latestShortPosition,
      }),
    ),
  });
}

/**
 * Returns TooltipData (the serialized JSON shape served by the getTooltipData
 * server action) for the given stock code. Used by TreemapTooltip, which the
 * treemap widgets render in a portal on cell hover.
 *
 * Unknown codes fall back to the PLS definition. 22 daily points (~1 month,
 * matching the real action's getStockData(code, "1m") call), seeded PRNG,
 * timestamps derived from FIXTURE_BASE_DATE.
 */
export function tooltipDataFixture(code: string): TooltipData {
  const def = FIXTURE_STOCKS.find((s) => s.code === code) ?? FIXTURE_STOCKS[0]!;
  const rand = mulberry32(hashStr(def.code + "_tooltip"));

  const points: SerializedTimeSeriesPoint[] = [];
  let value = def.latestShortPosition * 0.95;
  for (let i = 21; i >= 1; i--) {
    value = Math.max(0.1, value + (rand() - 0.5) * 0.4);
    points.push({
      timestamp: daysBeforeBase(i).toISOString(),
      shortPosition: parseFloat(value.toFixed(2)),
    });
  }
  // Terminal point pinned to the declared latest short position.
  points.push({
    timestamp: FIXTURE_BASE_DATE.toISOString(),
    shortPosition: def.latestShortPosition,
  });

  return {
    stockDetails: {
      productCode: def.code,
      companyName: def.name,
      industry: def.industry,
      address: "",
      summary: `${def.name} is a fixture company used in Storybook stories.`,
      details: "",
      website: "",
      gcsUrl: "",
      tags: [],
      enhancedSummary: "",
      companyHistory: "",
      keyPeople: [],
      financialReports: [],
      competitiveAdvantages: "",
      riskFactors: [],
      recentDevelopments: "",
      enrichmentStatus: "ENRICHED",
      enrichmentError: "",
      logoGcsUrl: "",
      logoIconGcsUrl: "",
      logoSvgGcsUrl: "",
      logoSourceUrl: "",
      logoFormat: "",
    },
    timeSeriesData: {
      productCode: def.code,
      name: def.name,
      latestShortPosition: def.latestShortPosition,
      points,
    },
  };
}

/**
 * Returns a Stock protobuf message for the given code — the shape served by
 * the getStock server action (stocks.v1alpha1.Stock), consumed by the
 * watchlist widgets' short-position badges via useMultipleStockShortPositions.
 *
 * percentageShorted is in percentage points (19.4 → "19.40%"), matching
 * FIXTURE_STOCKS. totalProductInIssue is seeded per code;
 * reportedShortPositions is derived so the three fields stay consistent
 * (reported = total × pct / 100). Unknown codes keep the requested code but
 * fall back to generic values (5.0% shorted), mirroring stockQuotesFixture.
 */
export function stockFixture(code: string): Stock {
  const def = FIXTURE_STOCKS.find((s) => s.code === code);
  const rand = mulberry32(hashStr(code + "_stock"));
  const percentageShorted = def?.latestShortPosition ?? 5.0;
  const totalProductInIssue = Math.floor(rand() * 2_000_000_000) + 200_000_000;
  return create(StockSchema, {
    productCode: code,
    name: def?.name ?? `${code} Holdings Limited`,
    industry: def?.industry ?? "Materials",
    percentageShorted,
    totalProductInIssue,
    reportedShortPositions: Math.floor(
      (totalProductInIssue * percentageShorted) / 100,
    ),
  });
}

/**
 * Returns a SearchStocksResponse protobuf message for the given query — the
 * shape served by the searchStocks/searchStocksClient server action. Matches
 * FIXTURE_STOCKS by case-insensitive substring on code or company name, in
 * fixture order (descending short position), reusing stockFixture per match.
 */
export function searchStocksResponseFixture(query: string): SearchStocksResponse {
  const q = query.trim().toUpperCase();
  const matches = q
    ? FIXTURE_STOCKS.filter(
        (s) => s.code.includes(q) || s.name.toUpperCase().includes(q),
      )
    : [];
  return create(SearchStocksResponseSchema, {
    query,
    stocks: matches.map((m) => stockFixture(m.code)),
    count: matches.length,
  });
}

/**
 * Returns a TimeSeriesData protobuf message for one stock — the shape served
 * by getStockData (app/actions/getStockData) and fetchStockDataClient
 * (lib/client-api), consumed by TimeSeriesWidget and StockChartWidget.
 *
 * Point counts follow PERIOD_DAYS ("1m" 22, "3m" 65, "6m" 130, "1y" 252,
 * "2y" 504, "max" 756; unknown periods fall back to "3m"). shortPosition is
 * in percentage points (19.4 → "19.40%"), random-walked with a per-(code,
 * period) seed, and the terminal point is pinned to latestShortPosition at
 * FIXTURE_BASE_DATE so chart endpoints and legend badges agree. Unknown
 * codes keep the requested code with generic fallback values (5.0%),
 * mirroring stockFixture.
 */
export function timeSeriesDataFixture(
  code: string,
  period = "3m",
): TimeSeriesData {
  const def = FIXTURE_STOCKS.find((s) => s.code === code);
  const latest = def?.latestShortPosition ?? 5.0;
  const days = PERIOD_DAYS[period] ?? PERIOD_DAYS["3m"]!;
  const rand = mulberry32(hashStr(`${code}_ts_${period}`));

  const points: TimeSeriesPoint[] = [];
  let value = latest * 0.85;
  for (let i = days - 1; i >= 1; i--) {
    // Random walk: ±0.3 percentage points per day, floored at 0.1.
    value = Math.max(0.1, value + (rand() - 0.5) * 0.6);
    points.push(
      create(TimeSeriesPointSchema, {
        timestamp: timestampFromDate(daysBeforeBase(i)),
        shortPosition: parseFloat(value.toFixed(2)),
      }),
    );
  }
  // Terminal point pinned to the declared latest short position.
  points.push(
    create(TimeSeriesPointSchema, {
      timestamp: timestampFromDate(FIXTURE_BASE_DATE),
      shortPosition: latest,
    }),
  );

  return create(TimeSeriesDataSchema, {
    productCode: code,
    name: def?.name ?? `${code} Holdings Limited`,
    latestShortPosition: latest,
    points,
  });
}

/**
 * Returns a CorrelationMatrix (Record<code, Record<code, number>>) — the
 * shape served by getCorrelationMatrix in lib/stock-data-service, consumed
 * by CorrelationMatrixWidget.
 *
 * Diagonal is exactly 1; off-diagonal values are symmetric (seeded by the
 * sorted code pair, so matrix[a][b] === matrix[b][a]) in the range
 * (-0.6, 0.9) — biased positive like real equity return correlations — and
 * rounded to 2 dp, matching the widget's `.toFixed(2)` cell labels.
 */
export function correlationMatrixFixture(codes: string[]): CorrelationMatrix {
  const matrix: CorrelationMatrix = {};
  for (const a of codes) {
    const row: Record<string, number> = {};
    for (const b of codes) {
      if (a === b) {
        row[b] = 1;
        continue;
      }
      const pairKey = [a, b].sort().join("|");
      const rand = mulberry32(hashStr(`${pairKey}_corr`));
      row[b] = parseFloat((rand() * 1.5 - 0.6).toFixed(2));
    }
    matrix[a] = row;
  }
  return matrix;
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

// ---------------------------------------------------------------------------
// Sector performance fixture (SectorPerformanceWidget)
// ---------------------------------------------------------------------------

/**
 * Fixed per-sector base values. The six sectors mirror the hardcoded sector
 * list in lib/stock-data-service.ts getSectorPerformance (the widget's
 * sectorColors map covers exactly these names). Performance is in percentage
 * points over the period; a deliberate mix of signs so the pie shows both
 * Badge variants and the heatmap shows green AND red tiles. Volume renders
 * as "Vol: X.XB" via (volume / 1e9).toFixed(1).
 */
const SECTOR_FIXTURES = [
  { sector: "Financials", performance: 1.24, volume: 8.4e9, topGainers: ["CBA", "NAB"], topLosers: ["ANZ", "WBC"] },
  { sector: "Materials", performance: -2.18, volume: 12.1e9, topGainers: ["BHP", "RIO"], topLosers: ["NCM", "FMG"] },
  { sector: "Healthcare", performance: 0.86, volume: 3.2e9, topGainers: ["CSL", "RMD"], topLosers: ["SHL", "COH"] },
  { sector: "Consumer Staples", performance: 0.32, volume: 2.7e9, topGainers: ["WOW", "WES"], topLosers: ["TWE", "COL"] },
  { sector: "Energy", performance: -1.45, volume: 4.9e9, topGainers: ["WDS", "STO"], topLosers: ["OSH", "ORG"] },
  { sector: "Technology", performance: 2.73, volume: 1.8e9, topGainers: ["XRO", "WTC"], topLosers: ["APT", "CPU"] },
] as const;

/** Longer periods accumulate larger moves; unknown periods fall back to 1w. */
const SECTOR_PERIOD_MULTIPLIER: Record<string, number> = {
  "1d": 0.4,
  "1w": 1,
  "1m": 2.1,
  "3m": 3.6,
};

/**
 * Returns SectorPerformance[] — the shape served by getSectorPerformance in
 * lib/stock-data-service, consumed by SectorPerformanceWidget. Six sectors,
 * fixed values scaled by a per-period multiplier (2 dp, matching the
 * widget's `.toFixed(2)` labels). Fully deterministic.
 */
export function sectorPerformanceFixture(period = "1w"): SectorPerformance[] {
  const mult = SECTOR_PERIOD_MULTIPLIER[period] ?? SECTOR_PERIOD_MULTIPLIER["1w"]!;
  return SECTOR_FIXTURES.map((s) => ({
    sector: s.sector,
    performance: parseFloat((s.performance * mult).toFixed(2)),
    volume: s.volume,
    topGainers: [...s.topGainers],
    topLosers: [...s.topLosers],
  }));
}

// ---------------------------------------------------------------------------
// Market news fixture (NewsFeedWidget)
// ---------------------------------------------------------------------------

// Source keys cycle through real NEWS_SOURCES keys (news-source-badge.tsx)
// so badges render branded names; indices 0 and 5 are "asx", which exercises
// the isASXSource() highlight branch (yellow card + Megaphone icon).
const NEWS_SOURCE_CYCLE = ["asx", "stockhead", "livewire", "afr", "smallcaps"] as const;
const NEWS_SENTIMENT_CYCLE = ["positive", "negative", "neutral"] as const;

/**
 * Returns a GetMarketNewsResponse protobuf message — the shape served by
 * ShortedStocksService.GetMarketNews, consumed by NewsFeedWidget (which
 * calls it via an inline Connect client over fetch; stories stub fetch).
 *
 * One article per FIXTURE_STOCKS entry, in fixture order. Deterministic:
 * - publishedAt = FIXTURE_BASE_DATE minus (index + 1) hours
 * - sources cycle NEWS_SOURCE_CYCLE; sentiment cycles NEWS_SENTIMENT_CYCLE
 * - every third article (indices 0, 3, 6, 9) is price-sensitive
 * - the LAST article (index 9) has stockCode "MARKET", which the widget
 *   renders without a stock-code link (market-wide news branch)
 *
 * priceSensitiveOnly filters before limit is applied, mirroring the backend.
 * NOTE: the widget renders no timestamps, so stories stay clock-independent.
 */
export function marketNewsResponseFixture(
  opts: { limit?: number; priceSensitiveOnly?: boolean } = {},
): GetMarketNewsResponse {
  const { limit = 10, priceSensitiveOnly = false } = opts;
  const articles = FIXTURE_STOCKS.map((def, i) => {
    const isMarketWide = i === FIXTURE_STOCKS.length - 1;
    const sentiment = NEWS_SENTIMENT_CYCLE[i % NEWS_SENTIMENT_CYCLE.length]!;
    const verb =
      sentiment === "positive" ? "eases" : sentiment === "negative" ? "climbs" : "holds";
    return create(NewsArticleSchema, {
      id: `fixture-news-${i + 1}-${def.code.toLowerCase()}`,
      stockCode: isMarketWide ? "MARKET" : def.code,
      source: NEWS_SOURCE_CYCLE[i % NEWS_SOURCE_CYCLE.length]!,
      headline: isMarketWide
        ? "ASX market wrap: short interest ticks higher across materials"
        : `${def.name} short interest ${verb} to ${def.latestShortPosition.toFixed(2)}%`,
      url: `https://news.example.com/${i + 1}-${def.code.toLowerCase()}-short-report`,
      publishedAt: timestampFromDate(
        new Date(FIXTURE_BASE_DATE.getTime() - (i + 1) * 3_600_000),
      ),
      sentiment,
      relevanceScore: parseFloat((1 - i * 0.05).toFixed(2)),
      isPriceSensitive: i % 3 === 0,
      summary: `Fixture summary for ${def.name}.`,
    });
  });
  const filtered = priceSensitiveOnly
    ? articles.filter((a) => a.isPriceSensitive)
    : articles;
  return create(GetMarketNewsResponseSchema, {
    articles: filtered.slice(0, limit),
    totalCount: filtered.length,
  });
}

// ---------------------------------------------------------------------------
// Screener fixture (ScreenerWidget)
// ---------------------------------------------------------------------------

/**
 * Returns a ScreenStocksResponse protobuf message — the shape served by the
 * screenStocks server action, consumed by ScreenerWidget (and reusable by
 * the full /screener page).
 *
 * Rows come from FIXTURE_STOCKS in order (already sorted by descending
 * shortPct, matching the widget's SHORT_PCT/DESC request). shortPct equals
 * latestShortPosition (percentage points; 19.4 renders "19.40%").
 * shortPctChange4w is seeded per code in the ±2.5 pp range (renders
 * "+X.XX%"/"-X.XX%" with red/green colouring). Secondary fields are seeded
 * so the fixture also serves richer screener surfaces. totalCount is the
 * full fixture universe regardless of limit, mirroring the backend.
 */
export function screenerResponseFixture(limit = 10): ScreenStocksResponse {
  const stocks = FIXTURE_STOCKS.slice(0, limit).map((def) => {
    const rand = mulberry32(hashStr(def.code + "_screener"));
    const latestVolume = Math.floor(rand() * 5_000_000) + 100_000;
    return create(ScreenerStockSchema, {
      stockCode: def.code,
      companyName: def.name,
      industry: def.industry,
      shortPct: def.latestShortPosition,
      shortPctChange4w: parseFloat(((rand() - 0.5) * 5).toFixed(2)),
      latestPrice: def.basePrice,
      priceChange1m: parseFloat(((rand() - 0.5) * 10).toFixed(2)),
      latestVolume: BigInt(latestVolume),
      marketCap: Math.floor(def.basePrice * (rand() * 2_000_000_000 + 200_000_000)),
      peRatio: parseFloat((rand() * 32 + 8).toFixed(1)),
      dividendYield: parseFloat((rand() * 6).toFixed(2)),
      daysToCover: parseFloat((rand() * 12 + 1).toFixed(1)),
      avgVolume20d: BigInt(latestVolume),
    });
  });
  return create(ScreenStocksResponseSchema, {
    stocks,
    totalCount: FIXTURE_STOCKS.length,
  });
}
