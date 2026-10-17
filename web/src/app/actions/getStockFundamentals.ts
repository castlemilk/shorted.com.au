import { createConnectTransport } from "@connectrpc/connect-web";
import { createClient } from "@connectrpc/connect";
import { StockService } from "~/gen/shorts/v1alpha1/stock_pb";
import type {
  FundamentalsCoverage,
  FundamentalsGrowth,
  FundamentalsPeriod,
  FundamentalsQuality,
  GetStockFundamentalsResponse,
  LatestFilingSummary,
} from "~/gen/shorts/v1alpha1/stock_pb";
import { cache } from "react";
import { unstable_cache } from "next/cache";
import { SERVER_SHORTS_API_URL, serverFetchOutsideNextCache } from "./config";
import {
  STOCK_PAGE_CACHE_SECONDS,
  normalizeStockPageCacheCode,
  stockPageCacheTags,
} from "./stockPageCache";

// Company fundamentals for the stock page's Financials tab and Overview
// summary (docs/plans/fundamentals-coverage.md §7.1), from
// StockService.GetStockFundamentals.
//
// ISR-safe in the same way as getStockHeadlines: the connect call runs inside
// unstable_cache on a serverFetchOutsideNextCache transport (a bare connect
// POST is forced no-store at Vercel runtime, which throws inside a
// revalidating route), and the result is mapped to a plain, serialisable
// shape. A failure throws INSIDE the cached function (so it is never cached)
// and degrades to null outside it; the stock page must never fail because
// fundamentals are unavailable.
//
// This file holds the ONE mapper for the surface (mapStockFundamentals). It is
// the only place proto3's "0 means missing" is resolved: every figure honours
// its has_* flag, so a missing value is null, never 0. Fields an older API
// does not send decode to their defaults and map to "not held" (null, "",
// {}), and an unset coverage maps to status "unknown", never to a status the
// page would render as an empty state.

/** Every period type, newest first: the API ceiling. */
export const STOCK_FUNDAMENTALS_LIMIT = 40;

/** Bump when the mapped shape changes, so a deploy never reads an old entry. */
export const STOCK_FUNDAMENTALS_CACHE_VERSION = "v3";

/** Revalidation tag the picks job pings when it writes fundamentals rows. */
export const FUNDAMENTALS_CACHE_TAG = "fundamentals";

/** One stored period. Null means not held. Values are in `currency`. */
export interface StockFundamentalsPeriod {
  /** "annual" | "half" | "quarter" (balance snapshot) | "ttm"; "" when unknown. */
  periodType: string;
  /** YYYY-MM-DD. */
  periodEnd: string;
  /** Null when the provider did not label the fiscal year. */
  fiscalYear: number | null;
  /** ISO currency code the company reports in ("" when not stated). */
  currency: string;
  /** Row source, e.g. "yahoo-timeseries"; "" when not stated. */
  source: string;
  /** RFC 3339; "" when not stated. */
  fetchedAt: string;
  revenue: number | null;
  netIncome: number | null;
  epsBasic: number | null;
  epsDiluted: number | null;
  operatingCashFlow: number | null;
  sharesOutstanding: number | null;
  freeCashFlow: number | null;
  grossProfit: number | null;
  operatingIncome: number | null;
  ebitda: number | null;
  normalizedEbitda: number | null;
  ebit: number | null;
  interestExpense: number | null;
  pretaxIncome: number | null;
  taxProvision: number | null;
  netInterestIncome: number | null;
  capitalExpenditure: number | null;
  dividendsPaid: number | null;
  shareBuybacks: number | null;
  totalAssets: number | null;
  totalLiabilities: number | null;
  totalEquity: number | null;
  cashAndEquivalents: number | null;
  totalDebt: number | null;
  capitalLeaseObligations: number | null;
  netDebt: number | null;
  currentAssets: number | null;
  currentLiabilities: number | null;
  /**
   * Per-field provenance exceptions, keyed by the wire (snake_case) field
   * name: {"operating_cash_flow": "derived:fcf-minus-capex"}. Empty when
   * every value came from `source`.
   */
  fieldSources: Record<string, string>;
  /** The company filing this row (or its filing-filled fields) came from; "" otherwise. */
  sourceDocumentUrl: string;
  /** YYYY-MM-DD; "" when none. */
  sourceDocumentDate: string;
}

export interface StockFundamentalsGrowth {
  /** Series the EPS growth was computed on: "half", "ttm" or "annual". */
  basisPeriodType: string;
  /** YYYY-MM-DD of the latest period in the EPS series. */
  latestPeriodEnd: string;
  /**
   * Series the revenue growth was computed on: "half", "ttm" or "annual".
   * "" when the API predates it (that API only ever computed revenue annual
   * on annual).
   */
  revenueBasisPeriodType: string;
  /** Revenue vs the same series a year earlier, in percent. */
  revenueYoyPct: number | null;
  /** The same growth one period earlier. */
  revenueYoyPriorPct: number | null;
  /** EPS vs the same series a year earlier; null when the prior is <= 0. */
  epsYoyPct: number | null;
  epsYoyPriorPct: number | null;
  /** Latest annual net income above zero. */
  netIncomePositive: boolean;
  periodsAvailable: number;
  revenueTtm: number | null;
  netIncomeTtm: number | null;
  epsTtm: number | null;
  /** Latest filed half vs the same half a year earlier, whatever the basis. */
  revenueHalfYoyPct: number | null;
  epsHalfYoyPct: number | null;
  /** YYYY-MM-DD of the latest half-year row; "" when none. */
  halfLatestPeriodEnd: string;
  /** "vendor" | "filing"; "" when unknown (an older API). */
  revenueBasisSource: string;
  epsBasisSource: string;
  /** RFC 3339 newest fetch of the growth inputs; "" when unknown. */
  fetchedAt: string;
  /** YYYY-MM-DD ends of the pair revenueYoyPct compares; "" without a pair. */
  revenueLatestPeriodEnd: string;
  revenuePriorPeriodEnd: string;
}

export interface StockFundamentalsQuality {
  /** "annual" | "ttm". */
  basisPeriodType: string;
  basisPeriodEnd: string;
  /** Reporting currency of the flow period. */
  currency: string;
  /** "" when no aligned balance sheet. */
  balancePeriodEnd: string;
  balanceCurrency: string;
  /** Null when no balance sheet is aligned (the lag is then meaningless). */
  balanceLagMonths: number | null;
  /** Source of the flow period, e.g. "yahoo-timeseries". */
  source: string;
  grossMarginPct: number | null;
  operatingMarginPct: number | null;
  netMarginPct: number | null;
  fcfMarginPct: number | null;
  /** Free cash flow / net profit, a ratio (not a percentage). */
  fcfConversion: number | null;
  roePct: number | null;
  roaPct: number | null;
  /** Excludes leases; negative is net cash. In balanceCurrency. */
  netDebt: number | null;
  netDebtToEbitda: number | null;
  netDebtToEquity: number | null;
  currentRatio: number | null;
  interestCover: number | null;
  /** Cash dividends paid / net profit. */
  payoutRatioPct: number | null;
  isFinancial: boolean;
  isProperty: boolean;
  operatingCashFlowDerived: boolean;
  /** AUD: latest close x shares on issue. */
  marketCap: number | null;
  peRatio: number | null;
  priceToBook: number | null;
  priceAsOf: string;
  sharesAsOf: string;
  peEpsPeriodEnd: string;
  /** "diluted" | "basic" | "". */
  peEpsBasis: string;
  /** Why a valuation figure is absent: "non-aud", "listed-unit", "no-shares", "no-price", "". */
  valuationNote: string;
  /** Ratio names (snake_case) withheld because the company is a financial. */
  notMeaningful: string[];
}

/**
 * "covered" | "empty" | "pending" | "failed" from the API; "unknown" when the
 * API sent no coverage (an older API) or a status this page does not know.
 * Only the three definite "no rows" statuses may drive an empty state.
 */
export type FundamentalsCoverageStatus =
  | "covered"
  | "empty"
  | "pending"
  | "failed"
  | "unknown";

export interface StockFundamentalsCoverage {
  status: FundamentalsCoverageStatus;
  /** RFC 3339; "" when unknown. */
  lastAttemptAt: string;
  lastSuccessAt: string;
  sources: string[];
}

export interface StockLatestFiling {
  reportUrl: string;
  reportTitle: string;
  /** YYYY-MM-DD. */
  reportDate: string;
  /** YYYY-MM-DD, the period the filing reports. */
  periodEnd: string;
  /** "annual" | "half". */
  periodType: string;
  digest: string;
  /** 0-1. */
  digestConfidence: number;
}

export interface StockFundamentals {
  stockCode: string;
  /** Every period type, newest first; empty when nothing is held yet. */
  periods: StockFundamentalsPeriod[];
  growth: StockFundamentalsGrowth | null;
  quality: StockFundamentalsQuality | null;
  coverage: StockFundamentalsCoverage;
  latestFiling: StockLatestFiling | null;
}

function flagged(
  value: number | undefined,
  has: boolean | undefined,
): number | null {
  return has === true && typeof value === "number" && Number.isFinite(value)
    ? value
    : null;
}

function text(value: string | undefined | null): string {
  return typeof value === "string" ? value.trim() : "";
}

function upper(value: string | undefined | null): string {
  return text(value).toUpperCase();
}

function stringMap(
  value: Record<string, string> | undefined,
): Record<string, string> {
  const out: Record<string, string> = {};
  if (!value) return out;
  for (const [key, source] of Object.entries(value)) {
    const k = text(key);
    const v = text(source);
    if (k && v) out[k] = v;
  }
  return out;
}

export function mapPeriod(p: FundamentalsPeriod): StockFundamentalsPeriod {
  return {
    periodType: text(p.periodType).toLowerCase(),
    periodEnd: text(p.periodEnd),
    fiscalYear:
      typeof p.fiscalYear === "number" && p.fiscalYear > 0
        ? p.fiscalYear
        : null,
    currency: upper(p.currency),
    source: text(p.source),
    fetchedAt: text(p.fetchedAt),
    revenue: flagged(p.revenue, p.hasRevenue),
    netIncome: flagged(p.netIncome, p.hasNetIncome),
    epsBasic: flagged(p.epsBasic, p.hasEpsBasic),
    epsDiluted: flagged(p.epsDiluted, p.hasEpsDiluted),
    operatingCashFlow: flagged(p.operatingCashFlow, p.hasOperatingCashFlow),
    sharesOutstanding: flagged(p.sharesOutstanding, p.hasSharesOutstanding),
    freeCashFlow: flagged(p.freeCashFlow, p.hasFreeCashFlow),
    grossProfit: flagged(p.grossProfit, p.hasGrossProfit),
    operatingIncome: flagged(p.operatingIncome, p.hasOperatingIncome),
    ebitda: flagged(p.ebitda, p.hasEbitda),
    normalizedEbitda: flagged(p.normalizedEbitda, p.hasNormalizedEbitda),
    ebit: flagged(p.ebit, p.hasEbit),
    interestExpense: flagged(p.interestExpense, p.hasInterestExpense),
    pretaxIncome: flagged(p.pretaxIncome, p.hasPretaxIncome),
    taxProvision: flagged(p.taxProvision, p.hasTaxProvision),
    netInterestIncome: flagged(p.netInterestIncome, p.hasNetInterestIncome),
    capitalExpenditure: flagged(p.capitalExpenditure, p.hasCapitalExpenditure),
    dividendsPaid: flagged(p.dividendsPaid, p.hasDividendsPaid),
    shareBuybacks: flagged(p.shareBuybacks, p.hasShareBuybacks),
    totalAssets: flagged(p.totalAssets, p.hasTotalAssets),
    totalLiabilities: flagged(p.totalLiabilities, p.hasTotalLiabilities),
    totalEquity: flagged(p.totalEquity, p.hasTotalEquity),
    cashAndEquivalents: flagged(p.cashAndEquivalents, p.hasCashAndEquivalents),
    totalDebt: flagged(p.totalDebt, p.hasTotalDebt),
    capitalLeaseObligations: flagged(
      p.capitalLeaseObligations,
      p.hasCapitalLeaseObligations,
    ),
    netDebt: flagged(p.netDebt, p.hasNetDebt),
    currentAssets: flagged(p.currentAssets, p.hasCurrentAssets),
    currentLiabilities: flagged(p.currentLiabilities, p.hasCurrentLiabilities),
    fieldSources: stringMap(p.fieldSources),
    sourceDocumentUrl: text(p.sourceDocumentUrl),
    sourceDocumentDate: text(p.sourceDocumentDate),
  };
}

export function mapGrowth(
  growth: FundamentalsGrowth | undefined,
  hasGrowth: boolean,
): StockFundamentalsGrowth | null {
  if (!growth || !hasGrowth) return null;
  return {
    basisPeriodType: text(growth.basisPeriodType).toLowerCase(),
    latestPeriodEnd: text(growth.latestPeriodEnd),
    revenueBasisPeriodType: text(growth.revenueBasisPeriodType).toLowerCase(),
    revenueYoyPct: flagged(growth.revenueYoyPct, growth.hasRevenueYoy),
    revenueYoyPriorPct: flagged(
      growth.revenueYoyPriorPct,
      growth.hasRevenueYoyPrior,
    ),
    epsYoyPct: flagged(growth.epsYoyPct, growth.hasEpsYoy),
    epsYoyPriorPct: flagged(growth.epsYoyPriorPct, growth.hasEpsYoyPrior),
    netIncomePositive: growth.netIncomePositive === true,
    periodsAvailable:
      typeof growth.periodsAvailable === "number" && growth.periodsAvailable > 0
        ? growth.periodsAvailable
        : 0,
    revenueTtm: flagged(growth.revenueTtm, growth.hasRevenueTtm),
    netIncomeTtm: flagged(growth.netIncomeTtm, growth.hasNetIncomeTtm),
    epsTtm: flagged(growth.epsTtm, growth.hasEpsTtm),
    revenueHalfYoyPct: flagged(
      growth.revenueHalfYoyPct,
      growth.hasRevenueHalfYoy,
    ),
    epsHalfYoyPct: flagged(growth.epsHalfYoyPct, growth.hasEpsHalfYoy),
    halfLatestPeriodEnd: text(growth.halfLatestPeriodEnd),
    revenueBasisSource: text(growth.revenueBasisSource).toLowerCase(),
    epsBasisSource: text(growth.epsBasisSource).toLowerCase(),
    fetchedAt: text(growth.fetchedAt),
    revenueLatestPeriodEnd: text(growth.revenueLatestPeriodEnd),
    revenuePriorPeriodEnd: text(growth.revenuePriorPeriodEnd),
  };
}

export function mapQuality(
  quality: FundamentalsQuality | undefined,
  hasQuality: boolean,
): StockFundamentalsQuality | null {
  if (!quality || !hasQuality) return null;
  const balancePeriodEnd = text(quality.balancePeriodEnd);
  return {
    basisPeriodType: text(quality.basisPeriodType).toLowerCase(),
    basisPeriodEnd: text(quality.basisPeriodEnd),
    currency: upper(quality.currency),
    balancePeriodEnd,
    balanceCurrency: upper(quality.balanceCurrency),
    balanceLagMonths:
      balancePeriodEnd &&
      typeof quality.balanceLagMonths === "number" &&
      quality.balanceLagMonths >= 0
        ? quality.balanceLagMonths
        : null,
    source: text(quality.source),
    grossMarginPct: flagged(quality.grossMarginPct, quality.hasGrossMarginPct),
    operatingMarginPct: flagged(
      quality.operatingMarginPct,
      quality.hasOperatingMarginPct,
    ),
    netMarginPct: flagged(quality.netMarginPct, quality.hasNetMarginPct),
    fcfMarginPct: flagged(quality.fcfMarginPct, quality.hasFcfMarginPct),
    fcfConversion: flagged(quality.fcfConversion, quality.hasFcfConversion),
    roePct: flagged(quality.roePct, quality.hasRoePct),
    roaPct: flagged(quality.roaPct, quality.hasRoaPct),
    netDebt: flagged(quality.netDebt, quality.hasNetDebt),
    netDebtToEbitda: flagged(
      quality.netDebtToEbitda,
      quality.hasNetDebtToEbitda,
    ),
    netDebtToEquity: flagged(
      quality.netDebtToEquity,
      quality.hasNetDebtToEquity,
    ),
    currentRatio: flagged(quality.currentRatio, quality.hasCurrentRatio),
    interestCover: flagged(quality.interestCover, quality.hasInterestCover),
    payoutRatioPct: flagged(quality.payoutRatioPct, quality.hasPayoutRatioPct),
    isFinancial: quality.isFinancial === true,
    isProperty: quality.isProperty === true,
    operatingCashFlowDerived: quality.operatingCashFlowDerived === true,
    marketCap: flagged(quality.marketCap, quality.hasMarketCap),
    peRatio: flagged(quality.peRatio, quality.hasPeRatio),
    priceToBook: flagged(quality.priceToBook, quality.hasPriceToBook),
    priceAsOf: text(quality.priceAsOf),
    sharesAsOf: text(quality.sharesAsOf),
    peEpsPeriodEnd: text(quality.peEpsPeriodEnd),
    peEpsBasis: text(quality.peEpsBasis).toLowerCase(),
    valuationNote: text(quality.valuationNote).toLowerCase(),
    notMeaningful: (quality.notMeaningful ?? [])
      .map((name) => text(name))
      .filter(Boolean),
  };
}

const COVERAGE_STATUSES: readonly FundamentalsCoverageStatus[] = [
  "covered",
  "empty",
  "pending",
  "failed",
];

export function mapCoverage(
  coverage: FundamentalsCoverage | undefined,
): StockFundamentalsCoverage {
  const raw = text(coverage?.status).toLowerCase();
  const status = (COVERAGE_STATUSES as readonly string[]).includes(raw)
    ? (raw as FundamentalsCoverageStatus)
    : "unknown";
  return {
    status,
    lastAttemptAt: text(coverage?.lastAttemptAt),
    lastSuccessAt: text(coverage?.lastSuccessAt),
    sources: (coverage?.sources ?? []).map((s) => text(s)).filter(Boolean),
  };
}

export function mapLatestFiling(
  filing: LatestFilingSummary | undefined,
  hasLatestFiling: boolean,
): StockLatestFiling | null {
  if (!filing || !hasLatestFiling) return null;
  const digest = text(filing.digest);
  const reportTitle = text(filing.reportTitle);
  // A summary without its text or its title cannot be labelled or shown.
  if (!digest || !reportTitle) return null;
  return {
    reportUrl: text(filing.reportUrl),
    reportTitle,
    reportDate: text(filing.reportDate),
    periodEnd: text(filing.periodEnd),
    periodType: text(filing.periodType).toLowerCase(),
    digest,
    digestConfidence:
      typeof filing.digestConfidence === "number" &&
      Number.isFinite(filing.digestConfidence)
        ? filing.digestConfidence
        : 0,
  };
}

/** Newest period end first; a stable sort keeps the API's order on ties. */
function newestFirst(
  a: StockFundamentalsPeriod,
  b: StockFundamentalsPeriod,
): number {
  return b.periodEnd.localeCompare(a.periodEnd);
}

/** The response fields the mapper reads; every newer field is optional. */
export type StockFundamentalsResponseLike = Pick<
  GetStockFundamentalsResponse,
  "periods" | "growth" | "hasGrowth"
> &
  Partial<
    Pick<
      GetStockFundamentalsResponse,
      "quality" | "hasQuality" | "coverage" | "latestFiling" | "hasLatestFiling"
    >
  >;

/**
 * THE mapper: a GetStockFundamentals response (current or older API) to the
 * page's plain shape.
 */
export function mapStockFundamentals(
  code: string,
  response: StockFundamentalsResponseLike,
): StockFundamentals {
  return {
    stockCode: code,
    periods: (response.periods ?? [])
      .slice(0, STOCK_FUNDAMENTALS_LIMIT)
      .map(mapPeriod)
      .filter((p) => p.periodEnd !== "")
      .sort(newestFirst),
    growth: mapGrowth(response.growth, response.hasGrowth),
    quality: mapQuality(response.quality, response.hasQuality === true),
    coverage: mapCoverage(response.coverage),
    latestFiling: mapLatestFiling(
      response.latestFiling,
      response.hasLatestFiling === true,
    ),
  };
}

async function fetchStockFundamentals(code: string): Promise<StockFundamentals> {
  const transport = createConnectTransport({
    fetch: serverFetchOutsideNextCache,
    baseUrl: SERVER_SHORTS_API_URL,
  });
  const client = createClient(StockService, transport);
  const response = await client.getStockFundamentals({
    stockCode: code,
    // Empty asks for every period type: annual, half, ttm and the quarter
    // balance snapshots the statements read at half and year ends.
    periodType: "",
    limit: STOCK_FUNDAMENTALS_LIMIT,
  });
  return mapStockFundamentals(code, response);
}

/** The cache tags of one stock's fundamentals entry. */
export function stockFundamentalsCacheTags(code: string): string[] {
  return [...stockPageCacheTags("fundamentals", code), FUNDAMENTALS_CACHE_TAG];
}

/**
 * A stock's fundamentals (every period type, the growth and ratio rows, the
 * collection status and the latest filing summary), or null when the API is
 * unavailable. A known stock without coverage yields `periods: []` with its
 * coverage status (cached like any other answer: the picks job pings the
 * `fundamentals` tag when it writes rows, and the daily shorts-data bust
 * covers the rest).
 */
export const getStockFundamentals = cache(
  async (stockCode: string): Promise<StockFundamentals | null> => {
    const code = normalizeStockPageCacheCode(stockCode);
    try {
      return await unstable_cache(
        () => fetchStockFundamentals(code),
        ["stock-fundamentals", code, STOCK_FUNDAMENTALS_CACHE_VERSION],
        {
          tags: stockFundamentalsCacheTags(code),
          revalidate: STOCK_PAGE_CACHE_SECONDS,
        },
      )();
    } catch (err) {
      console.error(`[getStockFundamentals] failed for ${code}:`, err);
      return null;
    }
  },
);
