// A fixture published run and its evidence, in design 8.2's vocabulary and
// protojson's camelCase (the shape map-backtest.ts reads). Every figure is
// deterministic and invented: this file tests how the page draws a run, never
// what a strategy earned. The series is one point per ISO week from May 2019 to
// the newest session, with the paper track recorded after the freeze.

import type {
  BacktestRunInput,
  SeriesPointInput,
  StrategyEvidenceInput,
  WindowMetricsInput,
} from "../map-backtest";

export const FIXTURE_LIVE_FROM = "2026-10-02";
export const FIXTURE_IN_SAMPLE_UNTIL = "2026-10-01";
export const FIXTURE_PRICES_THROUGH = "2026-11-06";
export const FIXTURE_RULES_HASH = "3f9a1c2e" + "b".repeat(56);
export const FIXTURE_RECIPE_HASH = "a91b2c04" + "c".repeat(56);

const DAY_MS = 86_400_000;

function isoOf(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

/** Weekly points from 3 May 2019 to the newest session, equity and benchmark deterministic. */
export function fixtureSeries(): SeriesPointInput[] {
  const start = Date.UTC(2019, 4, 3);
  const end = Date.UTC(2026, 10, 6);
  const points: SeriesPointInput[] = [];
  let peak = 0;
  for (let t = start, i = 0; t <= end; t += 7 * DAY_MS, i++) {
    const date = isoOf(t);
    const years = i / 52;
    const equity = 100_000 * Math.exp(0.12 * years) * (1 + 0.04 * Math.sin(i / 3));
    const benchmark = 100 * Math.exp(0.08 * years) * (1 + 0.02 * Math.cos(i / 5));
    const recorded = date >= FIXTURE_LIVE_FROM;
    peak = Math.max(peak, equity);
    points.push({
      date,
      equity: round2(equity),
      // The same-data reference is not recorded after the freeze: zero reads as not measured.
      reference: recorded ? 0 : round2(100 * Math.exp(0.1 * years)),
      benchmark: round2(benchmark),
      drawdownPct: round2((equity / peak - 1) * 100),
      exposurePct: 88.5,
      recorded,
    });
  }
  return points;
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

const SERIES = fixtureSeries();

const windowMetrics = (over: WindowMetricsInput): WindowMetricsInput => ({
  from: "",
  to: FIXTURE_PRICES_THROUGH,
  totalReturnPct: 0,
  hasTotalReturn: true,
  cagrPct: 0,
  hasCagr: true,
  benchmarkCagrPct: 8.1,
  hasBenchmark: true,
  referenceCagrPct: 10.4,
  hasReference: true,
  maxDrawdownPct: -18.6,
  drawdownPeak: "2021-11-08",
  drawdownTrough: "2022-06-13",
  drawdownRecovery: "2023-09-04",
  sharpe: 0.82,
  sharpeSe: 0.36,
  hasSharpe: true,
  closedTrades: 146,
  winRatePct: 43,
  hasWinRate: true,
  exposurePct: 88,
  recordedTail: false,
  sessions: 1800,
  calendarDays: 2741,
  volatilityPct: 16,
  hasVolatility: true,
  notAnnualised: false,
  ...over,
});

/** The four windows of 5.8 in 8.2's ids. */
export function fixtureWindows(): WindowMetricsInput[] {
  return [
    windowMetrics({
      window: "since_2019_05",
      label: "Since May 2019",
      note: "in-sample to 1 Oct 2026, recorded after",
      from: "2019-05-01",
      cagrPct: 12.4,
    }),
    windowMetrics({
      window: "since_2023",
      label: "Since 2023",
      from: "2023-01-03",
      cagrPct: 11.2,
      sessions: 960,
      calendarDays: 1404,
      sharpe: 0.9,
      sharpeSe: 0.4,
      closedTrades: 81,
      maxDrawdownPct: -9.4,
    }),
    windowMetrics({
      window: "trailing_12m",
      label: "Last 12 months",
      from: "2025-11-06",
      cagrPct: 0,
      hasCagr: false,
      totalReturnPct: 14.3,
      hasTotalReturn: true,
      sessions: 250,
      calendarDays: 365,
      sharpe: 1.1,
      sharpeSe: 0.6,
      closedTrades: 22,
      maxDrawdownPct: -6.1,
      notAnnualised: false,
    }),
    windowMetrics({
      window: "live",
      label: "Live since freeze",
      note: "paper track only, recorded",
      from: FIXTURE_LIVE_FROM,
      cagrPct: 0,
      hasCagr: false,
      totalReturnPct: 3.2,
      hasTotalReturn: true,
      sessions: 25,
      calendarDays: 35,
      closedTrades: 2,
      maxDrawdownPct: -2.1,
      recordedTail: true,
      sharpe: 0,
      hasSharpe: false,
      benchmarkCagrPct: 0,
      hasBenchmark: false,
      referenceCagrPct: 0,
      hasReference: false,
    }),
  ];
}

export function fixtureVersion(over: Record<string, unknown> = {}) {
  return {
    strategyId: "crowded-short-breakout",
    label: "v1",
    rulesHash: FIXTURE_RULES_HASH,
    engineVersion: "1.0.0",
    featureSet: "fs1",
    status: "live",
    liveFrom: FIXTURE_LIVE_FROM,
    kind: "canonical",
    variantId: "",
    ...over,
  };
}

/** A published run of the live version. */
export function fixturePublishedRun(over: Partial<BacktestRunInput> = {}): BacktestRunInput {
  return {
    state: "published",
    stateReason: "",
    strategyId: "crowded-short-breakout",
    identity: {
      runId: "42",
      runKey: "9c1e" + "d".repeat(60),
      kind: "publish",
      version: fixtureVersion(),
      recipeId: "csb-r1",
      recipeHash: FIXTURE_RECIPE_HASH,
      engineVersion: "1.0.0",
      windowStart: "2019-05-01",
      windowEnd: FIXTURE_PRICES_THROUGH,
      returns: "total",
      benchmark: "S&P/ASX 200 Gross Total Return (XJT)",
      fundamentals: "",
      pricesThrough: FIXTURE_PRICES_THROUGH,
      asicReportThrough: "2026-11-03",
      inSampleUntil: FIXTURE_IN_SAMPLE_UNTIL,
      finishedAt: "2026-11-08T02:14:00Z",
      inputHash: "1a2b" + "e".repeat(60),
      outputHash: "5c6d" + "f".repeat(60),
      buildRevision: "8798ce3b1",
      riskFree: "RBA cash rate",
      referenceName: "same-data reference",
      runDate: "2026-11-08",
    },
    windows: fixtureWindows(),
    annual: [
      { year: 2024, state: "complete", strategyPct: 19.2, benchmarkPct: 9.8, hasBenchmark: true, referencePct: 21.4, hasReference: true, coveragePct: 84, coverageMeasurable: true, coverageMeasure: "qualifying" },
      { year: 2025, state: "complete", strategyPct: 14.1, benchmarkPct: 7.1, hasBenchmark: true, referencePct: 15.8, hasReference: true, coveragePct: 96, coverageMeasurable: true, coverageMeasure: "qualifying" },
      { year: 2026, state: "current", months: "YTD", strategyPct: 9.7, benchmarkPct: 6.2, hasBenchmark: true, referencePct: 0, hasReference: false, coveragePct: 97, coverageMeasurable: true, coverageMeasure: "qualifying" },
    ],
    monthly: monthlyFixture(),
    series: SERIES,
    coverage: [
      { year: 2019, measurable: true, coveragePct: 64, hasCoverage: true, qualifyingNameDays: 500, pricedNameDays: 320, allReportedPct: 58, hasAllReported: true, delistingExits: 14, caExits: 3, flatBarCancels: 1, dividendStepSuspects: 0 },
      { year: 2021, measurable: true, coveragePct: 70, hasCoverage: true, qualifyingNameDays: 620, pricedNameDays: 434, allReportedPct: 66, hasAllReported: true, delistingExits: 11, caExits: 2, flatBarCancels: 0, dividendStepSuspects: 1 },
      { year: 2025, measurable: true, coveragePct: 96, hasCoverage: true, qualifyingNameDays: 700, pricedNameDays: 672, allReportedPct: 93, hasAllReported: true, delistingExits: 2, caExits: 1, flatBarCancels: 0, dividendStepSuspects: 0 },
    ],
    coverageMonthly: [
      { month: "2025-11", coveragePct: 97, hasCoverage: true, measurable: true, allReportedPct: 94, hasAllReported: true },
      { month: "2025-12", coveragePct: 62, hasCoverage: true, measurable: true, allReportedPct: 59, hasAllReported: true },
    ],
    survivorship: {
      measurement: "measured",
      direction: "flatters",
      statement:
        "Prices are missing for companies that delisted before about 2025. Heavily shorted companies that later failed are over-represented among them, so these results flatter the strategy, most in the earlier years; by how much cannot be measured.",
      caveat: "",
    },
    sensitivity: [
      { id: "costs_x2", label: "Costs doubled", applies: true, cagrPct: 9.8, hasCagr: true, excessVsBenchmarkPct: 1.7, hasExcess: true, maxDrawdownPct: -20.1, fragile: false, fragileChip: "" },
      { id: "asic_lag_plus_2", label: "Publication lag 6 sessions", applies: true, cagrPct: 10.2, hasCagr: true, excessVsBenchmarkPct: -0.4, hasExcess: true, maxDrawdownPct: -19.0, fragile: true, fragileChip: "Fragile to publication timing" },
      { id: "delisting_zero", label: "Delisting exits at zero", applies: true, cagrPct: 11.6, hasCagr: true, excessVsBenchmarkPct: 3.5, hasExcess: true, maxDrawdownPct: -18.9, fragile: false, fragileChip: "" },
      { id: "entry_plus_1", label: "Fill at the next open", applies: true, cagrPct: 11.9, hasCagr: true, excessVsBenchmarkPct: 3.8, hasExcess: true, maxDrawdownPct: -18.8, fragile: false, fragileChip: "" },
      { id: "flat_mockup_costs", label: "Flat 10 + 5 bps costs", applies: true, cagrPct: 12.9, hasCagr: true, excessVsBenchmarkPct: 4.8, hasExcess: true, maxDrawdownPct: -18.2, fragile: false, fragileChip: "" },
    ],
    recipe: {
      recipeId: "csb-r1",
      preface: "Execution recipe chosen by Shorted to test the screen; the author's own entries and exits differ.",
      entry: "Next session open after the signal at the close.",
      exits: ["Below the captured pivot.", "After 20 sessions."],
      sizing: "Up to 10 positions, each 10% of equity at the decision close.",
      brokerage: "10 bps per side, minimum A$10.",
      spread: "5 to 50 bps by liquidity, per side.",
      capacity: "Notional at most 5% of the 20-session dollar volume.",
      dividends: "As adjusted by the price vendor, or credited in cash on the ex-date.",
      asicData: "Latest complete report published by each session, T+4 sessions.",
      delisting: "Delisting exits at the last traded price.",
      capital: "",
      cash: "Cash earns the RBA cash rate.",
    },
    tradeSummary: {
      closed: 146,
      openAtEnd: 3,
      winRatePct: 43,
      hasWinRate: true,
      avgHoldSessions: 31.4,
      avgWinPct: 14.2,
      avgLossPct: -6.1,
      bestPct: 88.4,
      worstPct: -24.9,
      exitsByReason: { pivot_stop: 71, time_stop: 38, status_exit: 21, delisted_exit: 9, open_at_end: 3 },
    },
    liveVersion: fixtureVersion(),
    rulesMatchLive: true,
    engineMatchesLive: true,
    replayAgreement: "Replay agrees: 14 of 15 trades",
    inputChangeNote: "",
    disclosures: [],
    dataNotes: ["Pre-re-sync consolidations: days to cover before them is overstated."],
    runningSince: "",
    seriesResolution: "weekly",
    computableSharePct: 0,
    hasComputableShare: false,
    ...over,
  };
}

function monthlyFixture() {
  const rows: Array<Record<string, unknown>> = [];
  for (const year of [2024, 2025, 2026]) {
    for (let month = 1; month <= 12; month++) {
      let state = "complete";
      if (year === 2026 && month > 10) state = "not_elapsed";
      if (year === 2026 && month === 10) state = "partial";
      rows.push({
        year,
        month,
        state,
        strategyPct: state === "not_elapsed" ? 0 : Math.round(((month * 7 + year) % 9) - 3) + 0.5,
        benchmarkPct: 0.4,
        hasBenchmark: true,
        referencePct: 0.9,
        hasReference: true,
        label: "",
      });
    }
  }
  return rows;
}

export function fixtureEvidence(over: Partial<StrategyEvidenceInput> = {}): StrategyEvidenceInput {
  return {
    strategyId: "crowded-short-breakout",
    version: fixtureVersion(),
    state: "published",
    computableFrom: "",
    fiscalLabel: "",
    windows: fixtureWindows(),
    annual: [],
    miniCurve: SERIES.filter((_, i) => i % 4 === 0),
    paper: { since: FIXTURE_LIVE_FROM, sessions: 25, closedTrades: 2, openPositions: 1, returnPct: 3.2, hasReturn: true, tooShort: true },
    survivorship: "Prices are missing for companies that delisted before about 2025.",
    runId: "42",
    latestScreen: "2026-11-06",
    runningSince: "",
    computableSharePct: 0,
    hasComputableShare: false,
    ...over,
  };
}
