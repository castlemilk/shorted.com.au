import {
  coverageBars,
  coverageChip,
  coverageFigure,
  fragileChips,
  lowestCoverageYear,
  monthCells,
  monthlyYears,
  periodWords,
  sensitivityFigures,
  splitMonthlyYears,
} from "../backtest-tables";
import { mapAnnualReturn, mapBacktestRun, mapCoverageYear, mapMonthlyReturn, mapSensitivity } from "../map-backtest";
import { fixturePublishedRun } from "./backtest-fixtures";

const monthly = [
  mapMonthlyReturn({ year: 2026, month: 1, state: "complete", strategyPct: 4.1, hasBenchmark: false }),
  mapMonthlyReturn({ year: 2026, month: 2, state: "current", strategyPct: 1.2, label: "MTD" }),
  mapMonthlyReturn({ year: 2026, month: 3, state: "not_elapsed", strategyPct: 0 }),
  mapMonthlyReturn({ year: 2026, month: 4, state: "before_window", strategyPct: 0 }),
];

describe("the monthly grid", () => {
  it("gives twelve cells, a figure where measured and the period's words where not", () => {
    const cells = monthCells(monthly, 2026);
    expect(cells).toHaveLength(12);
    expect(cells[0]).toEqual({ kind: "value", value: 4.1, current: false });
    expect(cells[1]).toEqual({ kind: "value", value: 1.2, current: true });
    expect(cells[2]).toEqual({ kind: "hatched", label: "Not elapsed" });
    expect(cells[3]).toEqual({ kind: "hatched", label: "Before window" });
    expect(cells[4]).toEqual({ kind: "hatched", label: "n/a" });
  });

  it("says a run-required or not-computable period in its own words", () => {
    expect(periodWords("run_required")).toBe("Run required");
    expect(periodWords("not_computable")).toBe("Not computable");
    expect(periodWords("unknown")).toBe("n/a");
  });

  it("shows the newest three years and puts the earlier ones behind the disclosure", () => {
    const years = monthlyYears([2019, 2020, 2021, 2022, 2023].map((y) => mapMonthlyReturn({ year: y, month: 1 })));
    expect(years).toEqual([2023, 2022, 2021, 2020, 2019]);
    expect(splitMonthlyYears(years)).toEqual({ recent: [2023, 2022, 2021], earlier: [2020, 2019] });
  });

  it("does not read the monthly figure of an annual period it has not measured", () => {
    expect(mapAnnualReturn({ year: 2026, state: "not_elapsed", strategyPct: 12 }).strategyPct).toBeNull();
  });
});

describe("coverage", () => {
  const years = [
    mapCoverageYear({ year: 2019, measurable: true, coveragePct: 64, hasCoverage: true }),
    mapCoverageYear({ year: 2023, measurable: true, coveragePct: 81, hasCoverage: true }),
    mapCoverageYear({ year: 2025, measurable: true, coveragePct: 96, hasCoverage: true }),
  ];

  it("prints a measured year's figure as a percent, and an unmeasurable one as n/a", () => {
    expect(coverageFigure(years[0]!)).toBe("64%");
    expect(coverageFigure(mapCoverageYear({ year: 2019, measurable: false, coveragePct: 90 }))).toBe("n/a");
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
    expect(coverageChip(years)).toBe(
      "Coverage 64% (2019) → 96% (2025) · flatters results; by how much cannot be measured",
    );
    expect(coverageChip([])).toBe("");
  });

  it("reads the run's own coverage years", () => {
    const run = mapBacktestRun(fixturePublishedRun());
    expect(coverageChip(run.coverageByYear)).toContain("Coverage 64% (2019)");
  });
});

describe("sensitivity", () => {
  it("prints a change that does not apply as n/a, with its reason in the table", () => {
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
