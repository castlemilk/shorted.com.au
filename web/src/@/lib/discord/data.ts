import { getLatestShortDate } from "~/app/actions/getLatestShortDate";
import { getStock } from "~/app/actions/getStock";
import { getTopShortsSummary } from "~/app/actions/getTopShorts";
import { searchStocks } from "~/app/actions/searchStocks";
import { withTimeout } from "~/app/chart/[code]/image/chart-data";
import { getShortInterestDeltas } from "~/app/shorts/[stockCode]/short-interest-summary";
import { formatCompanyName } from "~/@/lib/company-name";
import { filterEligibleTopShorts } from "~/@/lib/top-shorts-filter";
import type { StockHit, StockSummary } from "./messages";

/**
 * What the bot reads, through the same server actions the pages use: the
 * same caches (unstable_cache, the edge reads, the KV layer) and the same
 * first-party fetch, so a burst of Discord traffic lands on warm entries and
 * is never bucketed as an anonymous scraper at the edge.
 *
 * Every read is bounded. The endpoint answers inside Discord's 3-second
 * window when it can and finishes in the background when it cannot (see
 * handler.ts), so a slow read costs a "thinking…" state, never a failed
 * interaction, and a read that never returns is given up on here.
 */
export interface DiscordData {
  /** null when the stock is unknown or could not be read. */
  stockSummary(code: string): Promise<StockSummary | null>;
  search(query: string, limit: number): Promise<StockHit[]>;
  topShorts(count: number): Promise<StockHit[]>;
}

/** Long enough for a cold cache, short of the function's maxDuration. */
const READ_TIMEOUT_MS = 6000;

const positive = (v: number | undefined): number | undefined =>
  typeof v === "number" && Number.isFinite(v) && v > 0 ? v : undefined;

export const discordData: DiscordData = {
  async stockSummary(code) {
    const [stock, deltas, asOf] = await Promise.all([
      withTimeout(getStock(code), READ_TIMEOUT_MS, undefined),
      withTimeout(getShortInterestDeltas(code), READ_TIMEOUT_MS, null),
      withTimeout(getLatestShortDate(code), READ_TIMEOUT_MS, null),
    ]);
    if (!stock?.productCode) return null;
    return {
      code,
      name: stock.name ? formatCompanyName(stock.name, code) : undefined,
      industry: stock.industry || undefined,
      shortPct: positive(stock.percentageShorted),
      reportedShorts: positive(stock.reportedShortPositions),
      sharesOnIssue: positive(stock.totalProductInIssue),
      daysToCover: positive(stock.daysToCover),
      marketCap: positive(stock.marketCap),
      change30d: deltas?.change30d ?? null,
      asOf,
    };
  },

  async search(query, limit) {
    const response = await withTimeout(
      searchStocks(query, limit),
      READ_TIMEOUT_MS,
      null,
    );
    return (response?.stocks ?? [])
      .filter((s) => s.productCode)
      .map((s) => ({
        code: s.productCode.toUpperCase(),
        name: formatCompanyName(s.name, s.productCode),
        shortPct: positive(s.percentageShorted),
        industry: s.industry || undefined,
      }));
  },

  async topShorts(count) {
    // Over-fetch: the eligibility filter (no ETFs, no coupon-bearing lines)
    // drops a few, as it does on /top.
    const response = await withTimeout(
      getTopShortsSummary("3m", count + 15),
      READ_TIMEOUT_MS,
      undefined,
    );
    return filterEligibleTopShorts(response?.timeSeries ?? [])
      .filter((s) => positive(s.latestShortPosition) !== undefined)
      .sort((a, b) => b.latestShortPosition - a.latestShortPosition)
      .slice(0, count)
      .map((s) => ({
        code: s.productCode.toUpperCase(),
        name: formatCompanyName(s.name, s.productCode),
        shortPct: s.latestShortPosition,
        industry: s.industry || undefined,
      }));
  },
};
