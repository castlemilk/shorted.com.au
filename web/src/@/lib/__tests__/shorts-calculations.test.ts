import {
  calculateMovers,
  formatPercentage,
  formatChange,
  type TimePeriod,
} from "../shorts-calculations";
import { type PlainMessage } from "@bufbuild/protobuf";
import { type TimeSeriesData } from "~/gen/stocks/v1alpha1/stocks_pb";

describe("shorts-calculations", () => {
  describe("formatPercentage", () => {
    it("should format numbers as percentages with 2 decimal places", () => {
      expect(formatPercentage(5.123)).toBe("5.12%");
      expect(formatPercentage(10.5)).toBe("10.50%");
      expect(formatPercentage(0)).toBe("0.00%");
    });
  });

  describe("formatChange", () => {
    it("should format positive changes with + sign", () => {
      expect(formatChange(5.5)).toBe("+5.50%");
      expect(formatChange(0.12)).toBe("+0.12%");
    });

    it("should format negative changes with - sign", () => {
      expect(formatChange(-5.5)).toBe("-5.50%");
      expect(formatChange(-0.12)).toBe("-0.12%");
    });

    it("should format zero with + sign", () => {
      expect(formatChange(0)).toBe("+0.00%");
    });
  });

  describe("calculateMovers", () => {
    const createMockStock = (
      productCode: string,
      name: string,
      latestPosition: number,
      points: Array<{ shortPosition: number; timestamp: { seconds: bigint; nanos: number } }>,
    ): PlainMessage<TimeSeriesData> => ({
      productCode,
      name,
      latestShortPosition: latestPosition,
      points,
      totalProductInIssue: 1000000,
      reportedShortPositions: 50000,
      percentageShorted: latestPosition,
    });

    it("should calculate biggest gainers correctly for 3m period", () => {
      const now = Date.now();
      const oneMonthAgo = now - 90 * 24 * 60 * 60 * 1000;

      // Create points showing an increase from 5% to 10%
      const points = Array.from({ length: 50 }, (_, i) => ({
        shortPosition: 5 + (i * 5) / 50, // Gradual increase
        timestamp: {
          seconds: BigInt(Math.floor((oneMonthAgo + (i * (now - oneMonthAgo)) / 50) / 1000)),
          nanos: 0,
        },
      }));

      const data = [
        createMockStock("CBA", "Commonwealth Bank", 10, points),
        createMockStock("BHP", "BHP Group", 5, [
          { shortPosition: 5, timestamp: { seconds: BigInt(Math.floor(oneMonthAgo / 1000)), nanos: 0 } },
          { shortPosition: 5, timestamp: { seconds: BigInt(Math.floor(now / 1000)), nanos: 0 } },
        ]),
      ];

      const result = calculateMovers(data, "3m");

      expect(result.biggestGainers).toHaveLength(2);
      expect(result.biggestGainers[0]?.productCode).toBe("CBA");
      expect(result.biggestGainers[0]?.change).toBeGreaterThan(0);
    });

    it("should calculate biggest losers correctly", () => {
      const now = Date.now();
      const oneMonthAgo = now - 90 * 24 * 60 * 60 * 1000;

      // Create points showing a decrease from 10% to 5%
      const points = Array.from({ length: 50 }, (_, i) => ({
        shortPosition: 10 - (i * 5) / 50, // Gradual decrease
        timestamp: {
          seconds: BigInt(Math.floor((oneMonthAgo + (i * (now - oneMonthAgo)) / 50) / 1000)),
          nanos: 0,
        },
      }));

      const data = [
        createMockStock("WOW", "Woolworths", 5, points),
      ];

      const result = calculateMovers(data, "3m");

      expect(result.biggestLosers).toHaveLength(1);
      expect(result.biggestLosers[0]?.productCode).toBe("WOW");
      expect(result.biggestLosers[0]?.change).toBeLessThan(0);
    });

    it("should calculate most volatile stocks correctly", () => {
      const now = Date.now();

      // Create volatile stock with high range
      const volatilePoints = [
        { shortPosition: 5, timestamp: { seconds: BigInt(Math.floor(now / 1000)), nanos: 0 } },
        { shortPosition: 15, timestamp: { seconds: BigInt(Math.floor(now / 1000)), nanos: 0 } },
        { shortPosition: 8, timestamp: { seconds: BigInt(Math.floor(now / 1000)), nanos: 0 } },
      ];

      // Create stable stock with low range
      const stablePoints = [
        { shortPosition: 5, timestamp: { seconds: BigInt(Math.floor(now / 1000)), nanos: 0 } },
        { shortPosition: 6, timestamp: { seconds: BigInt(Math.floor(now / 1000)), nanos: 0 } },
        { shortPosition: 5.5, timestamp: { seconds: BigInt(Math.floor(now / 1000)), nanos: 0 } },
      ];

      const data = [
        createMockStock("VOL", "Volatile Stock", 10, volatilePoints),
        createMockStock("STB", "Stable Stock", 5.5, stablePoints),
      ];

      const result = calculateMovers(data, "3m");

      expect(result.mostVolatile).toHaveLength(2);
      expect(result.mostVolatile[0]?.productCode).toBe("VOL");
      expect(result.mostVolatile[0]?.volatility).toBe(10); // 15 - 5
    });

    it("should handle stocks with no points", () => {
      const data = [
        createMockStock("EMPTY", "Empty Stock", 5, []),
      ];

      const result = calculateMovers(data, "3m");

      expect(result.biggestGainers[0]?.change).toBe(0);
      expect(result.biggestLosers[0]?.change).toBe(0);
      expect(result.mostVolatile[0]?.volatility).toBe(0);
    });

    it("should limit results to top 10 for each category", () => {
      const now = Date.now();
      const oneMonthAgo = now - 90 * 24 * 60 * 60 * 1000;

      // Create 15 stocks with varying changes
      const data = Array.from({ length: 15 }, (_, i) => {
        const points = [
          { shortPosition: 5, timestamp: { seconds: BigInt(Math.floor(oneMonthAgo / 1000)), nanos: 0 } },
          { shortPosition: 5 + i, timestamp: { seconds: BigInt(Math.floor(now / 1000)), nanos: 0 } },
        ];
        return createMockStock(`STOCK${i}`, `Stock ${i}`, 5 + i, points);
      });

      const result = calculateMovers(data, "3m");

      expect(result.biggestGainers).toHaveLength(10);
      expect(result.biggestLosers).toHaveLength(10);
      expect(result.mostVolatile).toHaveLength(10);
    });

    it("should work with different time periods", () => {
      const now = Date.now();
      const periods: TimePeriod[] = ["1m", "3m", "6m", "1y"];

      periods.forEach((period) => {
        const points = [
          { shortPosition: 5, timestamp: { seconds: BigInt(Math.floor(now / 1000)), nanos: 0 } },
          { shortPosition: 10, timestamp: { seconds: BigInt(Math.floor(now / 1000)), nanos: 0 } },
        ];

        const data = [createMockStock("TEST", "Test Stock", 10, points)];
        const result = calculateMovers(data, period);

        expect(result.biggestGainers).toHaveLength(1);
        expect(result.biggestLosers).toHaveLength(1);
        expect(result.mostVolatile).toHaveLength(1);
      });
    });
  });
});

