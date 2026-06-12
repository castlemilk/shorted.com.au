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
    // Fix 4: exact length assertions (3m = 65, 1y = 252)
    const hist3m = historicalDataFixture("PLS", "3m");
    expect(hist3m).toHaveLength(65);
    const hist1y = historicalDataFixture("PLS", "1y");
    expect(hist1y).toHaveLength(252);
  });

  it("widget fields have correct semantics and scale", () => {
    const series = topShortsFixture();
    for (const s of series) {
      // Both are percentage points (backend serves pp in the proto):
      // 19.4 renders as "19.40%" in columns.tsx and "19.4%" in compact cards.
      expect(s.percentageShorted).toBeCloseTo(s.latestShortPosition, 2);
      expect(s.latestShortPosition).toBeGreaterThan(1); // pp scale, not a fraction
      // min/max points must be populated (backend always sets them; the
      // "Short" column renders them as range badges).
      expect(s.min).toBeDefined();
      expect(s.max).toBeDefined();
      expect(s.min!.shortPosition).toBeLessThanOrEqual(s.max!.shortPosition);
      // shortPercentageChange must be finite and within the documented ±2.5 pp range
      expect(Number.isFinite(s.shortPercentageChange)).toBe(true);
      expect(s.shortPercentageChange).toBeGreaterThanOrEqual(-2.5);
      expect(s.shortPercentageChange).toBeLessThanOrEqual(2.5);
      // industry must be a non-empty string
      expect(s.industry).toBeTruthy();
      expect(typeof s.industry).toBe("string");
    }
  });

  it("historicalDataFixture terminal point is pinned to basePrice", () => {
    // PLS has basePrice 2.85 — the last point should have close === 2.85
    const hist = historicalDataFixture("PLS", "3m");
    const last = hist[hist.length - 1]!;
    expect(last.close).toBe(2.85);
    expect(last.adjustedClose).toBe(2.85);
  });
});
