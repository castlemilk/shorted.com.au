import {
  BACKTEST_WINDOWS,
  CAGR_MIN_CALENDAR_DAYS,
  DEFAULT_BACKTEST_WINDOW,
  INDEXABLE_BACKTEST_MIN_SESSIONS,
  SHARPE_MIN_RETURNS,
  cagrShown,
  isIndexableBacktest,
  orderedWindows,
  sharpeShown,
  windowFromParam,
  windowLabel,
} from "../backtest-windows";
import { mapWindowMetrics } from "../map-backtest";
import { fixtureWindows } from "./backtest-fixtures";

const win = (over: Parameters<typeof mapWindowMetrics>[0]) => mapWindowMetrics({ window: "since_2023", hasCagr: true, cagrPct: 10, hasSharpe: true, sharpe: 0.8, ...over });

describe("the four windows (5.8, 8.2 ids)", () => {
  it("lists the four in order, with the default first", () => {
    expect(BACKTEST_WINDOWS.map((w) => w.id)).toEqual(["since_2019_05", "since_2023", "trailing_12m", "live"]);
    expect(DEFAULT_BACKTEST_WINDOW).toBe("since_2019_05");
  });

  it("reads the window from the query, and falls back to the default for anything else", () => {
    expect(windowFromParam("since_2023")).toBe("since_2023");
    expect(windowFromParam("last_12_months")).toBe("since_2019_05");
    expect(windowFromParam(null)).toBe("since_2019_05");
  });

  it("names each window as the page prints it", () => {
    expect(windowLabel("trailing_12m")).toBe("Last 12 months");
    expect(windowLabel("unknown")).toBe("unknown");
  });

  it("keeps only the four windows, in window order, and never invents one", () => {
    const shuffled = [...fixtureWindows()].reverse();
    expect(orderedWindows(shuffled.map((w) => mapWindowMetrics(w))).map((w) => w.window)).toEqual([
      "since_2019_05",
      "since_2023",
      "trailing_12m",
      "live",
    ]);
    expect(orderedWindows([mapWindowMetrics({ window: "since_2023" })]).map((w) => w.window)).toEqual(["since_2023"]);
  });
});

describe("the display thresholds (5.8)", () => {
  it("shows CAGR at 365 calendar days, and not at 364", () => {
    expect(CAGR_MIN_CALENDAR_DAYS).toBe(365);
    expect(cagrShown(win({ calendarDays: 365 }))).toBe(true);
    expect(cagrShown(win({ calendarDays: 364 }))).toBe(false);
  });

  it("shows no CAGR when the API states none", () => {
    expect(cagrShown(win({ calendarDays: 800, hasCagr: false }))).toBe(false);
  });

  it("shows Sharpe at 126 daily returns (127 sessions), and not at 125 returns", () => {
    expect(SHARPE_MIN_RETURNS).toBe(126);
    expect(sharpeShown(win({ sessions: 127 }))).toBe(true);
    expect(sharpeShown(win({ sessions: 126 }))).toBe(false);
  });
});

describe("the indexing rule (10.9)", () => {
  it("indexes a published run with at least 60 sessions in its full window", () => {
    expect(INDEXABLE_BACKTEST_MIN_SESSIONS).toBe(60);
    const windows = [win({ window: "since_2019_05", sessions: 60 })];
    expect(isIndexableBacktest("published", windows)).toBe(true);
    expect(isIndexableBacktest("published", [win({ window: "since_2019_05", sessions: 59 })])).toBe(false);
  });

  it("never indexes a state card, however long its window", () => {
    const windows = [win({ window: "since_2019_05", sessions: 900 })];
    for (const state of ["run_required", "running", "not_computable", "unavailable"]) {
      expect(isIndexableBacktest(state, windows)).toBe(false);
    }
  });
});
