import {
  topShortsFixture,
  topShortsResponseFixture,
  stockQuotesFixture,
  historicalDataFixture,
  industryTreemapFixture,
  tooltipDataFixture,
  stockFixture,
  searchStocksResponseFixture,
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
      // PRNG yields the open interval (-2.5, 2.5); inclusive matchers are safe
      expect(Number.isFinite(s.shortPercentageChange)).toBe(true);
      expect(s.shortPercentageChange).toBeGreaterThanOrEqual(-2.5);
      expect(s.shortPercentageChange).toBeLessThanOrEqual(2.5);
      // industry must be a non-empty string
      expect(s.industry).toBeTruthy();
      expect(typeof s.industry).toBe("string");
    }
  });

  it("industry treemap fixture spans >=4 industries with positive short positions", () => {
    const treemap = industryTreemapFixture();
    // At least 4 distinct industries so sector grouping renders a real hierarchy.
    expect(new Set(treemap.industries).size).toBeGreaterThanOrEqual(4);
    expect(treemap.stocks.length).toBeGreaterThanOrEqual(10);
    for (const stock of treemap.stocks) {
      // Positive pp sizes — zero/negative would collapse treemap cells.
      expect(stock.shortPosition).toBeGreaterThan(0);
      expect(stock.productCode).toBeTruthy();
      // Every stock's industry must appear in the industries list, or
      // stratify() in the widget throws on a missing parent node.
      expect(treemap.industries).toContain(stock.industry);
    }
    // Deterministic: two calls produce identical messages.
    expect(industryTreemapFixture()).toEqual(treemap);
  });

  it("tooltip data fixture is deterministic and shaped for TreemapTooltip", () => {
    const data = tooltipDataFixture("PLS");
    expect(data.stockDetails?.companyName).toBe("Pilbara Minerals Limited");
    expect(data.stockDetails?.industry).toBe("Materials");
    expect(data.timeSeriesData?.points).toHaveLength(22);
    // Terminal point pinned to the declared latest short position.
    const last = data.timeSeriesData!.points[21]!;
    expect(last.shortPosition).toBe(19.4);
    expect(last.timestamp).toBe("2026-06-01T00:00:00.000Z");
    expect(tooltipDataFixture("PLS")).toEqual(data);
    // Unknown codes fall back to the PLS definition rather than crashing.
    expect(tooltipDataFixture("ZZZ").stockDetails?.productCode).toBe("PLS");
  });

  it("historicalDataFixture terminal point is pinned to basePrice", () => {
    // PLS has basePrice 2.85 — the last point should have close === 2.85
    const hist = historicalDataFixture("PLS", "3m");
    const last = hist[hist.length - 1]!;
    expect(last.close).toBe(2.85);
    expect(last.adjustedClose).toBe(2.85);
  });

  it("stockFixture is deterministic with internally consistent short fields", () => {
    const stock = stockFixture("PLS");
    expect(stock.productCode).toBe("PLS");
    expect(stock.name).toBe("Pilbara Minerals Limited");
    expect(stock.industry).toBe("Materials");
    // Percentage points, matching FIXTURE_STOCKS (renders "19.40%").
    expect(stock.percentageShorted).toBe(19.4);
    // reported = total × pct / 100 (floored) so the three fields agree.
    expect(stock.reportedShortPositions).toBe(
      Math.floor((stock.totalProductInIssue * 19.4) / 100),
    );
    expect(stock.totalProductInIssue).toBeGreaterThanOrEqual(200_000_000);
    // Deterministic: two calls produce identical messages.
    expect(stockFixture("PLS")).toEqual(stock);
    // Unknown codes keep the requested code with generic fallback values.
    const unknown = stockFixture("ZZZ");
    expect(unknown.productCode).toBe("ZZZ");
    expect(unknown.percentageShorted).toBe(5.0);
  });

  it("searchStocksResponseFixture matches by code or name substring", () => {
    // Code substring (case-insensitive): "syr" → SYR (also matches its own
    // name "Syrah..."); nothing else contains "syr".
    const byCode = searchStocksResponseFixture("syr");
    expect(byCode.stocks.map((s) => s.productCode)).toEqual(["SYR"]);
    expect(byCode.count).toBe(1);
    expect(byCode.query).toBe("syr");

    // Name substring: "mineral" → Pilbara Minerals + Mineral Resources,
    // in fixture order (descending short position).
    const byName = searchStocksResponseFixture("mineral");
    expect(byName.stocks.map((s) => s.productCode)).toEqual(["PLS", "MIN"]);

    // No match / blank query → empty results.
    expect(searchStocksResponseFixture("XQZ").stocks).toHaveLength(0);
    expect(searchStocksResponseFixture("  ").stocks).toHaveLength(0);

    // Deterministic.
    expect(searchStocksResponseFixture("syr")).toEqual(byCode);
  });
});
