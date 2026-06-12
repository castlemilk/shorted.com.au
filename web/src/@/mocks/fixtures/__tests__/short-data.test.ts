import {
  topShortsFixture,
  topShortsResponseFixture,
  stockQuotesFixture,
  historicalDataFixture,
} from "../short-data";

describe("short-data fixtures", () => {
  it("provides 10 top-short series with descending short positions", () => {
    const series = topShortsFixture();
    expect(series).toHaveLength(10);
    expect(series[0]!.productCode).toBe("PLS");
    const positions = series.map((s) => s.latestShortPosition);
    expect([...positions].sort((a, b) => b - a)).toEqual(positions);
  });

  it("each series has 90 daily points with deterministic timestamps", () => {
    const series = topShortsFixture();
    for (const s of series) {
      expect(s.points).toHaveLength(90);
    }
    expect(topShortsFixture()).toEqual(series);
  });

  it("wraps series in a GetTopShortsResponse", () => {
    const resp = topShortsResponseFixture();
    expect(resp.timeSeries).toHaveLength(10);
  });

  it("provides quotes and historical prices for fixture codes", () => {
    const quotes = stockQuotesFixture(["PLS", "BHP"]);
    expect(quotes.get("PLS")?.price).toBeGreaterThan(0);
    const hist = historicalDataFixture("PLS", "3m");
    expect(hist.length).toBeGreaterThan(50);
  });
});
