// ASIC report dates are Sydney calendar days — format them in that zone so a
// UTC-hosted render can't show the previous day.
export function formatAsOfDate(date: Date): string {
  return date.toLocaleDateString("en-AU", {
    day: "numeric",
    month: "short",
    year: "numeric",
    timeZone: "Australia/Sydney",
  });
}

/** The "as of" clause shared by the summary and the schema. Never `new Date()`. */
export function asOfClauseFor(date: Date | null): string {
  return date ? `as of ${formatAsOfDate(date)}` : "in the latest ASIC report";
}

/**
 * Days after which a stock's latest ASIC report no longer describes it. ASIC
 * lists every reportable short position daily, so a stock missing for 90 days
 * is delisted or has had no reportable position for a quarter.
 */
export const STALE_SHORT_DATA_DAYS = 90;

/** True when the latest report containing the stock is older than {@link STALE_SHORT_DATA_DAYS}. */
export function isStaleShortDate(date: Date | null, now: Date = new Date()): boolean {
  if (!date) return false;
  return now.getTime() - date.getTime() > STALE_SHORT_DATA_DAYS * 86_400_000;
}
