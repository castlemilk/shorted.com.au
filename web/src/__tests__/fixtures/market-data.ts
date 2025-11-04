/**
 * Mock data fixtures for market data API tests
 */

export const mockHistoricalPrices = {
  CBA: {
    sixMonths: {
      prices: [
        {
          stockCode: "CBA",
          date: "2025-02-04T00:00:00Z",
          open: 135.5,
          high: 137.2,
          low: 134.8,
          close: 136.9,
          volume: "5234567",
          adjustedClose: 136.9,
          change: 1.4,
          changePercent: 1.03,
        },
        {
          stockCode: "CBA",
          date: "2025-03-04T00:00:00Z",
          open: 136.9,
          high: 139.1,
          low: 136.2,
          close: 138.5,
          volume: "4987654",
          adjustedClose: 138.5,
          change: 1.6,
          changePercent: 1.17,
        },
        {
          stockCode: "CBA",
          date: "2025-04-04T00:00:00Z",
          open: 138.5,
          high: 141.0,
          low: 137.9,
          close: 140.2,
          volume: "5876543",
          adjustedClose: 140.2,
          change: 1.7,
          changePercent: 1.23,
        },
        {
          stockCode: "CBA",
          date: "2025-05-04T00:00:00Z",
          open: 140.2,
          high: 142.5,
          low: 139.8,
          close: 141.8,
          volume: "6123456",
          adjustedClose: 141.8,
          change: 1.6,
          changePercent: 1.14,
        },
        {
          stockCode: "CBA",
          date: "2025-06-04T00:00:00Z",
          open: 141.8,
          high: 143.2,
          low: 140.5,
          close: 142.3,
          volume: "5543210",
          adjustedClose: 142.3,
          change: 0.5,
          changePercent: 0.35,
        },
        {
          stockCode: "CBA",
          date: "2025-07-04T00:00:00Z",
          open: 142.3,
          high: 144.0,
          low: 141.2,
          close: 143.5,
          volume: "5789012",
          adjustedClose: 143.5,
          change: 1.2,
          changePercent: 0.84,
        },
      ],
    },
    oneMonth: {
      prices: [
        {
          stockCode: "CBA",
          date: "2025-07-04T00:00:00Z",
          open: 142.3,
          high: 144.0,
          low: 141.2,
          close: 143.5,
          volume: "5789012",
          adjustedClose: 143.5,
          change: 1.2,
          changePercent: 0.84,
        },
      ],
    },
  },
  BHP: {
    sixMonths: {
      prices: [
        {
          stockCode: "BHP",
          date: "2025-02-04T00:00:00Z",
          open: 43.5,
          high: 44.2,
          low: 43.1,
          close: 43.9,
          volume: "8234567",
          adjustedClose: 43.9,
          change: 0.4,
          changePercent: 0.92,
        },
        {
          stockCode: "BHP",
          date: "2025-03-04T00:00:00Z",
          open: 43.9,
          high: 45.1,
          low: 43.5,
          close: 44.7,
          volume: "7987654",
          adjustedClose: 44.7,
          change: 0.8,
          changePercent: 1.82,
        },
        {
          stockCode: "BHP",
          date: "2025-04-04T00:00:00Z",
          open: 44.7,
          high: 46.0,
          low: 44.2,
          close: 45.5,
          volume: "8876543",
          adjustedClose: 45.5,
          change: 0.8,
          changePercent: 1.79,
        },
      ],
    },
  },
};

export const mockEmptyResponse = {
  prices: [],
};

export const mockErrorResponse = {
  error: "Failed to fetch historical data",
};

export const mockMalformedResponse = {
  data: null,
  status: "error",
};

/**
 * Generate mock historical prices for testing
 */
export function generateMockPrices(
  stockCode: string,
  days: number,
  startPrice: number = 100,
): Array<{
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
}> {
  const prices = [];
  const now = new Date();

  for (let i = days - 1; i >= 0; i--) {
    const date = new Date(now);
    date.setDate(date.getDate() - i);

    const open = startPrice + (Math.random() - 0.5) * 10;
    const close = open + (Math.random() - 0.5) * 5;
    const high = Math.max(open, close) + Math.random() * 2;
    const low = Math.min(open, close) - Math.random() * 2;
    const change = close - open;
    const changePercent = (change / open) * 100;

    prices.push({
      stockCode,
      date: date.toISOString(),
      open: Number(open.toFixed(2)),
      high: Number(high.toFixed(2)),
      low: Number(low.toFixed(2)),
      close: Number(close.toFixed(2)),
      volume: String(Math.floor(Math.random() * 10000000) + 1000000),
      adjustedClose: Number(close.toFixed(2)),
      change: Number(change.toFixed(2)),
      changePercent: Number(changePercent.toFixed(2)),
    });
  }

  return prices;
}
