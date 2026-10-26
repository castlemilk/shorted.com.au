import { readFileSync } from "fs";
import { join } from "path";
import {
  MAX_ECONOMIC_SERIES,
  MAX_TABLE_ROWS,
  parseDirectorTrades,
  parseEconomicSeries,
  parsePeers,
  parseShortPositions,
  parseTopShorts,
} from "../chat-tool-data";

/** The exact result strings the chat service returned, recorded on 2026-10-24. */
function fixture(name: string): string {
  return readFileSync(
    join(__dirname, "..", "__fixtures__", "tool-results", name),
    "utf8",
  );
}

describe("parseTopShorts (recorded)", () => {
  it("reads the ten most shorted rows with their sparklines", () => {
    const view = parseTopShorts(fixture("get_top_shorts-10.json"));

    expect(view).not.toBeNull();
    expect(view!.rows).toHaveLength(10);
    expect(view!.notShown).toBe(0);
    expect(view!.rows[0]).toMatchObject({ rank: 1, code: "DRO", name: "Droneshield" });
    expect(view!.rows[0]!.latest).toBeCloseTo(15.92826069, 6);
    expect(view!.rows[0]!.points).toHaveLength(8);
  });

  it("keeps readings in ascending time order", () => {
    const view = parseTopShorts(fixture("get_top_shorts-10.json"));
    const times = view!.rows[0]!.points.map((p) => p.t);
    expect([...times].sort((a, b) => a - b)).toEqual(times);
  });

  it("keeps rows whose sparkline the budget cleared, with no points", () => {
    const view = parseTopShorts(fixture("get_top_shorts-50.json"));

    expect(view!.rows).toHaveLength(50);
    expect(view!.rows[0]!.points).toHaveLength(8);
    // Rows 8 to 50 carry points: [] because the budget cleared them, not because the data is missing.
    expect(view!.rows[14]!.points).toEqual([]);
    expect(view!.rows[14]!.latest).toBeCloseTo(10.13002995, 6);
    expect(view!.rows[14]!.code).toBe("FLT");
  });

  it("counts the stocks the tool omitted", () => {
    const view = parseTopShorts(
      JSON.stringify({
        timeSeries: [{ productCode: "DRO", name: "Droneshield", latestShortPosition: 15.9, points: [] }],
        omittedStocks: 40,
      }),
    );
    expect(view!.rows).toHaveLength(1);
    expect(view!.notShown).toBe(40);
  });

  it("drops rows with no valid ASX code and keeps the rest", () => {
    const view = parseTopShorts(
      JSON.stringify({
        timeSeries: [
          { productCode: "<script>", latestShortPosition: 1 },
          { productCode: "javascript:alert(1)", latestShortPosition: 2 },
          { latestShortPosition: 3 },
          { productCode: "BHP", latestShortPosition: 4, points: [] },
        ],
      }),
    );
    expect(view!.rows.map((r) => r.code)).toEqual(["BHP"]);
    expect(view!.rows[0]!.rank).toBe(4);
  });

  it("drops readings that are not finite numbers", () => {
    const view = parseTopShorts(
      JSON.stringify({
        timeSeries: [
          {
            productCode: "ZIP",
            points: [
              { timestamp: "2026-10-01T00:00:00Z", shortPosition: "NaN" },
              { timestamp: "2026-10-02T00:00:00Z", shortPosition: 6.5 },
              { timestamp: "not a date", shortPosition: 7 },
              { timestamp: "2026-10-03T00:00:00Z", shortPosition: null },
            ],
          },
        ],
      }),
    );
    expect(view!.rows[0]!.points).toEqual([{ t: Date.parse("2026-10-02T00:00:00Z"), v: 6.5 }]);
  });

  it("returns null when timeSeries is not a list, or the result is an error", () => {
    expect(parseTopShorts(JSON.stringify({ timeSeries: "nope" }))).toBeNull();
    expect(parseTopShorts(JSON.stringify({ error: "upstream failed" }))).toBeNull();
    expect(parseTopShorts("Error: boom")).toBeNull();
    expect(parseTopShorts("not json")).toBeNull();
    expect(parseTopShorts("[]")).toBeNull();
  });
});

describe("parseShortPositions (recorded)", () => {
  it("reads a thinned year of BHP readings", () => {
    const view = parseShortPositions(
      fixture("query_short_positions-bhp-1y.json"),
      JSON.stringify({ stock_code: "BHP", period: "1y" }),
    );

    expect(view).not.toBeNull();
    expect(view).toMatchObject({ code: "BHP", totalObservations: 254, downsampled: true });
    expect(view!.points).toHaveLength(40);
  });

  it("reads a sparse GLC series with no downsampled key", () => {
    const view = parseShortPositions(
      fixture("query_short_positions-glc-3m.json"),
      JSON.stringify({ stock_code: "GLC", period: "3m" }),
    );

    expect(view).toMatchObject({ code: "GLC", totalObservations: 4, downsampled: false });
    expect(view!.points).toHaveLength(4);
    expect(view!.latest).toBeCloseTo(13.39138398, 6);
    expect(view!.points.at(-1)!.v).toBeCloseTo(13.39138398, 6);
  });

  it("reads the DRO six-month series", () => {
    const view = parseShortPositions(
      fixture("query_short_positions-dro-6m.json"),
      JSON.stringify({ stock_code: "DRO", period: "6m" }),
    );
    expect(view).toMatchObject({ code: "DRO", totalObservations: 130, downsampled: true });
    expect(view!.points).toHaveLength(40);
  });

  it("takes the code from the arguments when the result has none", () => {
    const view = parseShortPositions(
      JSON.stringify({
        points: [
          { timestamp: "2026-10-01T00:00:00Z", shortPosition: 1 },
          { timestamp: "2026-10-02T00:00:00Z", shortPosition: 2 },
        ],
      }),
      JSON.stringify({ stock_code: "pls" }),
    );
    expect(view!.code).toBe("PLS");
  });

  it("reads the wrapped timeSeries shape the chat has always accepted", () => {
    const view = parseShortPositions(
      JSON.stringify({
        timeSeries: [
          {
            productCode: "PLS",
            name: "Pilbara Minerals",
            latestShortPosition: 8.9,
            points: [
              { timestamp: "2026-06-01T00:00:00Z", shortPosition: 6.1 },
              { timestamp: "2026-07-01T00:00:00Z", shortPosition: 8.9 },
            ],
          },
        ],
      }),
      "{}",
    );
    expect(view).toMatchObject({ code: "PLS", name: "Pilbara Minerals", latest: 8.9 });
  });

  it("returns null with fewer than two readings, or no valid code", () => {
    const one = JSON.stringify({
      productCode: "BHP",
      points: [{ timestamp: "2026-06-01T00:00:00Z", shortPosition: 6.1 }],
    });
    expect(parseShortPositions(one, "{}")).toBeNull();
    expect(parseShortPositions(JSON.stringify({ points: [] }), "{}")).toBeNull();

    const noCode = JSON.stringify({
      points: [
        { timestamp: "2026-06-01T00:00:00Z", shortPosition: 6.1 },
        { timestamp: "2026-07-01T00:00:00Z", shortPosition: 6.2 },
      ],
    });
    expect(parseShortPositions(noCode, "not json")).toBeNull();
  });

  it("does not parse an error result", () => {
    expect(parseShortPositions(JSON.stringify({ error: "x" }), "{}")).toBeNull();
  });

  it("drops a protobuf timestamp outside the Date range instead of keeping it", () => {
    // Intl throws on a time a Date cannot hold, so the reading must not reach a formatter.
    const view = parseShortPositions(
      JSON.stringify({
        productCode: "BHP",
        points: [
          { timestamp: { seconds: 1e17 }, shortPosition: 1.2 },
          { timestamp: "2026-10-01T00:00:00Z", shortPosition: 1.5 },
          { timestamp: { seconds: 1767225600 }, shortPosition: 1.6 },
        ],
      }),
      "{}",
    );
    expect(view!.points.map((p) => p.t)).toEqual([
      Date.parse("2026-01-01T00:00:00Z"),
      Date.parse("2026-10-01T00:00:00Z"),
    ]);
  });

  it("returns null when every timestamp is outside the Date range", () => {
    expect(
      parseShortPositions(
        JSON.stringify({
          productCode: "BHP",
          points: [
            { timestamp: { seconds: 1e17 }, shortPosition: 1.2 },
            { timestamp: { seconds: -1e17 }, shortPosition: 1.5 },
          ],
        }),
        "{}",
      ),
    ).toBeNull();
  });
});

describe("parsePeers (recorded)", () => {
  it("reads the subject, the industry and five peers", () => {
    const view = parsePeers(fixture("get_peer_comparison-bhp.json"));

    expect(view).not.toBeNull();
    expect(view!.subjectCode).toBe("BHP");
    expect(view!.industry).toBe("Materials");
    expect(view!.rows).toHaveLength(5);
    expect(view!.rows[0]).toMatchObject({ code: "RIO", name: "Rio Tinto" });
    expect(view!.rows[0]!.shortPercent).toBeCloseTo(8.76039257, 6);
    expect(view!.rows[0]!.marketCap).toBe(285029957632);
  });

  it("reads the subject's own figures, kept apart from the peers", () => {
    const view = parsePeers(fixture("get_peer_comparison-bhp.json"));

    expect(view!.subject).toMatchObject({
      code: "BHP",
      shortPercent: 1.61154143,
      marketCap: 331023450112,
      peRatio: 24.044281,
      priceChange1m: -6.680823260372427,
    });
    expect(view!.rows.map((r) => r.code)).not.toContain("BHP");
  });

  it("lists a peer that repeats the subject's code only once, as the subject", () => {
    const view = parsePeers(
      JSON.stringify({
        subject: { stockCode: "BHP" },
        peers: [{ stockCode: "BHP" }, { stockCode: "RIO" }],
      }),
    );
    expect(view!.subject?.code).toBe("BHP");
    expect(view!.rows.map((r) => r.code)).toEqual(["RIO"]);
  });

  it("has no subject row when the answer names none with a valid code", () => {
    const view = parsePeers(JSON.stringify({ subject: { stockCode: "bad code" }, peers: [{ stockCode: "NEM" }] }));
    expect(view!.subject).toBeUndefined();
    expect(view!.subjectCode).toBeUndefined();
    expect(view!.rows.map((r) => r.code)).toEqual(["NEM"]);
  });

  it("drops peers with no valid code and returns null without a peers list", () => {
    const view = parsePeers(
      JSON.stringify({
        peers: [{ stockCode: "bad code" }, { stockCode: "NEM", marketCap: "x" }],
      }),
    );
    expect(view!.rows.map((r) => r.code)).toEqual(["NEM"]);
    expect(view!.rows[0]!.marketCap).toBeUndefined();

    expect(parsePeers(JSON.stringify({ subject: {} }))).toBeNull();
  });
});

describe("parseDirectorTrades (recorded)", () => {
  it("reads all ten BHP trades, numbers only where the data has them", () => {
    const view = parseDirectorTrades(fixture("get_director_trades-bhp.json"));

    expect(view).not.toBeNull();
    expect(view!.trades).toHaveLength(10);
    expect(view!.notShown).toBe(0);

    const vassella = view!.trades.find((t) => t.director === "Mark Vassella");
    expect(vassella).toMatchObject({
      tradeType: "buy",
      tradeDate: "2026-09-11",
      shares: 2675,
      pricePerShare: 60.5031,
      totalValue: 161845.72,
    });

    const unknown = view!.trades.find((t) => t.director === "Unknown Director");
    expect(unknown!.shares).toBeUndefined();
    expect(unknown!.pricePerShare).toBeUndefined();
    expect(unknown!.totalValue).toBeUndefined();
  });

  it("reads the documented empty answer {} as an empty view", () => {
    const view = parseDirectorTrades(fixture("get_director_trades-glc-none.json"));
    expect(view).toEqual({ trades: [], notShown: 0 });
  });

  it("counts trades the store holds beyond the rows sent", () => {
    const view = parseDirectorTrades(
      JSON.stringify({
        totalCount: 37,
        trades: [{ directorName: "A", tradeType: "sell", tradeDate: "2026-01-02", sharesTraded: "100" }],
      }),
    );
    expect(view!.trades[0]).toMatchObject({ director: "A", tradeType: "sell", shares: 100 });
    expect(view!.notShown).toBe(36);
  });

  it("counts the trades the budget dropped, from the tool's omittedTrades", () => {
    // The shape of a result over the budget: the total is the rows the API returned, which
    // is the rows sent (1) plus the rows the budget dropped (14).
    const view = parseDirectorTrades(
      JSON.stringify({
        totalCount: 15,
        omittedTrades: 14,
        trades: [{ directorName: "A", tradeType: "buy", tradeDate: "2026-09-01" }],
      }),
    );
    expect(view!.trades).toHaveLength(1);
    expect(view!.notShown).toBe(14);
  });

  it("draws the budget-trimmed fifty-row answer and counts the eight it left out", () => {
    const view = parseDirectorTrades(fixture("get_director_trades-bhp-50.json"));

    expect(view).not.toBeNull();
    expect(view!.trades).toHaveLength(36);
    expect(view!.notShown).toBe(8);
    expect(view!.trades[1]).toMatchObject({ director: "Mark Vassella", shares: 2675 });
  });

  it("counts rows past the table's cap as not shown", () => {
    const rows = Array.from({ length: MAX_TABLE_ROWS + 5 }, (_, i) => ({
      directorName: `Director ${i}`,
      tradeType: "buy",
    }));
    const view = parseDirectorTrades(JSON.stringify({ trades: rows }));
    expect(view!.trades).toHaveLength(MAX_TABLE_ROWS);
    expect(view!.notShown).toBe(5);
  });

  it("ignores a share count that is not a whole number string", () => {
    const view = parseDirectorTrades(
      JSON.stringify({ trades: [{ sharesTraded: "12abc" }, { sharesTraded: "1e3" }] }),
    );
    expect(view!.trades[0]!.shares).toBeUndefined();
    expect(view!.trades[1]!.shares).toBe(1000);
  });

  it("returns null for a trades value that is not a list, or an error", () => {
    expect(parseDirectorTrades(JSON.stringify({ trades: { length: 1 } }))).toBeNull();
    expect(parseDirectorTrades(JSON.stringify({ error: "down" }))).toBeNull();
    expect(parseDirectorTrades("<html>")).toBeNull();
  });

  it("does not put a non-http announcement link in the row", () => {
    const view = parseDirectorTrades(
      JSON.stringify({
        trades: [{ directorName: "A", tradeType: "buy", announcementUrl: "javascript:alert(1)" }],
      }),
    );
    // The row keeps the text; the table decides, with safeExternalHref, whether it is a link.
    expect(view!.trades[0]!.announcementUrl).toBe("javascript:alert(1)");
  });
});

describe("parseEconomicSeries (recorded)", () => {
  it("reads the cash rate and CPI series with their observations", () => {
    const result = parseEconomicSeries(fixture("get_economic_series-cash-rate-cpi.json"));

    expect(result).not.toBeNull();
    expect(result!.notShown).toBe(0);
    expect(result!.series.map((s) => s.key)).toEqual([
      "cpi.annual_change.all_groups.aus",
      "rates.cash_rate_target.aus",
    ]);
    expect(result!.series[0]).toMatchObject({ name: "Australia", unit: "percent", frequency: "monthly" });
    expect(result!.series[0]!.points).toHaveLength(12);
    expect(result!.series[0]!.points[0]).toEqual({ t: Date.parse("2025-09-01T00:00:00Z"), v: 3.6 });
  });

  it("reads the 24-month NSW unemployment series", () => {
    const result = parseEconomicSeries(fixture("get_economic_series-unemployment-nsw.json"));
    expect(result!.series).toHaveLength(1);
    expect(result!.series[0]!.name).toBe("New South Wales");
    expect(result!.series[0]!.points).toHaveLength(24);
  });

  it("caps the series drawn and counts the rest", () => {
    const many = Array.from({ length: MAX_ECONOMIC_SERIES + 2 }, (_, i) => ({
      key: `labour.metric${i}.aus`,
      observations: [
        { period: "2026-01-01T00:00:00Z", value: i },
        { period: "2026-02-01T00:00:00Z", value: i + 1 },
      ],
    }));
    const result = parseEconomicSeries(JSON.stringify({ series: many }));
    expect(result!.series).toHaveLength(MAX_ECONOMIC_SERIES);
    expect(result!.notShown).toBe(2);
  });

  it("skips a series with one reading or no key, and returns null when none are usable", () => {
    const mixed = parseEconomicSeries(
      JSON.stringify({
        series: [
          { key: "cpi.annual_change.all_groups.aus", observations: [{ period: "2026-01-01T00:00:00Z", value: 1 }] },
          { observations: [{ period: "2026-01-01T00:00:00Z", value: 1 }, { period: "2026-02-01T00:00:00Z", value: 2 }] },
          { key: "rates.cash_rate_target.aus", observations: [{ period: "2026-01-01T00:00:00Z", value: 4 }, { period: "2026-02-01T00:00:00Z", value: 4.1 }] },
        ],
      }),
    );
    expect(mixed!.series.map((s) => s.key)).toEqual(["rates.cash_rate_target.aus"]);

    expect(
      parseEconomicSeries(JSON.stringify({ series: [{ key: "x", observations: "none" }] })),
    ).toBeNull();
  });

  it("returns an empty result for an empty series list", () => {
    expect(parseEconomicSeries(JSON.stringify({ series: [] }))).toEqual({ series: [], notShown: 0 });
  });

  it("returns null for a result with no series list, or an error", () => {
    expect(parseEconomicSeries("{}")).toBeNull();
    expect(parseEconomicSeries(JSON.stringify({ error: "unavailable" }))).toBeNull();
  });
});

describe("parsers never throw on junk", () => {
  const junk = [
    "",
    "null",
    "42",
    '"text"',
    "[1,2,3]",
    "{",
    "{\"timeSeries\":[null,1,\"x\",[]]}",
    "{\"trades\":[null]}",
    "{\"series\":[{\"key\":[],\"observations\":null}]}",
    "{\"peers\":[{\"stockCode\":{}}],\"subject\":null}",
  ];

  it.each(junk)("handles %j without throwing", (input) => {
    expect(() => parseTopShorts(input)).not.toThrow();
    expect(() => parseShortPositions(input, input)).not.toThrow();
    expect(() => parsePeers(input)).not.toThrow();
    expect(() => parseDirectorTrades(input)).not.toThrow();
    expect(() => parseEconomicSeries(input)).not.toThrow();
  });
});
