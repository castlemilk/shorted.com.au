import {
  coverageBars,
  coverageChip,
  coverageFigure,
  coverageMeasureOf,
  fragileChips,
  isUnmeasuredYear,
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

describe("coverage: one measure per run", () => {
  const years = [
    mapCoverageYear({ year: 2019, measurable: true, coveragePct: 64, allReportedPct: 58, allReportedMeasurable: true }),
    mapCoverageYear({ year: 2023, measurable: true, coveragePct: 81, allReportedPct: 79, allReportedMeasurable: true }),
    mapCoverageYear({ year: 2025, measurable: true, coveragePct: 96, allReportedPct: 93, allReportedMeasurable: true }),
  ];
  const minervini = [
    mapCoverageYear({ year: 2019, measurable: false, allReportedMeasurable: true, allReportedPct: 58 }),
    mapCoverageYear({ year: 2025, measurable: true, coveragePct: 88, allReportedMeasurable: true, allReportedPct: 93 }),
  ];

  it("takes the measure from the survivorship statement: measured is qualifying, partial and not_measurable are all reported", () => {
    expect(coverageMeasureOf("measured")).toBe("qualifying");
    expect(coverageMeasureOf("partial")).toBe("all_reported");
    expect(coverageMeasureOf("not_measurable")).toBe("all_reported");
    expect(coverageMeasureOf("")).toBe("");
  });

  it("prints the qualifying chip for Crowded-Short, naming its measure", () => {
    expect(coverageChip(years, "qualifying")).toBe(
      "Coverage (qualifying ≥ 5% short) 64% (2019) → 96% (2025) · flatters results; by how much cannot be measured",
    );
  });

  it("prints the all-reported chip for Minervini from its first measurable year, never a pre-2025 year", () => {
    expect(coverageChip(minervini, "all_reported")).toBe(
      "Coverage (all reported) 93% (2025) · flatters results; by how much cannot be measured; the gap cannot be measured for companies that were never reported short",
    );
  });

  it("never draws or cites a pre-2025 year for an all-reported run: the bar is empty and marked, the lowest is 2025", () => {
    const bars = coverageBars(minervini, "all_reported");
    expect(bars.map((b) => b.coverage)).toEqual([null, 0.93]);
    expect(bars[0]?.mark).toBe("?");
    expect(bars[1]?.mark).toBeUndefined();
    expect(lowestCoverageYear(minervini, "all_reported")).toEqual({ year: 2025, coveragePct: 93 });
  });

  it("marks each year before 2025 of a partial run with '?' and prints figures from 2025", () => {
    const partial = [2019, 2020, 2021, 2022, 2023, 2024].map((year) =>
      mapCoverageYear({ year, measurable: false, allReportedMeasurable: true, allReportedPct: 60 }),
    ).concat(mapCoverageYear({ year: 2025, measurable: true, coveragePct: 88, allReportedMeasurable: true, allReportedPct: 93 }));
    for (const year of partial.slice(0, 6)) expect(coverageFigure(year, "all_reported")).toMatch(/\?$/);
    expect(coverageFigure(partial[6]!, "all_reported")).toBe("93%");
    expect(partial.slice(0, 6).every((y) => isUnmeasuredYear(y, "all_reported"))).toBe(true);
    expect(isUnmeasuredYear(partial[6]!, "all_reported")).toBe(false);
  });

  it("gives a measured run (Crowded-Short) no '?' at all", () => {
    const run = mapBacktestRun(fixturePublishedRun());
    const measure = coverageMeasureOf(run.survivorship?.measurement);
    expect(measure).toBe("qualifying");
    for (const year of run.coverageByYear) {
      expect(isUnmeasuredYear(year, measure)).toBe(false);
      expect(coverageFigure(year, measure)).not.toContain("?");
    }
    expect(coverageBars(run.coverageByYear, measure).some((b) => b.mark)).toBe(false);
  });

  it("never names a pre-2025 year in the chip or the lowest-year sentence of a partial run", () => {
    const partial = [2019, 2024].map((year) => mapCoverageYear({ year, measurable: false, allReportedMeasurable: true, allReportedPct: 40 })).concat(
      mapCoverageYear({ year: 2025, measurable: true, coveragePct: 88, allReportedMeasurable: true, allReportedPct: 93 }),
    );
    expect(coverageChip(partial, "all_reported")).not.toMatch(/2019|2024/);
    expect(lowestCoverageYear(partial, "all_reported")?.year).toBe(2025);
  });

  it("marks an all-reported year the qualifying measure cannot see with a question mark, not a figure", () => {
    expect(coverageFigure(minervini[0]!, "all_reported")).toBe("58% ?");
    expect(coverageFigure(minervini[1]!, "all_reported")).toBe("93%");
    expect(coverageFigure(years[0]!, "qualifying")).toBe("64%");
  });

  it("prints n/a where the measure has no figure, and no chip without a measured year", () => {
    expect(coverageFigure(mapCoverageYear({ year: 2019, measurable: false }), "qualifying")).toBe("n/a");
    expect(coverageChip([], "qualifying")).toBe("");
  });

  it("names a lowest year only when it is under 80% (1.7)", () => {
    expect(lowestCoverageYear(years, "qualifying")?.year).toBe(2019);
    expect(lowestCoverageYear([mapCoverageYear({ year: 2025, measurable: true, coveragePct: 96 })], "qualifying")).toEqual({ year: 2025, coveragePct: 96 });
  });

  it("reads the run's own coverage years under its measure", () => {
    const run = mapBacktestRun(fixturePublishedRun());
    expect(coverageChip(run.coverageByYear, coverageMeasureOf(run.survivorship?.measurement))).toContain("Coverage (qualifying ≥ 5% short) 64% (2019)");
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
