import { formatCompanyName } from "~/@/lib/company-name";

/** ASX codes are 1-4 alphanumerics. Checked before any fetch. */
export const STOCK_CODE_PATTERN = /^[A-Z0-9]{1,4}$/;

// Display name for every SEO-critical surface (title, og:title, h1, crawler
// summary, schema). `stock.name` is the raw ASIC PRODUCT string — SHOUTED,
// with a security-type descriptor — so it goes through the shared formatter.
export function cleanCompanyName(name: string, code: string): string {
  return formatCompanyName(name, code) || name;
}

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
