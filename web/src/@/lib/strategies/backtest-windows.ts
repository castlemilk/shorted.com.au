// The four chained windows of a backtest (design 5.8) and the display rules that
// go with them. Pure: no React, so the thresholds are tested on their own.
//
// The ids are design 8.2's (`since_2019_05`, `since_2023`, `trailing_12m`,
// `live`); the labels are the page's. The API computes every figure and states
// whether it applies (has_cagr, has_sharpe). The thresholds here are the page's
// own second reading of the same rules, so a figure is never printed under its
// minimum even if a field arrives set: CAGR needs at least 365 calendar days,
// Sharpe at least 126 daily returns.

import type { BacktestWindowId, BacktestWindowView } from "./map-backtest";

export type { BacktestWindowId };

export const BACKTEST_WINDOWS: ReadonlyArray<{
  id: BacktestWindowId;
  label: string;
}> = [
  { id: "since_2019_05", label: "Since May 2019" },
  { id: "since_2023", label: "Since 2023" },
  { id: "trailing_12m", label: "Last 12 months" },
  { id: "live", label: "Live since freeze" },
];

/** The window every surface opens on (5.8, the default). */
export const DEFAULT_BACKTEST_WINDOW: BacktestWindowId = "since_2019_05";

/** The query parameter a window is named by, e.g. `?window=since_2023`. */
export const BACKTEST_WINDOW_PARAM = "window";

/** A window's id from a query value, or the default for an unknown or missing one. */
export function windowFromParam(value: string | null | undefined): BacktestWindowId {
  return BACKTEST_WINDOWS.find((w) => w.id === value)?.id ?? DEFAULT_BACKTEST_WINDOW;
}

/** The window's name as the page prints it. */
export function windowLabel(id: string): string {
  return BACKTEST_WINDOWS.find((w) => w.id === id)?.label ?? id;
}

/** CAGR is annualised only over at least this many calendar days (5.8). */
export const CAGR_MIN_CALENDAR_DAYS = 365;
/** Sharpe needs at least this many daily returns (5.8). */
export const SHARPE_MIN_RETURNS = 126;

/** Whether a window's CAGR may be printed: a figure exists and the window is a year or more. */
export function cagrShown(window: BacktestWindowView): boolean {
  return window.cagrPct !== null && window.calendarDays >= CAGR_MIN_CALENDAR_DAYS;
}

/** Whether a window's Sharpe ratio may be printed: a figure exists and there are enough returns. */
export function sharpeShown(window: BacktestWindowView): boolean {
  return window.sharpe !== null && window.sessions - 1 >= SHARPE_MIN_RETURNS;
}

/**
 * The windows a run carries, in window order, keeping only the four this page
 * knows. A window the API did not send is absent, never invented.
 */
export function orderedWindows(
  windows: readonly BacktestWindowView[],
): BacktestWindowView[] {
  return BACKTEST_WINDOWS.flatMap(({ id }) => {
    const found = windows.find((w) => w.window === id);
    return found ? [found] : [];
  });
}

/** The sessions a run must carry in its since-May-2019 window before its backtest page is indexed (10.9). */
export const INDEXABLE_BACKTEST_MIN_SESSIONS = 60;

/**
 * Whether a strategy's backtest page is indexable: a published (or approximate) run
 * whose since-May-2019 window carries at least 60 sessions. The page's robots
 * directive and the sitemap both read this one rule.
 */
export function isIndexableBacktest(
  state: string,
  windows: readonly BacktestWindowView[],
): boolean {
  if (state !== "published" && state !== "approximate") return false;
  const full = windows.find((w) => w.window === "since_2019_05");
  return (full?.sessions ?? 0) >= INDEXABLE_BACKTEST_MIN_SESSIONS;
}
