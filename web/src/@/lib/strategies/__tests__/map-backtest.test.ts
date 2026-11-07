import {
  mapAnnualReturn,
  mapBacktestRun,
  mapCoverageYear,
  mapPaperTrack,
  mapStrategyEvidenceList,
  mapWindowMetrics,
  toBacktestState,
} from "../map-backtest";
import {
  FIXTURE_ENGINE_SEGMENTS,
  FIXTURE_RECORDED_FROM,
  fixtureEvidence,
  fixturePublishedRun,
  fixtureWindows,
} from "./backtest-fixtures";

describe("the backtest mapper: states (the contract's values)", () => {
  it.each(["published", "approximate", "run_required", "running", "not_computable"])(
    "keeps %s",
    (state) => expect(toBacktestState(state)).toBe(state),
  );

  it("names an unknown or superseded state unavailable, never guesses one", () => {
    expect(toBacktestState("computed")).toBe("unavailable");
    expect(toBacktestState(undefined)).toBe("unavailable");
  });

  it("carries state_reason, running_since and the computable share", () => {
    const run = mapBacktestRun({
      state: "run_required",
      stateReason: "No recipe for this version yet.",
      runningSince: "2026-11-08T14:02:00Z",
      computableSharePct: 31.4,
      hasComputableShare: true,
    });
    expect(run.stateReason).toBe("No recipe for this version yet.");
    expect(run.runningSince).toBe("2026-11-08T14:02:00Z");
    expect(run.computableSharePct).toBe(31.4);
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
    expect(mapWindowMetrics({ totalReturnPct: 0, hasTotalReturn: true }).totalReturnPct).toBe(0);
  });

  it("nulls a benchmark or reference level of zero (not measured after the freeze)", () => {
    const run = mapBacktestRun(fixturePublishedRun());
    // The reference is measured to reference_to (2026-10-30 in the golden); after it, no reference.
    const afterReferenceEnd = run.series.filter((p) => p.date > "2026-10-30");
    expect(afterReferenceEnd.length).toBeGreaterThan(0);
    for (const point of afterReferenceEnd) expect(point.reference).toBeNull();
    expect(run.series.every((p) => p.benchmark === null || p.benchmark > 0)).toBe(true);
  });

  it("never turns a JSON NaN into a number", () => {
    const w = mapWindowMetrics({ maxDrawdownPct: "NaN" as unknown as number, sharpe: "NaN" as unknown as number, hasSharpe: true });
    expect(w.maxDrawdownPct).toBe(0);
    expect(w.sharpe).toBeNull();
  });
});

describe("the backtest mapper: periods", () => {
  it("reads a complete, partial or to-date period's figures", () => {
    for (const state of ["complete", "partial", "to_date"]) {
      expect(mapAnnualReturn({ year: 2025, state, strategyPct: 4.2 }).strategyPct).toBe(4.2);
    }
  });

  it("keeps the to-date state, for the current year measured so far", () => {
    expect(mapAnnualReturn({ year: 2026, state: "to_date", months: "YTD" }).state).toBe("to_date");
  });

  it("reads an unknown period state as unknown, never as a figure", () => {
    expect(mapAnnualReturn({ year: 2026, state: "not_elapsed", strategyPct: 4 }).state).toBe("unknown");
  });

  it("carries the coverage measure a figure names", () => {
    const annual = mapAnnualReturn({ year: 2025, state: "complete", coverageMeasurable: true, coveragePct: 96, coverageMeasure: "qualifying_5pct_short" });
    expect(annual.coverageMeasure).toBe("qualifying_5pct_short");
    expect(annual.coveragePct).toBe(96);
    expect(mapAnnualReturn({ year: 2019, state: "complete", coverageMeasure: "not_measurable" }).coverageMeasure).toBe("not_measurable");
  });

  it("maps a year's coverage on both measures, with its exits", () => {
    const year = mapCoverageYear({
      year: 2019,
      measurable: true,
      qualifyingNameDays: "500",
      pricedNameDays: "320",
      coveragePct: 64,
      allReportedPct: 58,
      allReportedMeasurable: true,
      delistingExits: 14,
      caExits: 3,
    });
    expect(year).toMatchObject({ measurable: true, coveragePct: 64, qualifyingNameDays: 500, pricedNameDays: 320, allReportedPct: 58, delistingExits: 14, caExits: 3 });
  });

  it("reads a year the qualifying measure cannot see as not measurable, with no figure", () => {
    const year = mapCoverageYear({ year: 2019, measurable: false, coveragePct: 88, allReportedMeasurable: true, allReportedPct: 70 });
    expect(year.measurable).toBe(false);
    expect(year.coveragePct).toBeNull();
    expect(year.allReportedPct).toBe(70);
  });
});

describe("the backtest mapper: windows and drawdown dates", () => {
  it("maps the drawdown's peak, trough and recovery, and an unrecovered curve", () => {
    const [full, since2023] = fixtureWindows().map((w) => mapWindowMetrics(w));
    expect(full?.peakDate).toBe("2019-08-13");
    expect(full?.troughDate).toBe("2020-01-06");
    expect(full?.recoveryDate).toBe("2020-04-07");
    expect(since2023?.recoveryDate).toBe("2026-01-16");
  });

  it("leaves a curve that never fell with no dates", () => {
    const w = mapWindowMetrics({ window: "live", peakDate: "", troughDate: "", recoveryDate: "" });
    expect(w.peakDate).toBeNull();
    expect(w.recoveryDate).toBeNull();
  });

  it("maps the total return of XJT and the reference, shown for every window", () => {
    const full = mapWindowMetrics(fixtureWindows()[0]!);
    expect(full.benchmarkTotalReturnPct).toBe(0.48);
    expect(full.referenceTotalReturnPct).toBe(23.48);
    const live = mapWindowMetrics(fixtureWindows()[3]!);
    const liveFlag = fixtureWindows()[3];
    expect(live.benchmarkTotalReturnPct).toBe(liveFlag?.hasBenchmarkTotalReturn ? liveFlag.benchmarkTotalReturnPct : null);
  });

  it("maps the four windows in the API's ids", () => {
    const run = mapBacktestRun(fixturePublishedRun());
    expect(run.windows.map((w) => w.window)).toEqual(["since_2019_05", "since_2023", "trailing_12m", "live"]);
  });
});

describe("the backtest mapper: the paper track", () => {
  it("maps recorded_from, separate from the freeze", () => {
    const paper = mapPaperTrack({ since: "2026-10-02", recordedFrom: FIXTURE_RECORDED_FROM, sessions: 25 });
    expect(paper.since).toBe("2026-10-02");
    expect(paper.recordedFrom).toBe(FIXTURE_RECORDED_FROM);
  });

  it("maps the engine segments in order, and the run's paper start", () => {
    const run = mapBacktestRun(fixturePublishedRun());
    expect(run.paperStart).toBe(FIXTURE_RECORDED_FROM);
    expect(run.paperEngineSegments.map((s) => s.engineVersion)).toEqual(["1.1.0", "1.1.1"]);
    expect(run.paperEngineSegments[1]?.firstSession).toBe(FIXTURE_ENGINE_SEGMENTS[1]?.firstSession);
  });
});

describe("the backtest mapper: run, evidence and data quality", () => {
  it("maps the identity, the served window, the series resolution and the data-quality counts", () => {
    const run = mapBacktestRun(fixturePublishedRun());
    expect(run.identity?.runId).toBe(101);
    expect(run.identity?.inSampleUntil).toBe("2026-09-30");
    expect(run.windowId).toBe("since_2019_05");
    expect(run.seriesResolution).toBe("weekly");
    expect(run.dataQuality).toMatchObject({ delistingExits: 2, corporateActionExits: 1, cancelledEntries: { liquidity: 4 } });
  });

  it("maps the coverage by year from the contract's coverage field", () => {
    const run = mapBacktestRun(fixturePublishedRun());
    expect(run.coverageByYear.map((y) => y.year)).toEqual([2019, 2020, 2021, 2022, 2023, 2024, 2025, 2026]);
    expect(run.coverageByYear[0]?.coveragePct).toBe(70);
  });

  it("reads int64 counts that protobuf-es decodes to bigint, as numbers", () => {
    const year = mapCoverageYear({ year: 2019, measurable: true, qualifyingNameDays: BigInt(500), pricedNameDays: BigInt(320) });
    expect(year.qualifyingNameDays).toBe(500);
    expect(year.pricedNameDays).toBe(320);
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
    expect(ev?.runId).toBe(101);
    expect(ev?.paper?.tooShort).toBe(true);
    expect(ev?.paper?.recordedFrom).toBe(FIXTURE_RECORDED_FROM);
    expect(ev?.miniCurve.length).toBeGreaterThan(0);
  });
});
