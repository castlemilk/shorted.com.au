"use server";

// The window and Daily/Weekly controls of the Backtest tab: the live version's published
// run's series for the requested window and resolution. The read is the same cached
// public read the page uses (getBacktestRun), so a control costs one cache lookup after
// its first answer. It takes a strategy id, a resolution and a window only, never a run
// id or a viewer, and it returns the series the API served and which resolution it is.

import {
  getBacktestRun,
  type BacktestResolution,
  type BacktestWindowRequest,
} from "./getBacktestRun";
import type { SeriesPointView } from "~/@/lib/strategies/map-backtest";

const STRATEGY_ID = /^[a-z0-9-]{1,64}$/;

export interface BacktestSeriesResult {
  series: SeriesPointView[];
  seriesResolution: string;
  windowId: string;
}

const WINDOWS: readonly BacktestWindowRequest[] = [
  "since_2019_05",
  "since_2023",
  "trailing_12m",
  "live",
];

export async function loadBacktestSeries(
  strategyId: string,
  resolution: BacktestResolution,
  window: BacktestWindowRequest,
): Promise<BacktestSeriesResult | null> {
  if (typeof strategyId !== "string" || !STRATEGY_ID.test(strategyId)) return null;
  if (resolution !== "weekly" && resolution !== "daily") return null;
  if (!WINDOWS.includes(window)) return null;
  const run = await getBacktestRun(strategyId, resolution, window);
  if (!run) return null;
  return {
    series: run.series,
    seriesResolution: run.seriesResolution,
    windowId: run.windowId,
  };
}
