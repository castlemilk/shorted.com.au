import {
  mapAnnualReturn,
  mapBacktestRun,
  mapCoverageYear,
  mapStrategyEvidenceList,
  mapWindowMetrics,
  toBacktestState,
} from "../map-backtest";
import { fixturePublishedRun, fixtureEvidence, fixtureWindows } from "./backtest-fixtures";

describe("the backtest mapper: states (8.2)", () => {
  it.each(["published", "approximate", "run_required", "running", "not_computable"])(
    "keeps %s",
    (state) => expect(toBacktestState(state)).toBe(state),
  );

  it("names an unknown state unavailable, never guesses one", () => {
    expect(toBacktestState("computed")).toBe("unavailable");
    expect(toBacktestState(undefined)).toBe("unavailable");
  });

  it("carries state_reason so the page can print it", () => {
    const run = mapBacktestRun({ state: "run_required", stateReason: "No recipe for this version yet." });
    expect(run.state).toBe("run_required");
    expect(run.stateReason).toBe("No recipe for this version yet.");
  });
});

describe("the backtest mapper: zeros and flags", () => {
  it("reads a figure only when its has_ flag is set", () => {
    const w = mapWindowMetrics({ totalReturnPct: 0, hasTotalReturn: false, cagrPct: 9.1, hasCagr: false, sharpe: 0.5, hasSharpe: true });
    expect(w.totalReturnPct).toBeNull();
    expect(w.cagrPct).toBeNull();
    expect(w.sharpe).toBe(0.5);
  });

  it("keeps a measured zero when its flag is set", () => {
    const w = mapWindowMetrics({ totalReturnPct: 0, hasTotalReturn: true });
    expect(w.totalReturnPct).toBe(0);
  });

  it("nulls a benchmark or reference level of zero (not measured after the freeze)", () => {
    const run = mapBacktestRun(fixturePublishedRun());
    const afterFreeze = run.series.filter((p) => p.recorded);
    expect(afterFreeze.length).toBeGreaterThan(0);
    for (const point of afterFreeze) expect(point.reference).toBeNull();
    expect(run.series.every((p) => p.benchmark === null || p.benchmark > 0)).toBe(true);
  });

  it("never turns a JSON NaN into a number", () => {
    const w = mapWindowMetrics({ maxDrawdownPct: "NaN" as unknown as number, sharpe: "NaN" as unknown as number, hasSharpe: true });
    expect(w.maxDrawdownPct).toBe(0);
    expect(w.sharpe).toBeNull();
  });
});

describe("the backtest mapper: periods (8.2 states)", () => {
  it("reads a complete, partial or current period's figures", () => {
    for (const state of ["complete", "partial", "current"]) {
      expect(mapAnnualReturn({ year: 2025, state, strategyPct: 4.2 }).strategyPct).toBe(4.2);
    }
  });

  it("reads no figure for a period that did not elapse or was before the window", () => {
    for (const state of ["not_elapsed", "before_window", "run_required"]) {
      expect(mapAnnualReturn({ year: 2026, state, strategyPct: 4.2 }).strategyPct).toBeNull();
    }
  });

  it("keeps the current (MTD or YTD) state distinct from not elapsed", () => {
    expect(mapAnnualReturn({ year: 2026, state: "current", months: "YTD" }).state).toBe("current");
    expect(mapAnnualReturn({ year: 2026, state: "not_elapsed" }).state).toBe("not_elapsed");
  });

  it("carries the measure of a coverage figure and its data-quality counts", () => {
    const year = mapCoverageYear({
      year: 2019,
      measurable: true,
      coveragePct: 64,
      hasCoverage: true,
      pricedNameDays: 320,
      qualifyingNameDays: 500,
      delistingExits: 14,
      caExits: 3,
      flatBarCancels: 1,
      dividendStepSuspects: 2,
    });
    expect(year.coveragePct).toBe(64);
    expect(year.dataQuality).toEqual({ delistingExits: 14, caExits: 3, flatBarCancels: 1, dividendStepSuspects: 2 });
  });

  it("reads a year the measure cannot see as not measurable, with no figure", () => {
    const year = mapCoverageYear({ year: 2019, measurable: false, coveragePct: 88 });
    expect(year.measurable).toBe(false);
    expect(year.coveragePct).toBeNull();
  });
});

describe("the backtest mapper: the run and the evidence", () => {
  it("maps the identity, the windows in 8.2 ids, and the drawdown dates", () => {
    const run = mapBacktestRun(fixturePublishedRun());
    expect(run.identity?.runId).toBe(42);
    expect(run.identity?.inSampleUntil).toBe("2026-10-01");
    expect(run.windows.map((w) => w.window)).toEqual(["since_2019_05", "since_2023", "trailing_12m", "live"]);
    expect(run.windows[0]?.drawdownPeak).toBe("2021-11-08");
    expect(run.windows[0]?.drawdownRecovery).toBe("2023-09-04");
  });

  it("leaves an unrecovered drawdown's recovery date null", () => {
    expect(mapWindowMetrics({ drawdownRecovery: "" }).drawdownRecovery).toBeNull();
  });

  it("reads the coverage from the 8.2 name, and from the PR-18 name until the rebase", () => {
    expect(mapBacktestRun(fixturePublishedRun()).coverageByYear.map((y) => y.year)).toEqual([2019, 2021, 2025]);
    const legacy = mapBacktestRun({ coverageByYear: [{ year: 2020, hasQualifying: true, qualifyingPct: 70 }] });
    expect(legacy.coverageByYear[0]?.coveragePct).toBe(70);
  });

  it("keeps the coverage figures in percent, as the API states them", () => {
    expect(mapBacktestRun(fixturePublishedRun()).coverageByYear[0]?.coveragePct).toBe(64);
  });

  it("maps the evidence list with the live version, the paper track and the mini curve", () => {
    const list = mapStrategyEvidenceList({
      strategies: [fixtureEvidence()],
      windowStart: "2019-05-01",
      pricesThrough: "2026-11-06",
      benchmarkName: "S&P/ASX 200 Gross Total Return (XJT)",
      footnotes: ["Hypothetical results."],
    });
    const [ev] = list.strategies;
    expect(ev?.version?.label).toBe("v1");
    expect(ev?.runId).toBe(42);
    expect(ev?.paper?.tooShort).toBe(true);
    expect(ev?.miniCurve.length).toBeGreaterThan(0);
    expect(list.pricesThrough).toBe("2026-11-06");
  });

  it("maps the window list the fixture carries without inventing one", () => {
    expect(fixtureWindows().map((w) => w.window)).toEqual(["since_2019_05", "since_2023", "trailing_12m", "live"]);
  });
});
