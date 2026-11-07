"use server";

import {
  getStockStrategyFit,
  type StockStrategyFit,
} from "./getStockStrategyFit";

const STOCK_CODE = /^[A-Z0-9]{1,6}$/;

/**
 * One stock's reading for the Signals tab's evidence panel: the same public
 * GetStockStrategyFit the stock page's Strategy tab reads, cached the same way.
 * A failed read is null, so the panel says it is unavailable and the rest of the
 * tab stays on screen. Only the stock code crosses in.
 */
export async function getSignalStockFit(
  stockCode: string,
): Promise<StockStrategyFit | null> {
  // A public action: the code is checked here, not only by the client, so a
  // malformed value never costs a backend call (the API's InvalidArgument is
  // not cached and would repeat on every call).
  if (typeof stockCode !== "string") return null;
  const code = stockCode.trim().toUpperCase();
  if (!STOCK_CODE.test(code)) return null;
  try {
    return await getStockStrategyFit(code);
  } catch (err) {
    console.warn("[getSignalStockFit] unavailable:", err);
    return null;
  }
}
