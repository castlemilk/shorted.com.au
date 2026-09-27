// Display formatters for the stock picker. Pure functions, no imports, safe
// on both sides of the RSC boundary.
//
// House rules: null renders "n/a" (never 0 and never a dash); negative numbers
// use a true minus sign so signed columns align; every caller renders the
// result inside a tabular-nums cell.

export const NOT_AVAILABLE = "n/a";

const MINUS = "−";

function finite(value: number | null | undefined): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

/**
 * "$12.34". Always two decimals: prices are stored as DECIMAL(10,2), so a
 * third digit would be precision the data does not have.
 */
export function formatPrice(value: number | null | undefined): string {
  if (!finite(value) || value <= 0) return NOT_AVAILABLE;
  return `$${value.toLocaleString("en-AU", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;
}

/** Index level with a thousands separator: "8,812.3". */
export function formatIndexLevel(value: number | null | undefined): string {
  if (!finite(value) || value <= 0) return NOT_AVAILABLE;
  return value.toLocaleString("en-AU", {
    minimumFractionDigits: 1,
    maximumFractionDigits: 1,
  });
}

/** Signed with a leading "+" or a true minus: "+41.2%", "−3.0%". */
export function formatSigned(
  value: number | null | undefined,
  suffix = "%",
  digits = 1,
): string {
  if (!finite(value)) return NOT_AVAILABLE;
  const rounded = Number(value.toFixed(digits));
  if (rounded === 0) return `${(0).toFixed(digits)}${suffix}`;
  const sign = rounded > 0 ? "+" : MINUS;
  return `${sign}${Math.abs(rounded).toFixed(digits)}${suffix}`;
}

/** Unsigned percentage: "12.40%". */
export function formatPct(value: number | null | undefined, digits = 1): string {
  if (!finite(value)) return NOT_AVAILABLE;
  return `${value.toFixed(digits)}%`;
}

/** Volume multiple: "2.1×". */
export function formatMultiple(value: number | null | undefined): string {
  if (!finite(value) || value <= 0) return NOT_AVAILABLE;
  return `${value.toFixed(1)}×`;
}

/** Whole-number score, 0-100. */
export function formatScore(value: number | null | undefined): string {
  if (!finite(value)) return NOT_AVAILABLE;
  return Math.round(value).toString();
}

/** Percentage change of a level against a reference (close vs an average). */
export function pctVersus(
  value: number | null | undefined,
  reference: number | null | undefined,
): number | null {
  if (!finite(value) || !finite(reference) || reference <= 0 || value <= 0) {
    return null;
  }
  return (value / reference - 1) * 100;
}

/**
 * "27 September 2026" from "2026-09-27". Formatted in UTC so the date cannot
 * slip a day in a timezone behind UTC. Returns "" for an empty or invalid
 * input so callers can omit the clause entirely.
 */
export function formatIsoDate(iso: string | null | undefined): string {
  if (!iso) return "";
  const parsed = new Date(`${iso.slice(0, 10)}T00:00:00Z`);
  if (Number.isNaN(parsed.getTime())) return "";
  return parsed.toLocaleDateString("en-AU", {
    day: "numeric",
    month: "long",
    year: "numeric",
    timeZone: "UTC",
  });
}

/** Thousands-separated integer: "2,314". */
export function formatCount(value: number): string {
  return Math.round(value).toLocaleString("en-AU");
}

/**
 * The first non-empty string, or "". For API strings where proto3 sends ""
 * for "absent", so `??` would keep the empty value.
 */
export function firstNonEmpty(...values: Array<string | null | undefined>): string {
  for (const value of values) {
    if (typeof value === "string" && value.length > 0) return value;
  }
  return "";
}

const DATA_SOURCE_LABELS: Record<string, string> = {
  stock_fundamentals: "Company fundamentals",
  stock_prices: "Daily prices",
  index_prices: "S&P/ASX 200 index",
  asic_shorts: "ASIC short positions",
};

/** Reader-facing label for a rule's data_source id. */
export function dataSourceLabel(id: string): string {
  return DATA_SOURCE_LABELS[id] ?? id.replace(/_/g, " ");
}

/** "S&P/ASX 200 (XJO)" for the index the regime is read from. */
export function indexLabel(code: string): string {
  const normalised = (code || "XJO").toUpperCase();
  return normalised === "XJO" ? "S&P/ASX 200 (XJO)" : normalised;
}
