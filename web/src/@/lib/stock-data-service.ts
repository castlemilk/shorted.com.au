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
  companyName?: string;
  logoUrl?: string;
  currentPrice?: number;
  priceChange?: number;
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
 * Search stocks using the Go backend API
 */
export async function searchStocks(
  query: string,
  limit = 50,
): Promise<StockSearchResponse | null> {
  try {
    // Use the Go backend API for stock search
    const SHORTS_API_URL =
      process.env.NEXT_PUBLIC_SHORTS_API_URL ?? "http://localhost:9091";

    const response = await fetch(
      `${SHORTS_API_URL}/api/stocks/search?q=${encodeURIComponent(query)}&limit=${limit}`,
      {
        method: "GET",
        headers: { "Content-Type": "application/json" },
        signal: AbortSignal.timeout(10000),
      },
    );

    if (!response.ok) {
      console.error(
        `Stock search failed: ${response.status} ${response.statusText}`,
      );
      return null;
    }

    const data: StockSearchResponse =
      (await response.json()) as StockSearchResponse;
    return data;
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

/**
 * Search stocks with enriched metadata (industry, logo, current price)
 * Fetches basic search results and enriches them with stock details in parallel
 */
export async function searchStocksEnriched(
  query: string,
  limit = 10,
): Promise<StockSearchResult[]> {
  try {
    // First, get basic search results
    const searchResponse = await searchStocks(query, limit);

    if (!searchResponse?.stocks || searchResponse.stocks.length === 0) {
      return [];
    }

    // Fetch stock details and current prices in parallel for enrichment
    const enrichedStocks = await Promise.all(
      searchResponse.stocks.map(async (stock) => {
        try {
          // Only fetch details for valid product codes (3-4 alphanumeric chars)
          // to avoid spamming the API with invalid requests
          const shouldEnrich = isValidProductCode(stock.product_code);

          if (!shouldEnrich) {
            // Return basic data without enrichment for invalid codes
            return stock;
          }

          // Fetch stock details (industry, logo, company name)
          const detailsPromise = fetchStockDetailsClient(stock.product_code);

          // Fetch current price
          const pricePromise = getStockPrice(stock.product_code);

          // Wait for both with timeout
          const [details, quote] = await Promise.race([
            Promise.all([detailsPromise, pricePromise]),
            new Promise<[undefined, null]>((resolve) =>
              setTimeout(() => resolve([undefined, null]), 3000),
            ),
          ]);

          // Return enriched stock result
          return {
            ...stock,
            industry: details?.industry,
            companyName: details?.companyName ?? stock.name,
            logoUrl: details?.gcsUrl,
            currentPrice: quote?.price,
            priceChange: quote?.changePercent,
          } as StockSearchResult;
        } catch (err) {
          // If enrichment fails for this stock, return basic data
          console.warn(`Failed to enrich stock ${stock.product_code}:`, err);
          return stock;
        }
      }),
    );

    return enrichedStocks;
  } catch (error) {
    console.error(
      `Error in enriched stock search for query "${query}":`,
      error,
    );
    return [];
  }
}

/**
 * Fetch stock details using Connect RPC client
 * Imports the client-api function dynamically to work in both client and server contexts
 */
async function fetchStockDetailsClient(
  productCode: string,
): Promise<
  { industry?: string; companyName?: string; gcsUrl?: string } | undefined
> {
  try {
    // Dynamic import to make this work in both client and server contexts
    const { fetchStockDetailsClient: fetchDetails } = await import(
      "@/lib/client-api"
    );
    const details = await fetchDetails(productCode);

    if (!details) {
      return undefined;
    }

    return {
      industry: details.industry,
      companyName: details.companyName,
      gcsUrl: details.gcsUrl,
    };
  } catch (error) {
    // Silently fail - enrichment is optional
    console.warn(`Failed to fetch details for ${productCode}:`, error);
    return undefined;
  }
}
