import {
  coverageBars,
  coverageChip,
  coverageFigure,
  fragileChips,
  lowestCoverageYear,
  monthCells,
  monthWords,
  monthlyYears,
  sensitivityFigures,
  splitMonthlyYears,
} from "../backtest-tables";
import { mapBacktestRun, mapCoverageYear, mapMonthlyReturn, mapSensitivity } from "../map-backtest";
import { fixturePublishedRun } from "./backtest-fixtures";

const WINDOW_START = "2019-05-01";
const WINDOW_END = "2026-11-06";

const monthly = [
  mapMonthlyReturn({ year: 2026, month: 1, state: "complete", strategyPct: 4.1 }),
  mapMonthlyReturn({ year: 2026, month: 2, state: "to_date", strategyPct: 1.2, label: "MTD" }),
];

describe("the monthly grid", () => {
  it("gives twelve cells: a figure where served, and the words the window's bounds give", () => {
    const cells = monthCells(monthly, 2026, WINDOW_START, WINDOW_END);
    expect(cells).toHaveLength(12);
    expect(cells[0]).toEqual({ kind: "value", value: 4.1, current: false });
    expect(cells[1]).toEqual({ kind: "value", value: 1.2, current: true });
    // March 2026 is inside the window with no row: "n/a", never a figure.
    expect(cells[2]).toEqual({ kind: "hatched", label: "n/a" });
    expect(cells[11]).toEqual({ kind: "hatched", label: "Not elapsed" });
  });

  it("says a month before the window is before the window, and one after it not elapsed", () => {
    expect(monthWords(2019, 4, WINDOW_START, WINDOW_END)).toBe("Before window");
    expect(monthWords(2019, 5, WINDOW_START, WINDOW_END)).toBe("n/a");
    expect(monthWords(2026, 11, WINDOW_START, WINDOW_END)).toBe("n/a");
    expect(monthWords(2026, 12, WINDOW_START, WINDOW_END)).toBe("Not elapsed");
  });

  it("shows the newest three years, with the earlier years behind a disclosure", () => {
    const years = monthlyYears([2019, 2020, 2021, 2022, 2023].map((y) => mapMonthlyReturn({ year: y, month: 1 })));
    expect(years).toEqual([2023, 2022, 2021, 2020, 2019]);
    expect(splitMonthlyYears(years)).toEqual({ recent: [2023, 2022, 2021], earlier: [2020, 2019] });
  });
});

describe("coverage", () => {
  const years = [
    mapCoverageYear({ year: 2019, measurable: true, coveragePct: 64, allReportedPct: 58, allReportedMeasurable: true }),
    mapCoverageYear({ year: 2023, measurable: true, coveragePct: 81, allReportedPct: 79, allReportedMeasurable: true }),
    mapCoverageYear({ year: 2025, measurable: true, coveragePct: 96, allReportedPct: 93, allReportedMeasurable: true }),
  ];

  it("prints a measured year's figure as a percent, and an unmeasurable one as not measurable", () => {
    expect(coverageFigure(years[0]!)).toBe("64%");
    expect(coverageFigure(mapCoverageYear({ year: 2019, measurable: false, coveragePct: 90 }))).toBe("not measurable");
  });

  it("draws the bars as fractions of the names, and a bar of an unmeasurable year is null", () => {
    const bars = coverageBars([...years, mapCoverageYear({ year: 2020, measurable: false })]);
    expect(bars.map((b) => b.coverage)).toEqual([0.64, 0.81, 0.96, null]);
  });

  it("finds the lowest measured year, the one the survivorship line names", () => {
    expect(lowestCoverageYear(years)?.year).toBe(2019);
    expect(lowestCoverageYear([mapCoverageYear({ year: 2019, measurable: false })])).toBeNull();
  });

  it("prints the header's chip from the first and last measured years, in words", () => {
    expect(coverageChip(years)).toBe("Coverage 64% (2019) → 96% (2025) · flatters results; by how much cannot be measured");
    expect(coverageChip([])).toBe("");
  });

  it("prints the all-reported chip, with its own caveat, when the qualifying measure is not measurable (Minervini)", () => {
    const minervini = [
      mapCoverageYear({ year: 2019, measurable: false, allReportedMeasurable: true, allReportedPct: 58 }),
      mapCoverageYear({ year: 2025, measurable: false, allReportedMeasurable: true, allReportedPct: 93 }),
    ];
    expect(coverageChip(minervini)).toBe(
      "Coverage (all reported) 58% (2019) → 93% (2025) · measured on ASIC-reported names only; delisted companies never shorted cannot be counted",
    );
  });

  it("prints the all-reported chip when some year's qualifying measure is not measurable", () => {
    const mixed = [
      mapCoverageYear({ year: 2019, measurable: false, allReportedMeasurable: true, allReportedPct: 58 }),
      mapCoverageYear({ year: 2025, measurable: true, coveragePct: 96, allReportedMeasurable: true, allReportedPct: 93 }),
    ];
    expect(coverageChip(mixed)).toMatch(/^Coverage \(all reported\) 58% \(2019\) → 93% \(2025\)/);
  });

  it("reads the run's own coverage years", () => {
    const run = mapBacktestRun(fixturePublishedRun());
    expect(coverageChip(run.coverageByYear)).toContain("Coverage 64% (2019)");
  });
});

describe("sensitivity", () => {
  it("prints a change that does not apply as n/a", () => {
    const row = mapSensitivity({ id: "asic_lag_plus_2", label: "Lag", applies: false, reason: "Not taken by this recipe." });
    expect(sensitivityFigures(row)).toEqual({ cagr: "n/a", excess: "n/a" });
  });

  it("prints signed figures with a true minus", () => {
    const row = mapSensitivity({ id: "costs_x2", label: "Costs", applies: true, cagrPct: 9.8, hasCagr: true, excessVsBenchmarkPct: -1.25, hasExcess: true });
    expect(sensitivityFigures(row)).toEqual({ cagr: "+9.8%", excess: "−1.3 pp" });
  });

  it("lists each fragile chip once, in the order the API sent them", () => {
    const rows = [
      mapSensitivity({ id: "a", fragile: true, fragileChip: "Fragile to costs" }),
      mapSensitivity({ id: "b", fragile: true, fragileChip: "Fragile to costs" }),
      mapSensitivity({ id: "c", fragile: false, fragileChip: "Fragile to entry timing" }),
      mapSensitivity({ id: "d", fragile: true, fragileChip: "Fragile to publication timing" }),
    ];
    expect(fragileChips(rows)).toEqual(["Fragile to costs", "Fragile to publication timing"]);
  });
});
