/**
 * Format a dividend yield whose stored unit convention is unreliable.
 *
 * Historical mess: yfinance's `dividendYield` switched from a fraction
 * (CBA = 0.032) to a percent (CBA = 3.2) in 2024-25, and one ingestion path
 * (analysis/enrich_database.py → financial_statements.info.dividend_yield)
 * kept an unconditional ×100 from the fraction era — so the database holds a
 * mix of fractions (0.032), percents (3.2), and double-scaled percents (320).
 *
 * Normalization rules:
 * - value <= 1        → treat as fraction, multiply by 100 (0.032 → 3.20%)
 * - 1 < value <= 100  → treat as percent already          (3.2   → 3.20%)
 * - value > 100       → clearly double-scaled, divide by 100 (320 → 3.20%)
 * - still > 100 after undoing one scaling → garbage; render nothing.
 *
 * Returns null (render nothing) for null/undefined, non-numeric, zero,
 * negative, or implausible (> 100% after normalization) values.
 */
export function formatDividendYield(
  value: number | string | null | undefined,
): string | null {
  if (value === null || value === undefined) return null;
  const num =
    typeof value === "number" ? value : parseFloat(String(value).trim());
  if (!Number.isFinite(num) || num <= 0) return null;

  let percent = num <= 1 ? num * 100 : num;
  if (percent > 100) percent /= 100;
  if (percent > 100) return null;

  return `${percent.toFixed(2)}%`;
}
