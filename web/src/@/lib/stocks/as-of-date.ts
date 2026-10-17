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
