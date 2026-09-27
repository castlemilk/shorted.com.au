import { createConnectTransport } from "@connectrpc/connect-web";
import { createClient } from "@connectrpc/connect";
import { StockService } from "~/gen/shorts/v1alpha1/stock_pb";
import type {
  FundamentalsGrowth,
  FundamentalsPeriod,
} from "~/gen/shorts/v1alpha1/stock_pb";
import { cache } from "react";
import { unstable_cache } from "next/cache";
import { SERVER_SHORTS_API_URL, serverFetchOutsideNextCache } from "./config";
import {
  STOCK_PAGE_CACHE_SECONDS,
  normalizeStockPageCacheCode,
  stockPageCacheTags,
} from "./stockPageCache";

// Reported annual fundamentals for the stock page's fundamentals block
// (docs/plans/stock-picker.md §8), from StockService.GetStockFundamentals.
//
// ISR-safe in the same way as getStockHeadlines: the connect call runs inside
// unstable_cache on a serverFetchOutsideNextCache transport (a bare connect
// POST is forced no-store at Vercel runtime, which throws inside a
// revalidating route), and the result is mapped to a plain, serialisable
// shape. Any failure degrades to null so the block simply does not render;
// the stock page must never fail because fundamentals are unavailable.
//
// Every figure honours its has_* flag: a missing value is null, never 0.

/** Annual periods shown on the stock page. */
export const STOCK_FUNDAMENTALS_PERIODS = 4;

/** One reported annual period, newest first. Null means not reported. */
export interface StockFundamentalsPeriod {
  /** YYYY-MM-DD. */
  periodEnd: string;
  /** Null when the provider did not label the fiscal year. */
  fiscalYear: number | null;
  /** ISO currency code the company reports in ("" when not stated). */
  currency: string;
  revenue: number | null;
  netIncome: number | null;
  epsDiluted: number | null;
  operatingCashFlow: number | null;
}

export interface StockFundamentalsGrowth {
  /** Series the EPS growth was computed on: "ttm" or "annual". */
  basisPeriodType: string;
  /** Latest annual revenue vs the prior annual, in percent. */
  revenueYoyPct: number | null;
  /** EPS vs the same series a year earlier; null when the prior is <= 0. */
  epsYoyPct: number | null;
}

export interface StockFundamentals {
  stockCode: string;
  /** Newest first; empty when the stock has no fundamentals coverage yet. */
  periods: StockFundamentalsPeriod[];
  growth: StockFundamentalsGrowth | null;
}

function flagged(value: number, has: boolean): number | null {
  return has && Number.isFinite(value) ? value : null;
}

function mapPeriod(p: FundamentalsPeriod): StockFundamentalsPeriod {
  return {
    periodEnd: p.periodEnd,
    fiscalYear: p.fiscalYear > 0 ? p.fiscalYear : null,
    currency: (p.currency ?? "").trim().toUpperCase(),
    revenue: flagged(p.revenue, p.hasRevenue),
    netIncome: flagged(p.netIncome, p.hasNetIncome),
    epsDiluted: flagged(p.epsDiluted, p.hasEpsDiluted),
    operatingCashFlow: flagged(p.operatingCashFlow, p.hasOperatingCashFlow),
  };
}

function mapGrowth(
  growth: FundamentalsGrowth | undefined,
  hasGrowth: boolean,
): StockFundamentalsGrowth | null {
  if (!growth || !hasGrowth) return null;
  return {
    basisPeriodType: growth.basisPeriodType,
    revenueYoyPct: flagged(growth.revenueYoyPct, growth.hasRevenueYoy),
    epsYoyPct: flagged(growth.epsYoyPct, growth.hasEpsYoy),
  };
}

async function fetchStockFundamentals(
  code: string,
): Promise<StockFundamentals> {
  const transport = createConnectTransport({
    fetch: serverFetchOutsideNextCache,
    baseUrl: SERVER_SHORTS_API_URL,
  });
  const client = createClient(StockService, transport);
  const response = await client.getStockFundamentals({
    stockCode: code,
    periodType: "annual",
    limit: STOCK_FUNDAMENTALS_PERIODS,
  });
  return {
    stockCode: code,
    periods: (response.periods ?? [])
      .slice(0, STOCK_FUNDAMENTALS_PERIODS)
      .map(mapPeriod),
    growth: mapGrowth(response.growth, response.hasGrowth),
  };
}

/**
 * A stock's last four reported annual periods plus its growth row, or null
 * when the API is unavailable or does not know the code. A known stock
 * without coverage yields `periods: []` (cached like any other answer: the
 * fundamentals job fills coverage over days, and the daily shorts-data tag
 * bust picks it up).
 */
export const getStockFundamentals = cache(
  async (stockCode: string): Promise<StockFundamentals | null> => {
    const code = normalizeStockPageCacheCode(stockCode);
    try {
      return await unstable_cache(
        () => fetchStockFundamentals(code),
        ["stock-fundamentals", code, `annual-${STOCK_FUNDAMENTALS_PERIODS}-v1`],
        {
          tags: stockPageCacheTags("fundamentals", code),
          revalidate: STOCK_PAGE_CACHE_SECONDS,
        },
      )();
    } catch (err) {
      console.error(`[getStockFundamentals] failed for ${code}:`, err);
      return null;
    }
  },
);
