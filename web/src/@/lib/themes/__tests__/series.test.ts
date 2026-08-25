import {
  buildThemeShortSeries,
  normalizeConstituentPoints,
} from "~/@/lib/themes/series";

/** Weekly Mondays, so each point lands in its own bucket. */
function mondays(count: number, from = "2026-01-05"): string[] {
  const start = new Date(`${from}T00:00:00Z`);
  return Array.from({ length: count }, (_, i) => {
    const d = new Date(start);
    d.setUTCDate(d.getUTCDate() + i * 7);
    return d.toISOString().slice(0, 10);
  });
}

function constituent(code: string, values: number[], dates = mondays(values.length)) {
  return {
    code,
    points: values.map((value, i) => ({ date: dates[i]!, value })),
  };
}

describe("normalizeConstituentPoints", () => {
  it("accepts all three timestamp shapes the transports produce", () => {
    const points = normalizeConstituentPoints([
      // protobuf Timestamp over connect
      { timestamp: { seconds: BigInt(1767571200) }, shortPosition: 1.5 },
      // the same object after Next's data cache coerced bigint -> number
      { timestamp: { seconds: 1768176000 }, shortPosition: 2.5 },
      // RFC3339 string from the edge-read JSON path
      { timestamp: "2026-01-19T00:00:00Z", shortPosition: 3.5 },
    ]);
    expect(points).toEqual([
      { date: "2026-01-05", value: 1.5 },
      { date: "2026-01-12", value: 2.5 },
      { date: "2026-01-19", value: 3.5 },
    ]);
  });

  it("drops undateable and non-numeric points rather than bucketing them at the epoch", () => {
    expect(
      normalizeConstituentPoints([
        { timestamp: undefined, shortPosition: 1 },
        { timestamp: "not-a-date", shortPosition: 1 },
        { timestamp: { seconds: 0 }, shortPosition: 1 },
        { timestamp: "2026-01-05T00:00:00Z", shortPosition: Number.NaN },
      ]),
    ).toEqual([]);
  });

  it("tolerates a missing points array", () => {
    expect(normalizeConstituentPoints(undefined)).toEqual([]);
  });
});

describe("buildThemeShortSeries", () => {
  it("averages the constituents and shades their full min-max range", () => {
    const dates = mondays(4);
    const series = buildThemeShortSeries([
      constituent("AAA", [1, 2, 3, 4], dates),
      constituent("BBB", [3, 4, 5, 6], dates),
      constituent("CCC", [5, 6, 7, 8], dates),
    ]);

    expect(series).toHaveLength(4);
    expect(series[0]).toEqual({
      date: dates[0],
      avg: 3,
      min: 1,
      max: 5,
      count: 3,
    });
    expect(series[3]).toEqual({
      date: dates[3],
      avg: 6,
      min: 4,
      max: 8,
      count: 3,
    });
  });

  it("excludes a constituent with no data instead of counting it as zero", () => {
    const dates = mondays(4);
    const withFailure = buildThemeShortSeries([
      constituent("AAA", [4, 4, 4, 4], dates),
      constituent("BBB", [6, 6, 6, 6], dates),
      { code: "CCC", points: [] }, // the constituent whose fetch failed
    ]);

    expect(withFailure[0]).toEqual({
      date: dates[0],
      avg: 5,
      min: 4,
      max: 6,
      count: 2,
    });
  });

  it("returns an empty series when no constituent has any points", () => {
    expect(
      buildThemeShortSeries([
        { code: "AAA", points: [] },
        { code: "BBB", points: [] },
      ]),
    ).toEqual([]);
    expect(buildThemeShortSeries([])).toEqual([]);
  });

  it("still charts a basket smaller than the default constituent floor", () => {
    const dates = mondays(4);
    const series = buildThemeShortSeries([
      constituent("AAA", [1, 2, 3, 4], dates),
      constituent("BBB", [3, 4, 5, 6], dates),
    ]);
    expect(series.length).toBeGreaterThan(0);
    expect(series[0]!.count).toBe(2);
  });

  it("returns an empty series when there is too little history to chart", () => {
    const dates = mondays(2);
    expect(
      buildThemeShortSeries([
        constituent("AAA", [1, 2], dates),
        constituent("BBB", [3, 4], dates),
        constituent("CCC", [5, 6], dates),
      ]),
    ).toEqual([]);
  });

  it("emits only serializable primitives (it crosses an RSC boundary)", () => {
    const dates = mondays(4);
    const series = buildThemeShortSeries([
      constituent("AAA", [1, 2, 3, 4], dates),
      constituent("BBB", [3, 4, 5, 6], dates),
      constituent("CCC", [5, 6, 7, 8], dates),
    ]);
    expect(JSON.parse(JSON.stringify(series))).toEqual(series);
    for (const point of series) {
      expect(typeof point.date).toBe("string");
      expect(Number.isFinite(point.avg)).toBe(true);
      expect(Number.isFinite(point.min)).toBe(true);
      expect(Number.isFinite(point.max)).toBe(true);
      expect(Number.isInteger(point.count)).toBe(true);
      expect(point.min).toBeLessThanOrEqual(point.avg);
      expect(point.max).toBeGreaterThanOrEqual(point.avg);
    }
  });
});
