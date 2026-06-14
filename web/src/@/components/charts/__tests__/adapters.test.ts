import { shortSeriesToPoints, historicalToPoints, mergeByDay } from "../adapters";
import {
  timeSeriesDataFixture,
  historicalDataFixture,
} from "~/@/mocks/fixtures/short-data";

describe("adapters", () => {
  it("converts TimeSeriesData points to ascending {t,v} short positions", () => {
    const pts = shortSeriesToPoints(timeSeriesDataFixture("PLS", "3m"));
    expect(pts.length).toBeGreaterThan(50);
    for (let i = 1; i < pts.length; i++)
      expect(pts[i]!.t).toBeGreaterThanOrEqual(pts[i - 1]!.t);
    expect(pts.every((p) => Number.isFinite(p.t) && Number.isFinite(p.v))).toBe(
      true,
    );
  });
  it("converts HistoricalDataPoint[] to {t,v} close prices and volume", () => {
    const { price, volume } = historicalToPoints(
      historicalDataFixture("PLS", "3m"),
    );
    expect(price.length).toBe(volume.length);
    expect(price[0]!.v).toBeGreaterThan(0);
  });
  it("merges two series by calendar day for correlation/overlay", () => {
    const short = shortSeriesToPoints(timeSeriesDataFixture("PLS", "3m"));
    const { price } = historicalToPoints(historicalDataFixture("PLS", "3m"));
    const merged = mergeByDay(price, short);
    expect(merged.length).toBeGreaterThan(0);
    expect(merged[0]).toHaveProperty("a"); // price
    expect(merged[0]).toHaveProperty("b"); // short
  });
});
