"use client";

// Stock data service using market data API

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

// Market Data API configuration - call backend directly
const MARKET_DATA_API_URL =
  process.env.NEXT_PUBLIC_MARKET_DATA_API_URL ?? "http://localhost:8090";

/**
 * Check if market data service is available
 */
async function isMarketDataServiceAvailable(): Promise<boolean> {
  try {
    const response = await fetch(`${MARKET_DATA_API_URL}/health`, {
      method: "GET",
      headers: { "Content-Type": "application/json" },
      signal: AbortSignal.timeout(5000),
    });
    return response.ok;
  } catch (error) {
    console.warn("Market data service not available");
    return false;
  }
}

/**
 * Get multiple stock quotes from market data API (Connect RPC)
 */
export async function getMultipleStockQuotes(
  stockCodes: string[],
): Promise<Map<string, StockQuote>> {
  const quotes = new Map<string, StockQuote>();

  if (stockCodes.length === 0) return quotes;

  try {
    if (!(await isMarketDataServiceAvailable())) {
      console.warn(
        `Market data service unavailable for quotes, returning empty data`,
      );
      return quotes;
    }

    const response = await fetch(
      `${MARKET_DATA_API_URL}/marketdata.v1.MarketDataService/GetMultipleStockPrices`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          stockCodes: stockCodes.map((code) => code.toUpperCase()),
        }),
      },
    );

    if (response.ok) {
      const apiResponse = (await response.json()) as {
        prices: Record<
          string,
          {
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
          }
        >;
      };

      if (apiResponse.prices) {
        Object.entries(apiResponse.prices).forEach(([symbol, price]) => {
          quotes.set(symbol, {
            symbol: price.stockCode,
            price: price.close,
            change: price.change,
            changePercent: price.changePercent,
            previousClose: price.close - price.change,
            volume: parseInt(price.volume, 10),
            high: price.high,
            low: price.low,
            open: price.open,
          });
        });

        console.log(
          `✅ Using Connect RPC market data API for ${stockCodes.length} stock quotes`,
        );
        return quotes;
      }
    }

    // Non-200 response - return empty map gracefully
    console.warn(
      `Market data API returned ${response.status} for quotes, returning empty data`,
    );
    return quotes;
  } catch (error) {
    console.warn(
      "Failed to fetch stock quotes:",
      error instanceof Error ? error.message : String(error),
    );
    return quotes;
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
    if (!(await isMarketDataServiceAvailable())) {
      console.warn(
        `Market data service unavailable for ${stockCode}, returning empty data`,
      );
      return [];
    }

    // Use the Next.js API route which properly handles Connect RPC
    const response = await fetch("/api/market-data/historical", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        stockCode: stockCode.toUpperCase(),
        period: period.toLowerCase(),
      }),
    });

    if (response.ok) {
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

      if (apiResponse.prices && apiResponse.prices.length > 0) {
        const historicalData: HistoricalDataPoint[] = apiResponse.prices.map(
          (price) => {
            const dateStr =
              price.date?.split("T")[0] ??
              new Date().toISOString().split("T")[0]!;
            return {
              date: dateStr,
              open: price.open,
              high: price.high,
              low: price.low,
              close: price.close,
              volume: parseInt(price.volume, 10),
              adjustedClose: price.adjustedClose,
            };
          },
        );

        console.log(
          `✅ Fetched ${historicalData.length} price points for ${stockCode} (${period})`,
        );
        return historicalData;
      }

      // Return empty array if no data available for this stock
      console.warn(`⚠️ No historical data available for ${stockCode}`);
      return [];
    }

    // Non-200 response - return empty data gracefully
    console.warn(
      `Market data API returned ${response.status} for ${stockCode}, returning empty data`,
    );
    return [];
  } catch (error) {
    console.warn(
      `Failed to fetch historical data for ${stockCode}:`,
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
  try {
    if (!(await isMarketDataServiceAvailable())) {
      throw new Error("Market data service not available");
    }

    const response = await fetch(
      `${MARKET_DATA_API_URL}/marketdata.v1.MarketDataService/GetStockCorrelations`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          stockCodes: stockCodes.map((code) => code.toUpperCase()),
          period: period.toLowerCase(),
        }),
      },
    );

    if (response.ok) {
      const data = (await response.json()) as {
        correlations: Record<string, { correlations?: Record<string, number> }>;
      };
      const matrix: CorrelationMatrix = {};

      Object.entries(data.correlations ?? {}).forEach(
        ([stock1, correlationRow]) => {
          if (correlationRow?.correlations) {
            matrix[stock1] = correlationRow.correlations;
          }
        },
      );

      console.log("✅ Using market data API for correlation matrix");
      return matrix;
    }

    throw new Error("Market data API returned invalid response");
  } catch (error) {
    console.error("Market data API failed for correlation matrix:", error);
    throw new Error("Unable to fetch correlation matrix");
  }
}

/**
 * Get sector performance - simplified implementation focusing on market data API
 */
export async function getSectorPerformance(
  _period = "1d",
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

  const sectorPerformance: SectorPerformance[] = [];

  try {
    await Promise.all(
      sectors.map(async (sector) => {
        try {
          const quotes = await getMultipleStockQuotes(sector.stocks);

          let totalPerformance = 0;
          let totalVolume = 0;
          const performances: { symbol: string; change: number }[] = [];

          quotes.forEach((quote, symbol) => {
            totalPerformance += quote.changePercent;
            totalVolume += quote.volume ?? 0;
            performances.push({ symbol, change: quote.changePercent });
          });

          performances.sort((a, b) => b.change - a.change);

          sectorPerformance.push({
            sector: sector.name,
            performance: totalPerformance / sector.stocks.length,
            volume: totalVolume,
            topGainers: performances.slice(0, 2).map((p) => p.symbol),
            topLosers: performances.slice(-2).map((p) => p.symbol),
          });
        } catch (error) {
          console.error(
            `Error fetching data for ${sector.name} sector:`,
            error,
          );
          // Add empty sector data to maintain consistency
          sectorPerformance.push({
            sector: sector.name,
            performance: 0,
            volume: 0,
            topGainers: [],
            topLosers: [],
          });
        }
      }),
    );
  } catch (error) {
    console.error("Error fetching sector performance:", error);
    throw new Error("Unable to fetch sector performance");
  }

  return sectorPerformance;
}

/**
 * Get single stock quote
 */
export async function getStockPrice(
  stockCode: string,
): Promise<StockQuote | null> {
  try {
    const quotes = await getMultipleStockQuotes([stockCode]);
    return quotes.get(stockCode.toUpperCase()) ?? null;
  } catch (error) {
    console.error(`Error fetching stock price for ${stockCode}:`, error);
    return null;
  }
}

/**
 * Service status for debugging
 */
export async function getServiceStatus(): Promise<{ marketDataAPI: boolean }> {
  const marketDataAPI = await isMarketDataServiceAvailable();
  return { marketDataAPI };
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
    const pricesMap =
      validCodes.length > 0
        ? await Promise.race([
            getMultipleStockQuotes(validCodes),
            new Promise<Map<string, StockQuote>>((resolve) =>
              setTimeout(() => resolve(new Map()), 1500),
            ),
          ])
        : new Map<string, StockQuote>();

    // Fetch stock details in parallel to get financial data (market cap, P/E, etc.)
    type FinancialData = {
      productCode: string;
      marketCap?: number;
      peRatio?: number;
      beta?: number;
    };

    const detailsPromises = results.slice(0, Math.min(results.length, 10)).map(async (stock): Promise<FinancialData> => {
      try {
        const { fetchStockDetailsClient } = await import("@/lib/client-api");
        const details = await fetchStockDetailsClient(stock.product_code);
        return {
          productCode: stock.product_code,
          marketCap: details?.financialStatements?.info?.marketCap,
          peRatio: details?.financialStatements?.info?.peRatio,
          beta: details?.financialStatements?.info?.beta,
        };
      } catch {
        return { productCode: stock.product_code };
      }
    });

    // Wait for all details with timeout
    const detailsResults = await Promise.race<FinancialData[]>([
      Promise.all(detailsPromises),
      new Promise<FinancialData[]>((resolve) =>
        setTimeout(() => resolve([]), 2000),
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
