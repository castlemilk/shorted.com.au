import { type TimeSeriesData } from "~/gen/stocks/v1alpha1/stocks_pb";

export type TimePeriod = "1m" | "3m" | "6m" | "1y";

type TimeSeriesDataWithChange = TimeSeriesData & { change: number };
type TimeSeriesDataWithVolatility = TimeSeriesData & { volatility: number };

export interface MoversData {
  biggestGainers: Array<TimeSeriesDataWithChange>;
  biggestLosers: Array<TimeSeriesDataWithChange>;
  mostVolatile: Array<TimeSeriesDataWithVolatility>;
}

/**
 * Calculate the timestamp in milliseconds from a protobuf timestamp
 */
function getTimestampMs(
  timestamp: { seconds?: bigint; nanos?: number } | null | undefined,
): number {
  if (!timestamp) return 0;
  return (
    Number(timestamp.seconds ?? 0) * 1000 +
    Number(timestamp.nanos ?? 0) / 1000000
  );
}

/**
 * Calculate period-specific change in short position
 */
function calculateChange(
  sortedPoints: Array<{
    shortPosition: number;
    timestamp?: { seconds?: bigint; nanos?: number } | null;
  }>,
  period: TimePeriod,
  latestShortPosition: number,
): number {
  let change = 0;

  if (period === "1m" && sortedPoints.length >= 20) {
    // For 1 month, compare last 20 points with first 20 points
    const recentPoints = sortedPoints.slice(-20);
    const olderPoints = sortedPoints.slice(0, 20);
    const recentAvg =
      recentPoints.reduce((sum, p) => sum + p.shortPosition, 0) /
      recentPoints.length;
    const olderAvg =
      olderPoints.reduce((sum, p) => sum + p.shortPosition, 0) /
      olderPoints.length;
    change = recentAvg - olderAvg;
  } else if (period === "3m" && sortedPoints.length >= 40) {
    // For 3 months, compare last 40 points with first 40 points
    const recentPoints = sortedPoints.slice(-40);
    const olderPoints = sortedPoints.slice(0, 40);
    const recentAvg =
      recentPoints.reduce((sum, p) => sum + p.shortPosition, 0) /
      recentPoints.length;
    const olderAvg =
      olderPoints.reduce((sum, p) => sum + p.shortPosition, 0) /
      olderPoints.length;
    change = recentAvg - olderAvg;
  } else if (period === "6m" && sortedPoints.length >= 60) {
    // For 6 months, compare last 60 points with first 60 points
    const recentPoints = sortedPoints.slice(-60);
    const olderPoints = sortedPoints.slice(0, 60);
    const recentAvg =
      recentPoints.reduce((sum, p) => sum + p.shortPosition, 0) /
      recentPoints.length;
    const olderAvg =
      olderPoints.reduce((sum, p) => sum + p.shortPosition, 0) /
      olderPoints.length;
    change = recentAvg - olderAvg;
  } else if (period === "1y") {
    // For 1 year, compare last 10 points with first 10 points
    const recentPoints = sortedPoints.slice(-10);
    const olderPoints = sortedPoints.slice(0, 10);
    const recentAvg =
      recentPoints.reduce((sum, p) => sum + p.shortPosition, 0) /
      recentPoints.length;
    const olderAvg =
      olderPoints.reduce((sum, p) => sum + p.shortPosition, 0) /
      olderPoints.length;
    change = recentAvg - olderAvg;
  } else {
    // Fallback: compare first and last points
    const firstPosition = sortedPoints[0]?.shortPosition ?? 0;
    change = latestShortPosition - firstPosition;
  }

  return change;
}

/**
 * Calculate the biggest movers in short positions for a given period
 */
export function calculateMovers(
  data: TimeSeriesData[],
  period: TimePeriod,
): MoversData {
  // Calculate biggest gainers (stocks with largest increase in short position)
  const gainers = [...data]
    .map((stock) => {
      if (!stock.points || stock.points.length === 0) {
        return { ...stock, change: 0 };
      }

      // Sort points by timestamp to get chronological order
      const sortedPoints = [...stock.points].sort((a, b) => {
        const timeA = getTimestampMs(a.timestamp);
        const timeB = getTimestampMs(b.timestamp);
        return timeA - timeB;
      });

      const change = calculateChange(
        sortedPoints,
        period,
        stock.latestShortPosition ?? 0,
      );
      return { ...stock, change };
    })
    .sort((a, b) => b.change - a.change)
    .slice(0, 10);

  // Calculate biggest losers (stocks with largest decrease in short position)
  const losers = [...data]
    .map((stock) => {
      if (!stock.points || stock.points.length === 0) {
        return { ...stock, change: 0 };
      }

      // Sort points by timestamp to get chronological order
      const sortedPoints = [...stock.points].sort((a, b) => {
        const timeA = getTimestampMs(a.timestamp);
        const timeB = getTimestampMs(b.timestamp);
        return timeA - timeB;
      });

      const change = calculateChange(
        sortedPoints,
        period,
        stock.latestShortPosition ?? 0,
      );
      return { ...stock, change };
    })
    .sort((a, b) => a.change - b.change)
    .slice(0, 10);

  // Calculate most volatile (stocks with largest range between min and max in the period)
  const volatile = [...data]
    .map((stock) => {
      if (!stock.points || stock.points.length === 0) {
        return { ...stock, volatility: 0 };
      }

      const positions = stock.points.map((point) => point.shortPosition);
      const minPosition = Math.min(...positions);
      const maxPosition = Math.max(...positions);
      const volatility = maxPosition - minPosition;

      return { ...stock, volatility };
    })
    .sort((a, b) => b.volatility - a.volatility)
    .slice(0, 10);

  return {
    biggestGainers: gainers,
    biggestLosers: losers,
    mostVolatile: volatile,
  };
}

/**
 * Format a number as a percentage string
 */
export function formatPercentage(value: number): string {
  return `${value.toFixed(2)}%`;
}

/**
 * Format a change value with sign
 */
export function formatChange(value: number): string {
  const sign = value >= 0 ? "+" : "";
  return `${sign}${value.toFixed(2)}%`;
}

/**
 * Period labels for display
 */
export const PERIOD_LABELS: Record<TimePeriod, string> = {
  "1m": "1 Month",
  "3m": "3 Months",
  "6m": "6 Months",
  "1y": "1 Year",
};
