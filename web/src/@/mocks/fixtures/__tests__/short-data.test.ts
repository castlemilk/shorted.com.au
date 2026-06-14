import {
  topShortsFixture,
  topShortsResponseFixture,
  stockQuotesFixture,
  historicalDataFixture,
  industryTreemapFixture,
  tooltipDataFixture,
  stockFixture,
  searchStocksResponseFixture,
  timeSeriesDataFixture,
  correlationMatrixFixture,
  sectorPerformanceFixture,
  marketNewsResponseFixture,
  screenerResponseFixture,
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

  it("timeSeriesDataFixture has period-scaled points with a pinned terminal", () => {
    // Period scaling matches PERIOD_DAYS (same table historicalDataFixture uses).
    expect(timeSeriesDataFixture("PLS", "3m").points).toHaveLength(65);
    expect(timeSeriesDataFixture("PLS", "1y").points).toHaveLength(252);
    // Unknown period falls back to 3m.
    expect(timeSeriesDataFixture("PLS", "10y").points).toHaveLength(65);

    const series = timeSeriesDataFixture("PLS", "3m");
    expect(series.productCode).toBe("PLS");
    expect(series.name).toBe("Pilbara Minerals Limited");
    expect(series.latestShortPosition).toBe(19.4);
    // Terminal point pinned to latestShortPosition at FIXTURE_BASE_DATE so
    // chart endpoints agree with legend badges ("19.40%").
    const last = series.points[series.points.length - 1]!;
    expect(last.shortPosition).toBe(19.4);
    // All values are positive percentage points (floored at 0.1).
    for (const p of series.points) {
      expect(p.shortPosition).toBeGreaterThanOrEqual(0.1);
    }
    // Deterministic: two calls produce identical messages.
    expect(timeSeriesDataFixture("PLS", "3m")).toEqual(series);
    // Unknown codes keep the requested code with generic fallback values.
    const unknown = timeSeriesDataFixture("ZZZ", "1m");
    expect(unknown.productCode).toBe("ZZZ");
    expect(unknown.latestShortPosition).toBe(5.0);
    expect(unknown.points).toHaveLength(22);
  });

  it("correlationMatrixFixture is symmetric with unit diagonal", () => {
    const codes = ["PLS", "SYR", "IEL", "BOE"];
    const matrix = correlationMatrixFixture(codes);
    expect(Object.keys(matrix)).toEqual(codes);
    for (const a of codes) {
      expect(Object.keys(matrix[a]!)).toEqual(codes);
      // Diagonal is exactly 1 (renders "1.00" in the widget).
      expect(matrix[a]![a]).toBe(1);
      for (const b of codes) {
        // Symmetric: seeded by the sorted pair.
        expect(matrix[a]![b]).toBe(matrix[b]![a]);
        // Documented range (-0.6, 0.9), 2 dp.
        expect(matrix[a]![b]).toBeGreaterThanOrEqual(-0.6);
        expect(matrix[a]![b]).toBeLessThanOrEqual(1);
      }
    }
    // Deterministic.
    expect(correlationMatrixFixture(codes)).toEqual(matrix);
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

describe("sectorPerformanceFixture", () => {
  it("returns 6 sectors with a deterministic mix of signs", () => {
    const sectors = sectorPerformanceFixture("1w");
    expect(sectors.map((s) => s.sector)).toEqual([
      "Financials",
      "Materials",
      "Healthcare",
      "Consumer Staples",
      "Energy",
      "Technology",
    ]);
    // Mix of signs so the pie shows both badge variants and the heatmap
    // shows both green and red tiles.
    expect(sectors.some((s) => s.performance > 0)).toBe(true);
    expect(sectors.some((s) => s.performance < 0)).toBe(true);
    for (const s of sectors) {
      expect(s.volume).toBeGreaterThan(0);
      expect(s.topGainers).toHaveLength(2);
      expect(s.topLosers).toHaveLength(2);
    }
    // Deterministic.
    expect(sectorPerformanceFixture("1w")).toEqual(sectors);
  });

  it("scales magnitudes by period and falls back to 1w for unknown periods", () => {
    const day = sectorPerformanceFixture("1d");
    const week = sectorPerformanceFixture("1w");
    const quarter = sectorPerformanceFixture("3m");
    for (let i = 0; i < week.length; i++) {
      expect(Math.abs(day[i]!.performance)).toBeLessThan(
        Math.abs(week[i]!.performance),
      );
      expect(Math.abs(quarter[i]!.performance)).toBeGreaterThan(
        Math.abs(week[i]!.performance),
      );
      // Sign is stable across periods.
      expect(Math.sign(day[i]!.performance)).toBe(Math.sign(week[i]!.performance));
    }
    expect(sectorPerformanceFixture("bogus")).toEqual(week);
  });
});

describe("marketNewsResponseFixture", () => {
  it("returns 10 deterministic articles with one MARKET-wide entry", () => {
    const res = marketNewsResponseFixture();
    expect(res.articles).toHaveLength(10);
    expect(res.totalCount).toBe(10);
    // First article: PLS from the asx source (exercises the isASXSource
    // highlight branch in the widget).
    expect(res.articles[0]!.stockCode).toBe("PLS");
    expect(res.articles[0]!.source).toBe("asx");
    expect(res.articles[0]!.isPriceSensitive).toBe(true);
    // Exactly one market-wide article, and it is the last one.
    const market = res.articles.filter((a) => a.stockCode === "MARKET");
    expect(market).toHaveLength(1);
    expect(res.articles[9]!.stockCode).toBe("MARKET");
    // Sentiments come from the known cycle.
    for (const a of res.articles) {
      expect(["positive", "negative", "neutral"]).toContain(a.sentiment);
      expect(a.url).toMatch(/^https:\/\/news\.example\.com\//);
      expect(a.publishedAt).toBeDefined();
    }
    // Deterministic.
    expect(marketNewsResponseFixture()).toEqual(res);
  });

  it("filters price-sensitive before applying limit", () => {
    const sensitive = marketNewsResponseFixture({ priceSensitiveOnly: true });
    // Indices 0, 3, 6, 9 are price-sensitive.
    expect(sensitive.articles).toHaveLength(4);
    expect(sensitive.totalCount).toBe(4);
    expect(sensitive.articles.every((a) => a.isPriceSensitive)).toBe(true);

    const limited = marketNewsResponseFixture({ limit: 3 });
    expect(limited.articles).toHaveLength(3);
    expect(limited.totalCount).toBe(10);
    expect(limited.articles.map((a) => a.stockCode)).toEqual([
      "PLS",
      "SYR",
      "IEL",
    ]);
  });
});

describe("screenerResponseFixture", () => {
  it("returns rows ordered by descending shortPct with seeded 4w change", () => {
    const res = screenerResponseFixture();
    expect(res.stocks).toHaveLength(10);
    expect(res.totalCount).toBe(10);
    expect(res.stocks[0]!.stockCode).toBe("PLS");
    expect(res.stocks[0]!.shortPct).toBe(19.4);
    const pcts = res.stocks.map((s) => s.shortPct);
    expect([...pcts].sort((a, b) => b - a)).toEqual(pcts);
    for (const s of res.stocks) {
      // Documented ±2.5 pp range, 2 dp.
      expect(Math.abs(s.shortPctChange4w)).toBeLessThanOrEqual(2.5);
      expect(s.companyName).not.toBe("");
      expect(s.latestPrice).toBeGreaterThan(0);
      expect(s.latestVolume).toBeGreaterThan(0n);
    }
    // Deterministic.
    expect(screenerResponseFixture()).toEqual(res);
  });

  it("honours limit while keeping the full-universe totalCount", () => {
    const res = screenerResponseFixture(5);
    expect(res.stocks.map((s) => s.stockCode)).toEqual([
      "PLS",
      "SYR",
      "IEL",
      "LTR",
      "FLT",
    ]);
    expect(res.totalCount).toBe(10);
  });
});
