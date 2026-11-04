"use server";

import {
  getStockStrategyFit,
  type StockStrategyFit,
} from "./getStockStrategyFit";

/**
 * One stock's reading for the Signals tab's evidence panel: the same public
 * GetStockStrategyFit the stock page's Strategy tab reads, cached the same way.
 * A failed read is null, so the panel says it is unavailable and the rest of the
 * tab stays on screen. Only the stock code crosses in.
 */
export async function getSignalStockFit(
  stockCode: string,
): Promise<StockStrategyFit | null> {
  try {
    return await getStockStrategyFit(stockCode);
  } catch (err) {
    console.warn("[getSignalStockFit] unavailable:", err);
    return null;
  }
}
