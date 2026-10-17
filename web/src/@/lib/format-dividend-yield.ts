/**
 * Format a dividend yield.
 *
 * Pass the unit whenever the caller knows it: `"fraction"` (0.032 = 3.2%) or
 * `"percent"` (3.2 = 3.2%). Only then is the figure read without guessing.
 *
 * Historical mess, and why "auto" exists: yfinance's `dividendYield` switched
 * from a fraction (CBA = 0.032) to a percent (CBA = 3.2) in 2024-25, and one
 * ingestion path (analysis/enrich_database.py -> financial_statements.info.
 * dividend_yield) kept an unconditional x100 from the fraction era, so the
 * stored info block holds a mix of fractions (0.032), percents (3.2), and
 * double-scaled percents (320).
 *
 * "auto" rules (the default, for that legacy field only):
 * - value < 0.25        -> a fraction (0.032 -> 3.20%). A fraction of 0.25 or
 *                          more would be a 25%+ yield, which no ASX company
 *                          sustains, so those values are percents instead.
 * - 0.25 <= value <= 100 -> a percent already (0.8 -> 0.80%, 3.2 -> 3.20%).
 *                          The old `<= 1` cut read a genuine 0.8% yield as 80%.
 * - value > 100         -> double-scaled, divide by 100 (320 -> 3.20%)
 * - still > 100 after undoing one scaling -> garbage; render nothing.
 *
 * Returns null (render nothing) for null/undefined, non-numeric, zero,
 * negative, or implausible (> 100% after normalization) values.
 */
export type DividendYieldUnit = "fraction" | "percent" | "auto";

/** Below this an "auto" value is read as a fraction (a < 25% yield). */
const AUTO_FRACTION_BELOW = 0.25;

export function formatDividendYield(
  value: number | string | null | undefined,
  unit: DividendYieldUnit = "auto",
): string | null {
  if (value === null || value === undefined) return null;
  const num =
    typeof value === "number" ? value : parseFloat(String(value).trim());
  if (!Number.isFinite(num) || num <= 0) return null;

  let percent: number;
  if (unit === "fraction") {
    percent = num * 100;
  } else if (unit === "percent") {
    percent = num;
  } else {
    percent = num < AUTO_FRACTION_BELOW ? num * 100 : num;
    if (percent > 100) percent /= 100;
  }
  if (percent > 100) return null;

  return `${percent.toFixed(2)}%`;
}
