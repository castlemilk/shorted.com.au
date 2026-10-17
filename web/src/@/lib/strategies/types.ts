// Plain, serialisable shapes for the stock picker.
//
// Nothing here is a protobuf object. The server actions map StrategyService
// responses into these types (see ./map.ts) so that only JSON-safe data ever
// crosses the RSC boundary into client islands, and so that "unknown" is
// represented ONCE, as null, instead of as proto3's indistinguishable 0.
// Every table cell reads a nullable number and renders "n/a" for null: the
// screener's "0 means unknown" defect is exactly what this feature must not
// repeat (docs/plans/stock-picker.md §3.1).

export type RuleStatus = "pass" | "fail" | "unknown";
export type PickStatus = "triggered" | "setup" | "watch";
/** Empty string when the API could not read the regime. */
export type RegimeLabel = "uptrend" | "neutral" | "downtrend" | "";

export const PICK_STATUSES: readonly PickStatus[] = ["triggered", "setup", "watch"];

export interface StrategyRuleDef {
  id: string;
  title: string;
  /** The rule in the author's terms. */
  ruleText: string;
  /** Exactly how we test it, with thresholds. */
  evaluation: string;
  /** Must pass for status "triggered". */
  core: boolean;
  /** "stock_fundamentals" | "stock_prices" | "index_prices" | "asic_shorts". */
  dataSource: string;
}

export interface StrategyMetadataDef {
  style: string;
  holdingPeriod: string;
  riskPosture: string;
  universe: string;
  refreshCadence: string;
  ruleCount: number;
}

export interface StrategyDef {
  id: string;
  name: string;
  author: string;
  tagline: string;
  descriptionParagraphs: string[];
  rules: StrategyRuleDef[];
  metadata: StrategyMetadataDef | null;
  caveats: string[];
  sources: string[];
}

export interface MarketRegimeView {
  indexCode: string;
  /** YYYY-MM-DD of the last index close, "" when unknown. */
  asOf: string;
  regime: RegimeLabel;
  close: number | null;
  sma50: number | null;
  sma200: number | null;
  pctOff52wHigh: number | null;
  /** Strategy-specific sentence (neutral on the hub). */
  verdict: string;
}

export interface RuleResultRow {
  ruleId: string;
  status: RuleStatus;
  /** Human-readable evidence, e.g. "Revenue +41% YoY". */
  detail: string;
}

/** A growth series: "annual" (FY), "half" (HY) or "ttm" (trailing 12 months). */
export type GrowthBasis = "annual" | "half" | "ttm";

/**
 * The fundamentals one picks row renders (docs/plans/fundamentals-coverage.md
 * §7.2), mapped from StrategyPick.fundamentals.
 *
 * RENDERED FIELDS ONLY, NULLS OMITTED: a key is present only when the table
 * shows something for it, so a 100-row table stays within its payload budget
 * (the page test pins +25 KB). Ratios are rounded to the one decimal the
 * table prints. There is deliberately no "vendor" marker: like the stock
 * page's growth row, provenance is recorded as the exception (a company
 * filing), never guessed for the default.
 */
export interface PickFundamentalsView {
  /** Series the revenue growth figure compares; present only with that figure. */
  revenueBasis?: GrowthBasis;
  /** YYYY-MM-DD end of the latest period in the revenue pair. */
  revenueEnd?: string;
  /** The revenue pair includes a value extracted from a company filing. */
  revenueFiling?: true;
  /** Series the EPS growth figure compares; present only with that figure. */
  epsBasis?: GrowthBasis;
  /** YYYY-MM-DD end of the latest period in the EPS pair. */
  epsEnd?: string;
  /** The EPS pair includes a value extracted from a company filing. */
  epsFiling?: true;
  /**
   * Reporting currency (ISO 4217) when it is NOT AUD. The only thing the row
   * prints it for is P/E's "n/a (reports in USD)".
   */
  currency?: string;
  /** YYYY-MM-DD (the date in Sydney) of the newest fetch of the inputs. */
  fetchedOn?: string;
  netMarginPct?: number;
  roePct?: number;
  fcfMarginPct?: number;
  /** Net debt excluding leases over EBITDA (normalised when published). */
  netDebtToEbitda?: number;
  /** Latest close over 12-month EPS; AUD reporters only. */
  peRatio?: number;
  /**
   * The ratios this row shows that the API withheld as not meaningful (a
   * bank, insurer or other financial), as wire names ("fcf_margin_pct").
   */
  notMeaningful?: string[];
}

export interface PickRow {
  /** 1-based rank across the full, unfiltered list. */
  rank: number;
  code: string;
  name: string;
  industry: string;
  status: PickStatus;
  /** 0-100, orders rows within a status. */
  score: number;
  /** One result per strategy rule, in the strategy's rule order. */
  rules: RuleResultRow[];
  close: number | null;
  /** YYYY-MM-DD of the last price. */
  asOf: string;
  /** The base high: the breakout level, and the exit if price falls back below it. */
  pivot: number | null;
  baseDepthPct: number | null;
  baseLengthDays: number | null;
  volumeRatio: number | null;
  revenueYoyPct: number | null;
  epsYoyPct: number | null;
  /** Stock return minus the S&P/ASX 200 return over 3 months, in points. */
  rs3mPct: number | null;
  /** Null when the stock has no ASIC short row; 0 is a reported zero position. */
  shortPct: number | null;
  marketCap: number | null;
  logoUrl: string;
  /**
   * Omitted when the stock has no fundamentals row, AND when the API predates
   * StrategyPick.fundamentals: which of the two it is, is the response's
   * business (StrategyPicksResult.fundamentalsRowsCount, fundamentalsHeld).
   */
  fundamentals?: PickFundamentalsView;
}

export interface StrategyPicksResult {
  strategy: StrategyDef;
  regime: MarketRegimeView | null;
  /** At most 100 rows, ranked (status first, then score). */
  picks: PickRow[];
  /** Every ranked pick, before the row limit. */
  totalCount: number;
  /** Stocks evaluated. */
  universeCount: number;
  /** Evaluated stocks with at least one growth figure. */
  fundamentalsCoverageCount: number;
  /**
   * Evaluated stocks with any fundamentals row. 0 from an API that predates
   * the field (proto3 cannot tell it from none), which is why every reader
   * goes through fundamentalsHeld().
   */
  fundamentalsRowsCount: number;
  /** YYYY-MM-DD of the latest price in the universe. */
  asOf: string;
}

export interface StrategiesResult {
  strategies: StrategyDef[];
  /** Strategy-neutral verdict. */
  regime: MarketRegimeView | null;
}
