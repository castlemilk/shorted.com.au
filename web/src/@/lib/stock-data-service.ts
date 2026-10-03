"use client";

// Stock data service using market data API
import { isAbortError, retryWithBackoff, shouldRetryConnectError } from "~/@/lib/retry";

export const QUOTE_REFRESH_INTERVAL_MS = 30 * 60 * 1000;

class QuoteRequestError extends Error {
  // Reuse the existing monthly/per-minute retry policy for HTTP 429s.
  readonly code: number | undefined;
  constructor(readonly status: number, readonly metadata: Headers) {
    super(`Market data API returned ${status} for quotes`);
    this.code = status === 429 ? 8 : undefined;
  }
}

export interface StockQuote {
  symbol: string;
  price: number;
  change: number;
  changePercent: number;
  previousClose: number;
  volume?: number;
  high?: number;
  low?: number;
  open?: number;
}

export interface HistoricalDataPoint {
  date: string;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  adjustedClose?: number;
}

export type CorrelationMatrix = Record<string, Record<string, number>>;

export interface SectorPerformance {
  sector: string;
  performance: number;
  volume: number;
  topGainers: string[];
  topLosers: string[];
}

export interface StockSearchResult {
  product_code: string;
  name: string;
  percentage_shorted: number;
  total_product_in_issue: number;
  reported_short_positions: number;
  // Enriched optional fields
  industry?: string;
  tags?: string[];
  companyName?: string;
  logo_url?: string; // From API (snake_case)
  logoUrl?: string; // Normalized (camelCase)
  currentPrice?: number;
  priceChange?: number;
  marketCap?: number;
  peRatio?: number;
  beta?: number;
}

export interface StockSearchResponse {
  query: string;
  stocks: StockSearchResult[];
  count: number;
}

/**
 * Get multiple stock quotes from market data API (Connect RPC)
 */
export async function getMultipleStockQuotes(
  stockCodes: string[],
  signal?: AbortSignal,
): Promise<Map<string, StockQuote>> {
  if (stockCodes.length === 0) return new Map();

  try {
    return await retryWithBackoff(
      async () => {
        const response = await fetch("/api/market-data/multiple-quotes", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            stockCodes: stockCodes.map((code) => code.toUpperCase()),
          }),
          signal,
        });

        if (!response.ok) {
          throw new QuoteRequestError(response.status, response.headers ?? new Headers());
        }

        const apiResponse = (await response.json()) as {
          prices: Record<
            string,
            {
              stockCode: string;
              date: string;
              open?: number;
              high?: number;
              low?: number;
              close: number;
              volume?: string | number;
              adjustedClose?: number;
              change?: number;
              changePercent?: number;
            }
          >;
        };

        const quotes = new Map<string, StockQuote>();
        if (apiResponse.prices) {
          Object.entries(apiResponse.prices).forEach(([symbol, price]) => {
            // Connect's protobuf JSON omits zero-valued scalars. A flat day's
            // missing change must stay zero in portfolio and sector arithmetic.
            const change = price.change ?? 0;
            quotes.set(symbol, {
              symbol: price.stockCode,
              price: price.close,
              change,
              changePercent: price.changePercent ?? 0,
              previousClose: price.close - change,
              volume: Number(price.volume ?? 0),
              high: price.high ?? 0,
              low: price.low ?? 0,
              open: price.open ?? 0,
            });
          });
        }
        return quotes;
      },
      {
        maxRetries: 3, initialDelayMs: 500, signal,
        shouldRetry: (error) => {
          if (error instanceof QuoteRequestError && error.status >= 400 && error.status < 500 &&
            error.status !== 408 && error.status !== 429) return false;
          return shouldRetryConnectError(error);
        },
      },
    );
  } catch (error) {
    if ((signal?.aborted ?? false) || isAbortError(error)) throw error;
    console.warn(
      "Failed to fetch stock quotes after retries:",
      error instanceof Error ? error.message : String(error),
    );
    return new Map();
  }
}

/**
 * Get historical data from market data API via Next.js API route
 */
export async function getHistoricalData(
  stockCode: string,
  period = "1m",
): Promise<HistoricalDataPoint[]> {
  try {
    return await retryWithBackoff(
      async () => {
        const response = await fetch("/api/market-data/historical", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            stockCode: stockCode.toUpperCase(),
            period: period.toLowerCase(),
          }),
        });

        if (!response.ok) {
          throw new Error(
            `Market data API returned ${response.status} for ${stockCode}`,
          );
        }

        const apiResponse = (await response.json()) as {
          prices?: Array<{
            stockCode: string;
            date: string;
            open: number;
            high: number;
            low: number;
            close: number;
            volume: string;
            adjustedClose: number;
            change: number;
            changePercent: number;
          }>;
        };

        if (!apiResponse.prices || apiResponse.prices.length === 0) {
          // No data for this stock is not a transient error — don't retry
          return [];
        }

        return apiResponse.prices.map((price) => ({
          date:
            price.date?.split("T")[0] ??
            new Date().toISOString().split("T")[0]!,
          open: price.open,
          high: price.high,
          low: price.low,
          close: price.close,
          volume: parseInt(price.volume, 10),
          adjustedClose: price.adjustedClose,
        }));
      },
      { maxRetries: 3, initialDelayMs: 500 },
    );
  } catch (error) {
    console.warn(
      `Failed to fetch historical data for ${stockCode} after retries:`,
      error instanceof Error ? error.message : String(error),
    );
    return [];
  }
}

/**
 * Get correlation matrix from market data API
 */
export async function getCorrelationMatrix(
  stockCodes: string[],
  period = "1y",
): Promise<CorrelationMatrix> {
  return retryWithBackoff(
    async () => {
      const response = await fetch("/api/market-data/correlations", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          stockCodes: stockCodes.map((code) => code.toUpperCase()),
          period: period.toLowerCase(),
        }),
      });

      if (!response.ok) {
        throw new Error(
          `Market data API returned ${response.status} for correlations`,
        );
      }

      const data = (await response.json()) as {
        correlations: Record<
          string,
          { correlations?: Record<string, number> }
        >;
      };
      const matrix: CorrelationMatrix = {};

      Object.entries(data.correlations ?? {}).forEach(
        ([stock1, correlationRow]) => {
          if (correlationRow?.correlations) {
            matrix[stock1] = correlationRow.correlations;
          }
        },
      );

      return matrix;
    },
    { maxRetries: 3, initialDelayMs: 500 },
  );
}

/**
 * Get sector performance - simplified implementation focusing on market data API
 */
export async function getSectorPerformance(
  _period = "1d",
  signal?: AbortSignal,
): Promise<SectorPerformance[]> {
  // Major ASX sectors with representative stocks
  const sectors = [
    { name: "Financials", stocks: ["CBA", "WBC", "ANZ", "NAB"] },
    { name: "Materials", stocks: ["BHP", "RIO", "FMG", "NCM"] },
    { name: "Healthcare", stocks: ["CSL", "COH", "SHL", "RMD"] },
    { name: "Consumer Staples", stocks: ["WOW", "COL", "WES", "TWE"] },
    { name: "Energy", stocks: ["WDS", "STO", "ORG", "OSH"] },
    { name: "Technology", stocks: ["XRO", "WTC", "CPU", "APT"] },
  ];

  // The proxy already accepts multiple symbols. Fetch all six sectors together
  // instead of making six separate requests on every widget refresh.
  const quotes = await getMultipleStockQuotes(
    sectors.flatMap((sector) => sector.stocks),
    signal,
  );

  return sectors.map((sector) => {
    let totalPerformance = 0;
    let totalVolume = 0;
    const performances: { symbol: string; change: number }[] = [];

    for (const symbol of sector.stocks) {
      const quote = quotes.get(symbol);
      if (!quote) continue;
      totalPerformance += quote.changePercent;
      totalVolume += quote.volume ?? 0;
      performances.push({ symbol, change: quote.changePercent });
    }

    performances.sort((a, b) => b.change - a.change);

    return {
      sector: sector.name,
      performance: totalPerformance / sector.stocks.length,
      volume: totalVolume,
      topGainers: performances.slice(0, 2).map((p) => p.symbol),
      topLosers: performances.slice(-2).map((p) => p.symbol),
    };
  });
}

/**
 * Get single stock quote
 */
export async function getStockPrice(
  stockCode: string,
  signal?: AbortSignal,
): Promise<StockQuote | null> {
  try {
    const quotes = await getMultipleStockQuotes([stockCode], signal);
    return quotes.get(stockCode.toUpperCase()) ?? null;
  } catch (error) {
    if ((signal?.aborted ?? false) || isAbortError(error)) throw error;
    console.error(`Error fetching stock price for ${stockCode}:`, error);
    return null;
  }
}

/**
 * Service status for debugging
 */
export async function getServiceStatus(): Promise<{ marketDataAPI: boolean }> {
  try {
    const response = await fetch("/api/health", {
      method: "GET",
      signal: AbortSignal.timeout(5000),
    });
    return { marketDataAPI: response.ok };
  } catch {
    return { marketDataAPI: false };
  }
}

/**
 * Search stocks using Connect RPC (backend uses Algolia with PostgreSQL fallback)
 */
export async function searchStocks(
  query: string,
  limit = 50,
): Promise<{
  stocks: Array<{
    productCode: string;
    name: string;
    percentageShorted: number;
    totalProductInIssue: number;
    reportedShortPositions: number;
    industry: string;
    tags: string[];
    logoUrl: string;
  }>;
} | null> {
  try {
    // Dynamic import to avoid circular dependencies and work in client context
    const { searchStocks: searchStocksRPC } = await import(
      "~/app/actions/searchStocks"
    );
    const response = await searchStocksRPC(query, limit);
    if (!response) return null;

    // Convert protobuf response to plain object format
    return {
      stocks: response.stocks.map((stock) => ({
        productCode: stock.productCode,
        name: stock.name,
        percentageShorted: stock.percentageShorted,
        totalProductInIssue: Number(stock.totalProductInIssue),
        reportedShortPositions: Number(stock.reportedShortPositions),
        industry: stock.industry,
        tags: stock.tags,
        logoUrl: stock.logoUrl,
      })),
    };
  } catch (error) {
    console.error(`Error searching stocks for query "${query}":`, error);
    return null;
  }
}

/**
 * Validates if a product code meets the backend API requirements
 * Product codes must be 3-4 alphanumeric characters
 */
function isValidProductCode(code: string): boolean {
  return /^[A-Za-z0-9]{3,4}$/.test(code);
}

export interface StockSearchFilters {
  industry: string | null;
  marketCap: string | null;
  tags: string[];
}

/**
 * Search stocks with enriched metadata (industry, logo, current price)
 * Uses Connect RPC SearchStocks which uses Algolia with PostgreSQL fallback
 */
export async function searchStocksEnriched(
  query: string,
  filters?: StockSearchFilters,
  limit = 10,
): Promise<StockSearchResult[]> {
  try {
    // Use Connect RPC SearchStocks (backend handles Algolia with PostgreSQL fallback)
    const searchResponse = await searchStocks(query, limit * 2);

    if (!searchResponse?.stocks || searchResponse.stocks.length === 0) {
      return [];
    }

    let results: StockSearchResult[] = searchResponse.stocks.map((stock) => ({
      product_code: stock.productCode,
      name: stock.name,
      percentage_shorted: stock.percentageShorted,
      total_product_in_issue: Number(stock.totalProductInIssue),
      reported_short_positions: Number(stock.reportedShortPositions),
      industry: stock.industry,
      tags: stock.tags,
      logoUrl: stock.logoUrl,
      companyName: stock.name,
    }));

    // Client-side filtering
    if (filters) {
      if (filters.industry) {
        results = results.filter(
          (s) => s.industry?.toLowerCase() === filters.industry?.toLowerCase(),
        );
      }

      if (filters.tags && filters.tags.length > 0) {
        results = results.filter((s) =>
          filters.tags?.some((tag) => s.tags?.includes(tag)),
        );
      }
    }

    // Limit results after filtering
    results = results.slice(0, limit);

    // Get valid product codes for batch price fetch
    const validCodes = results
      .filter((s) => isValidProductCode(s.product_code))
      .map((s) => s.product_code);

    // Batch fetch all prices in ONE request (instead of N individual requests)
    let pricesMap = new Map<string, StockQuote>();
    if (validCodes.length > 0) {
      const controller = new AbortController();
      let timeout: ReturnType<typeof setTimeout> | undefined;
      try {
        pricesMap = await Promise.race([
          getMultipleStockQuotes(validCodes, controller.signal).catch((error: unknown) => {
            if (controller.signal.aborted || isAbortError(error)) return new Map<string, StockQuote>();
            throw error;
          }),
          new Promise<Map<string, StockQuote>>((resolve) => {
            timeout = setTimeout(() => {
              controller.abort();
              resolve(new Map());
            }, 1500);
          }),
        ]);
      } finally {
        clearTimeout(timeout);
      }
    }

    // Fetch stock details with staggered requests to avoid overwhelming the API
    type FinancialData = {
      productCode: string;
      marketCap?: number;
      peRatio?: number;
      beta?: number;
    };

    // Filter to only valid product codes that will pass backend validation
    const validStocksForDetails = results
      .slice(0, Math.min(results.length, 10))
      .filter((stock) => isValidProductCode(stock.product_code));

    // Staggered fetch: request one at a time with small delay between each
    const fetchStockDetailsStaggered = async (
      stocks: typeof validStocksForDetails,
    ): Promise<FinancialData[]> => {
      const { fetchStockDetailsClient } = await import("@/lib/client-api");
      const results: FinancialData[] = [];

      for (let i = 0; i < stocks.length; i++) {
        const stock = stocks[i]!;
        try {
          const details = await fetchStockDetailsClient(stock.product_code);
          results.push({
            productCode: stock.product_code,
            marketCap: details?.financialStatements?.info?.marketCap,
            peRatio: details?.financialStatements?.info?.peRatio,
            beta: details?.financialStatements?.info?.beta,
          });
        } catch {
          results.push({ productCode: stock.product_code });
        }

        // Small delay between requests to avoid flooding (except for last one)
        if (i < stocks.length - 1) {
          await new Promise((resolve) => setTimeout(resolve, 50));
        }
      }

      return results;
    };

    // Wait for all details with timeout
    const detailsResults = await Promise.race<FinancialData[]>([
      fetchStockDetailsStaggered(validStocksForDetails),
      new Promise<FinancialData[]>((resolve) =>
        setTimeout(() => resolve([]), 3000),
      ),
    ]);

    // Create a map of product code to financial data
    const financialDataMap = new Map<string, FinancialData>(
      detailsResults.map((d) => [d.productCode, d]),
    );

    // Enrich results with prices and financial data
    const enrichedStocks = results.map((stock) => {
      const quote = pricesMap.get(stock.product_code.toUpperCase());
      const financial = financialDataMap.get(stock.product_code);
      return {
        ...stock,
        currentPrice: quote?.price,
        priceChange: quote?.changePercent,
        marketCap: financial?.marketCap,
        peRatio: financial?.peRatio,
        beta: financial?.beta,
      } as StockSearchResult;
    });

    return enrichedStocks;
  } catch (error) {
    console.error(
      `Error in enriched stock search for query "${query}":`,
      error,
    );
    return [];
  }
}
