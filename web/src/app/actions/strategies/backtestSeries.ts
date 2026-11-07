"use server";

// The Daily/Weekly toggle of the Backtest tab: the live version's published run at
// the requested resolution. The read is the same cached public read the page uses
// (getBacktestRun), so a toggle costs one cache lookup after its first answer. It
// takes a strategy id and a resolution only, never a run id or a viewer, and it
// returns the series alone; the API says which resolution it served, and the
// panel labels it so (daily is served for windows of 500 sessions or fewer).

import { getBacktestRun, type BacktestResolution } from "./getBacktestRun";
import type { SeriesPointView } from "~/@/lib/strategies/map-backtest";

const STRATEGY_ID = /^[a-z0-9-]{1,64}$/;

export interface BacktestSeriesResult {
  series: SeriesPointView[];
  seriesResolution: string;
}

export async function loadBacktestSeries(
  strategyId: string,
  resolution: BacktestResolution,
): Promise<BacktestSeriesResult | null> {
  if (typeof strategyId !== "string" || !STRATEGY_ID.test(strategyId)) return null;
  if (resolution !== "weekly" && resolution !== "daily") return null;
  const run = await getBacktestRun(strategyId, resolution);
  if (!run || run.series.length === 0) return null;
  return { series: run.series, seriesResolution: run.seriesResolution };
}
