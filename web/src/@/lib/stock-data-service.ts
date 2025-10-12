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

// Market Data API configuration - call backend directly
const MARKET_DATA_API_URL =
  process.env.NEXT_PUBLIC_MARKET_DATA_API_URL || "http://localhost:8090";

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
      throw new Error("Market data service not available");
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

    throw new Error("Market data API returned invalid response");
  } catch (error) {
    console.error("Connect RPC market data API failed:", error);
    throw new Error("Unable to fetch stock quotes");
  }
}

/**
 * Get historical data from market data API (Connect RPC)
 */
export async function getHistoricalData(
  stockCode: string,
  period = "1m",
): Promise<HistoricalDataPoint[]> {
  try {
    if (!(await isMarketDataServiceAvailable())) {
      throw new Error("Market data service not available");
    }

    const response = await fetch(
      `${MARKET_DATA_API_URL}/marketdata.v1.MarketDataService/GetHistoricalPrices`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          stockCode: stockCode.toUpperCase(),
          period: period.toLowerCase(),
        }),
      },
    );

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
          (price) => ({
            date: price.date.split("T")[0], // Convert ISO timestamp to date string
            open: price.open,
            high: price.high,
            low: price.low,
            close: price.close,
            volume: parseInt(price.volume, 10),
            adjustedClose: price.adjustedClose,
          }),
        );

        console.log(
          `✅ Using Connect RPC market data API for ${stockCode} historical data`,
        );
        return historicalData;
      }

      // Return empty array if no data available for this stock
      console.log(`⚠️ No historical data available for ${stockCode}`);
      return [];
    }

    throw new Error("Market data API returned invalid response");
  } catch (error) {
    console.error(
      "Connect RPC market data API failed for historical data:",
      error,
    );
    throw new Error(`Unable to fetch historical data for ${stockCode}`);
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
