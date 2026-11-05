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
  /** A trigger: a core rule a setup may still fail (the breakout, the new-high or leadership rule). */
  trigger?: boolean;
  /** Share of the score this rule carries, 0-1. */
  weight?: number;
  /** The number the rule tests, in `unit`; absent for a rule with no single number. */
  threshold?: number;
  /** "pct", "pp", "aud", "days", "x" or empty; the display symbol is the web's. */
  unit?: string;
  /** ">=", "<=" or ">". */
  comparator?: string;
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
  /** The live rules version the definition is evaluated under; absent when the API names none. */
  version?: StrategyVersionDef;
}

/** One published rules version, as the changelog states it. */
export interface StrategyVersionDetailView {
  version: StrategyVersionDef;
  /** Universe and data policy, one sentence each. */
  policies: string[];
  /** What this version changed from the one before it. */
  changes: string[];
  /** What this version gets wrong, worded as defects. */
  knownIssues: string[];
  /** YYYY-MM-DD the next version went live; "" while it is live. */
  supersededOn: string;
  /** YYYY-MM-DD the version was retired; "" while it is still evaluated. */
  retiredOn: string;
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
  /** The measured value the rule tested; absent when the rule has none. */
  value?: number;
  /** Why an unknown result could not be tested, e.g. "no_fundamentals". */
  reason?: string;
  /** For a failing trigger rule: 0-1, 1 at the trigger line and 0 at the far distance. */
  proximity?: number;
  /** True for a failing trigger on a setup row: the stock is waiting for it. */
  waiting?: boolean;
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
  /** Percent below the 52-week high; 0 is at the high. Absent with no 52-week high yet. */
  pctOff52wHigh?: number;
  /** Short position over average daily volume, in days. */
  daysToCover?: number;
  /** Stock return minus the index return over 6 months, in points. */
  rs6mPct?: number;
  /** Rank of this stock's rs_6m across the evaluated universe, 0-100; 75 or more is the top quartile (a type-7 rank, not a share of stocks). */
  rs6mPercentile?: number;
  /** Average daily turnover over 20 sessions, A$. */
  dollarVolume20d?: number;
  /** YYYY-MM-DD of the breakout session. */
  breakoutDate?: string;
  /** YYYY-MM-DD of the ASIC report the short figure came from. */
  shortReportDate?: string;
  /** YYYY-MM-DD the short report became public. */
  shortAvailableDate?: string;
  /** "reported" when the stock has a short position in ASIC's report; absent otherwise. */
  shortStatus?: string;
  /** YYYY-MM-DD of a corporate action that may have changed the share basis; absent until that check ships. */
  caSuspectDate?: string;
}

/** The count of picks in each status, over the whole ranked list. */
export interface StatusCountsView {
  triggered: number;
  setup: number;
  watch: number;
  unknown: number;
}

/** A strategy rules version: the picks, the fit and the definition name the same one. */
export interface StrategyVersionDef {
  strategyId: string;
  label: string;
  rulesHash: string;
  engineVersion: string;
  featureSet: string;
  status: string;
  liveFrom: string;
  kind: string;
  variantId: string;
}

/** The response-level signal fields of GetStrategyPicks. Absent when the API predates them. */
export interface PicksSignals {
  /** Picks by status over the whole ranked list, before any filter or page. */
  statusCounts?: StatusCountsView;
  /** YYYY-MM-DD of the session the picks are as at. */
  sessionDate?: string;
  /** YYYY-MM-DD of the newest ASIC report behind the short figures. */
  shortReportDate?: string;
  /** YYYY-MM-DD the newest short report became public. */
  shortAvailableDate?: string;
  /** True when the index has closed a session the prices have not reached (the data is delayed). */
  stale?: boolean;
  /** The universe's top-quartile cut-off of rs_6m_pct, which rs_leader reads. */
  rsQuantileThreshold?: number;
  /** The universe the picks were drawn from, as the strategy names it. */
  universeLabel?: string;
  version?: StrategyVersionDef;
}

export interface StrategyPicksResult extends PicksSignals {
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
