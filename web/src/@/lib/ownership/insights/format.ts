/**
 * How the insights explorer prints its figures. Every helper prints n/a for a
 * figure it is not given, a true minus (U+2212) for a negative, and a plus for
 * a rise, so a change always says which way it went. AUD is written with `$`
 * only (DESIGN.md, The Tabular Rule).
 */

import { formatAmount, formatPct } from "~/@/lib/fundamentals/format";
import { industryLabel } from "~/@/lib/industry-placeholder";

const MINUS = "−";

/** The sector as printed: the industry, or Other for none or a placeholder. */
export function sectorLabel(sector: string): string {
  return industryLabel(sector) || "Other";
}

/** An AUD amount, compact: "$4.29B", "n/a". */
export function formatAud(value: number | null | undefined): string {
  return formatAmount(value, "AUD");
}

/** A signed AUD change: "+$400.0M", "−$100.0M", "$0", "n/a". */
export function formatSignedAud(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value)) return "n/a";
  const text = formatAmount(value, "AUD");
  return value > 0 && !/^\$0(?:\.0+)?$/.test(text) ? `+${text}` : text;
}

/** A signed percentage change: "+10.0%", "−3.2%", "n/a". */
export function formatSignedPct(value: number | null | undefined, digits = 1): string {
  return formatPct(value, { signed: true, digits });
}

/** A change in percentage points, as a notice states it: "+1.00 pp", "−0.31 pp", "0.00 pp". */
export function formatPp(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value)) return "n/a";
  if (Math.abs(value) < 0.005) return "0.00 pp";
  return `${value > 0 ? "+" : MINUS}${Math.abs(value).toFixed(2)} pp`;
}

/** A count with its noun: "1 notice", "3 notices". */
export function counted(n: number, one: string, many: string): string {
  return `${n.toLocaleString("en-AU")} ${n === 1 ? one : many}`;
}

/** Days between two YYYY-MM-DD dates, inclusive of neither: 2026-10-01 to 2026-10-31 is 30. */
export function daysBetween(from: string, to: string): number {
  return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000);
}

/** The date `days` after a YYYY-MM-DD date. */
export function addDays(date: string, days: number): string {
  const t = new Date(Date.parse(`${date}T00:00:00Z`) + days * 86_400_000);
  return t.toISOString().slice(0, 10);
}

/** The same day `months` later, held to the month's last day: 2026-01-31 plus one month is 2026-02-28. */
export function addMonths(date: string, months: number): string {
  const [y, m, d] = date.split("-").map(Number) as [number, number, number];
  const target = new Date(Date.UTC(y, m - 1 + months, 1));
  const last = new Date(Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0)).getUTCDate();
  target.setUTCDate(Math.min(d, last));
  return target.toISOString().slice(0, 10);
}

/**
 * A bucket's column label, short enough for a heatmap header: a week is its
 * first day as MM-DD, a month is YYYY-MM. Its full dates travel in its title.
 */
export function bucketLabel(start: string, kind: "week" | "month" | ""): string {
  if (start.length !== 10) return start;
  return kind === "month" ? start.slice(0, 7) : start.slice(5);
}

/** A window as a sentence: "2026-08-03 to 2026-10-31". */
export function windowText(from: string, to: string): string {
  if (!from || !to) return "n/a";
  return from === to ? from : `${from} to ${to}`;
}

/** The caption every disclosed sum carries. */
export const DISCLOSED_CAPTION = "what the notices disclose, not a share of the company";
