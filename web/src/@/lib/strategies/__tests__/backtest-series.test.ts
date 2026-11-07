import {
  GROWTH_BASE,
  areaPath,
  dateToMs,
  engineMarks,
  firstRecorded,
  growthOf,
  linePath,
  nextDay,
  niceTicks,
  paddedDomain,
  recordedBand,
  seriesInWindow,
  timeScale,
  troughOf,
  valueScale,
  yearTicks,
} from "../backtest-series";
import { mapSeriesPoint, type SeriesPointView } from "../map-backtest";
import { fixtureSeries } from "./backtest-fixtures";

const points = (rows: Array<Partial<SeriesPointView> & { date: string; equity: number }>): SeriesPointView[] =>
  rows.map((r) => ({ benchmark: null, reference: null, drawdownPct: 0, exposurePct: 0, recorded: false, ...r }));

describe("growth of A$100,000", () => {
  const series = points([
    { date: "2024-01-05", equity: 200_000, benchmark: 100 },
    { date: "2024-01-12", equity: 220_000, benchmark: 110 },
    { date: "2024-01-19", equity: 176_000, benchmark: 105 },
    { date: "2024-01-26", equity: 240_000, benchmark: 120 },
  ]);

  it("rebases the strategy and the benchmark to A$100,000 at the window's first point", () => {
    const g = growthOf(series);
    expect(g[0]?.strategy).toBe(GROWTH_BASE);
    expect(g[1]?.strategy).toBeCloseTo(110_000);
    expect(g[0]?.benchmark).toBe(GROWTH_BASE);
    expect(g[1]?.benchmark).toBeCloseTo(110_000);
  });

  it("measures drawdown from the window's own running peak", () => {
    const g = growthOf(series);
    // 176,000 against the running peak of 220,000: a 20% fall from the peak.
    expect(g[2]?.drawdownPct).toBeCloseTo(-20, 6);
    expect(g[0]?.drawdownPct).toBe(0);
    expect(troughOf(g)?.date).toBe("2024-01-19");
  });

  it("has no trough when the curve never falls", () => {
    expect(troughOf(growthOf(points([{ date: "2024-01-05", equity: 1 }, { date: "2024-01-12", equity: 2 }])))).toBeNull();
  });

  it("gives no points for an empty series", () => {
    expect(growthOf([])).toEqual([]);
  });
});

describe("the recorded span (only after the freeze)", () => {
  const frozen = fixtureSeries();

  it("draws the band from the first recorded point, never before it", () => {
    const g = growthOf(frozen);
    const first = firstRecorded(g);
    expect(first?.recorded).toBe(true);
    expect(first?.date >= "2026-10-02").toBe(true);
    const box = { width: 720, height: 0, left: 58, right: 104, top: 12, bottom: 0 };
    const band = recordedBand(g, timeScale(g, box), box);
    expect(band).not.toBeNull();
    expect(band!.x).toBeGreaterThan(58);
  });

  it("draws no band for a window that ends before the freeze", () => {
    const before = growthOf(frozen.filter((p) => !p.recorded));
    expect(firstRecorded(before)).toBeNull();
    expect(recordedBand(before, timeScale(before, { width: 720, height: 0, left: 58, right: 104, top: 0, bottom: 0 }), { width: 720, height: 0, left: 58, right: 104, top: 0, bottom: 0 })).toBeNull();
  });
});

describe("paths", () => {
  it("lifts the pen where a value is null, so a line never crosses a gap", () => {
    const g = growthOf(points([
      { date: "2024-01-05", equity: 1, benchmark: 1 },
      { date: "2024-01-12", equity: 2, benchmark: null },
      { date: "2024-01-19", equity: 3, benchmark: 3 },
    ]));
    const x = timeScale(g, { width: 720, height: 0, left: 0, right: 0, top: 0, bottom: 0 });
    const y = valueScale([0, 4], 0, 100);
    const d = linePath(g, (p) => p.benchmark, x, y);
    expect(d.match(/M/g)?.length).toBe(2);
    expect(d.startsWith("M")).toBe(true);
  });

  it("closes the drawdown area on the zero line", () => {
    const g = growthOf(points([{ date: "2024-01-05", equity: 2 }, { date: "2024-01-12", equity: 1 }]));
    const x = timeScale(g, { width: 720, height: 0, left: 0, right: 0, top: 0, bottom: 0 });
    const y = valueScale([-60, 0], 0, 100);
    expect(areaPath(g, x, y).endsWith("Z")).toBe(true);
  });
});

describe("axes", () => {
  it("picks round steps across a range", () => {
    expect(niceTicks(0, 100, 5)).toEqual([0, 20, 40, 60, 80, 100]);
    expect(niceTicks(0, 0)).toEqual([]);
  });

  it("pads a domain to the nice steps around its values", () => {
    const [lo, hi] = paddedDomain([103, 187]);
    expect(lo).toBeLessThanOrEqual(103);
    expect(hi).toBeGreaterThanOrEqual(187);
  });

  it("labels each 1 January in the span, and the first year", () => {
    const g = growthOf(points([
      { date: "2024-06-07", equity: 1 },
      { date: "2025-01-03", equity: 2 },
      { date: "2026-03-06", equity: 3 },
    ]));
    expect(yearTicks(g).map((t) => t.label)).toEqual(["2025", "2026"]);
  });
});

describe("dates and windows", () => {
  it("converts a session date and rejects a malformed one", () => {
    expect(dateToMs("1970-01-02")).toBe(86_400_000);
    expect(Number.isNaN(dateToMs("2024/01/01"))).toBe(true);
  });

  it("finds the day after the in-sample end, which is the freeze", () => {
    expect(nextDay("2026-10-01")).toBe("2026-10-02");
    expect(nextDay("2026-12-31")).toBe("2027-01-01");
  });

  it("keeps the points inside a window, both ends inclusive", () => {
    const rows = points([{ date: "2024-01-05", equity: 1 }, { date: "2024-06-07", equity: 2 }, { date: "2025-01-03", equity: 3 }]);
    expect(seriesInWindow(rows, "2024-01-05", "2024-06-07").map((p) => p.date)).toEqual(["2024-01-05", "2024-06-07"]);
    expect(seriesInWindow(rows, "2024-06-08", "").map((p) => p.date)).toEqual(["2025-01-03"]);
  });

  it("reads a zero benchmark as not measured", () => {
    expect(mapSeriesPoint({ date: "2024-01-05", equity: 1, benchmark: 0, reference: 0 })).toMatchObject({ benchmark: null, reference: null });
  });
});

describe("the recorded band and engine marks (the contract's dates)", () => {
  const box = { width: 720, height: 0, left: 58, right: 104, top: 0, bottom: 0 };
  const g = growthOf(fixtureSeries());

  it("starts the band at recorded_from when it is given, not at the freeze", () => {
    const x = timeScale(g, box);
    const fromFreeze = recordedBand(g, x, box, "2026-10-02");
    const fromTrack = recordedBand(g, x, box, "2026-10-09");
    expect(fromFreeze).not.toBeNull();
    expect(fromTrack!.x).toBeGreaterThan(fromFreeze!.x);
  });

  it("marks each engine change after the first segment, at its first session", () => {
    const x = timeScale(g, box);
    const marks = engineMarks(
      [
        { engineVersion: "1.0.0", firstSession: "2026-10-05" },
        { engineVersion: "1.0.1", firstSession: "2026-10-19" },
      ],
      g,
      x,
    );
    expect(marks).toHaveLength(1);
    expect(marks[0]?.engineVersion).toBe("1.0.1");
    expect(marks[0]?.x).toBeGreaterThan(0);
  });

  it("skips an engine change the window does not show", () => {
    const x = timeScale(g, box);
    expect(engineMarks([{ engineVersion: "1.0.0", firstSession: "2020-01-03" }, { engineVersion: "1.0.1", firstSession: "2001-01-05" }], g, x)).toEqual([]);
  });
});
