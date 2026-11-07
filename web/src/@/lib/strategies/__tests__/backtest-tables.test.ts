import { monthlyCoverageUnderMeasure, namedDaysFigure } from "../backtest-tables";
import {
  costsCopy,
  HOUSE_COSTS_FALLBACK,
  isWipedOut,
  spreadRangeBps,
} from "../backtest-tables";
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
import { mapBacktestRun, mapCoverageMonth, mapCoverageYear, mapMonthlyReturn, mapSensitivity } from "../map-backtest";
import { fixtureMinerviniRun, fixturePublishedRun } from "./backtest-fixtures";
import { readFileSync } from "fs";
import { join } from "path";

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
    expect(coverageChip(run.coverageByYear, coverageMeasureOf(run.survivorship?.measurement))).toContain("Coverage (qualifying ≥ 5% short) 70% (2019) → 70% (2026)");
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

describe("the costs note is read from the run's recipe (5.4, item c)", () => {
  it("prints the brokerage and the spread range the recipe's own tiers give, not a fixed range", () => {
    const recipe = mapBacktestRun(fixtureMinerviniRun()).recipe;
    expect(recipe).not.toBeNull();
    const copy = costsCopy(recipe);
    // The r1 house tiers are 5, 10, 25, 50 and 75 bps per side.
    expect(copy).toContain("10 bps brokerage (min A$10) + 5-75 bps spread by liquidity, per side.");
    expect(copy).not.toContain("5-50");
  });

  it("reads the range from whatever tiers the spread line prints", () => {
    expect(spreadRangeBps("Spread and impact per side by 20-session dollar volume at the decision close: A$20,000,000 and over at 3 bps; under A$1,000,000 at 40 bps.")).toEqual({ min: 3, max: 40 });
    expect(costsCopy({ brokerage: "Brokerage 10 bps per side, at least A$10 per fill.", spread: "Spread and impact per side by 20-session dollar volume at the decision close: A$20,000,000 and over at 3 bps; under A$1,000,000 at 40 bps." })).toContain("3-40 bps spread by liquidity");
  });

  it("never prints a range from the flat sensitivity line, and falls back to the house wording with no recipe", () => {
    expect(spreadRangeBps("Mockup costs (flat 10 + 5 bps per side) flatter small-cap breakouts. Flat slippage of 5 bps per side replaces the spread tiers: this is a sensitivity, not the house model.")).toBeNull();
    expect(costsCopy(null)).toBe(HOUSE_COSTS_FALLBACK);
    expect(costsCopy({ brokerage: "", spread: "no tiers here" })).toBe(HOUSE_COSTS_FALLBACK);
  });

  it("no statement of the house spread range in the web app still says 5-50 bps", () => {
    const webSrc = join(__dirname, "..", "..", "..", "..");
    const files = [
      join(webSrc, "@", "lib", "strategies", "explorer.ts"),
      join(webSrc, "@", "components", "strategies", "sensitivity-table.tsx"),
      join(webSrc, "@", "lib", "strategies", "backtest-tables.ts"),
    ];
    for (const f of files) {
      expect({ file: f, has: /5\s*(-|to)\s*50\s*bps/.test(readFileSync(f, "utf8")) }).toEqual({ file: f, has: false });
    }
  });
});

describe("a wiped-out sensitivity run (5.12, item a)", () => {
  it("is wiped out when its drawdown reaches -100%, and not otherwise", () => {
    const wiped = mapSensitivity({ id: "costs_x2", label: "Costs doubled", applies: true, maxDrawdownPct: -100.01 });
    expect(isWipedOut(wiped)).toBe(true);
    expect(isWipedOut(mapSensitivity({ id: "costs_x2", label: "Costs doubled", applies: true, maxDrawdownPct: -100 }))).toBe(true);
    expect(isWipedOut(mapSensitivity({ id: "costs_x2", label: "Costs doubled", applies: true, maxDrawdownPct: -99.9 }))).toBe(false);
    // A row that does not apply is not a wipe-out: it says why it does not apply.
    expect(isWipedOut(mapSensitivity({ id: "asic_lag_plus_2", label: "x", applies: false, maxDrawdownPct: -100 }))).toBe(false);
  });

  it("keeps the served CAGR: n/a today, the figure once the engine serves one", () => {
    expect(sensitivityFigures(mapSensitivity({ id: "costs_x2", label: "Costs doubled", applies: true, maxDrawdownPct: -100.01 })).cagr).toBe("n/a");
    expect(sensitivityFigures(mapSensitivity({ id: "costs_x2", label: "Costs doubled", applies: true, maxDrawdownPct: -100.01, hasCagr: true, cagrPct: -100, hasCagr: true })).cagr).toMatch(/^[−-]100\.0%$/);
  });
});

describe("the name-days column and the monthly strip use the run's own measure", () => {
  it("states an all-reported year's priced name-days under the all-reported measure, never the qualifying 0 of 0", () => {
    // Minervini 2025: the qualifying fields are 0 (the measure is not this strategy's); the all-reported ones are real.
    const row = mapCoverageYear({
      year: 2025, measurable: true, qualifyingNameDays: 0, pricedNameDays: 0,
      allReportedMeasurable: true, allReportedPct: 97.81, allReportedNameDays: 153672, allReportedPricedNameDays: 150302,
    });
    expect(namedDaysFigure(row, "all_reported")).toBe("150,302 of 153,672");
  });

  it("gives no name-days figure for a year the measure cannot see (the cell reads '?', never a number)", () => {
    const pre2025 = mapCoverageYear({ year: 2019, measurable: false, allReportedMeasurable: false });
    expect(namedDaysFigure(pre2025, "all_reported")).toBeNull();
    expect(namedDaysFigure(pre2025, "qualifying")).toBeNull();
  });

  it("gives a measured run's name-days from the qualifying fields, as before", () => {
    const measured = mapCoverageYear({ year: 2025, measurable: true, qualifyingNameDays: 10203, pricedNameDays: 10203, coveragePct: 100 });
    expect(namedDaysFigure(measured, "qualifying")).toBe("10,203 of 10,203");
    expect(namedDaysFigure(measured, "all_reported")).toBeNull();
  });

  it("maps every month under the run's measure: a month the measure cannot see has no figure", () => {
    const months = [
      mapCoverageMonth({ month: "2019-05", allReportedMeasurable: false }),
      mapCoverageMonth({ month: "2025-01", allReportedMeasurable: true, allReportedPct: 96 }),
    ];
    expect(monthlyCoverageUnderMeasure(months, "all_reported")).toEqual([
      { month: "2019-05", coveragePct: null, measurable: false },
      { month: "2025-01", coveragePct: 96, measurable: true },
    ]);
    expect(monthlyCoverageUnderMeasure(months, "qualifying").map((m) => m.measurable)).toEqual([false, false]);
  });
});

