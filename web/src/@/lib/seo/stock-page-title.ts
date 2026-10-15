/**
 * The stock Overview's <title>, before the root template appends " | Shorted".
 *
 * Kept under Google's ~60-character display width: the old form,
 * "4DX Short Interest — 4Dmedical (ASX:4DX) | 10.91% Shorted | Shorted"
 * (about 70 characters), was cut off in results, and Search Console showed
 * stock pages at positions 3-4 with click-through under 1% (LOT, 15 Oct 2026).
 * The code and "Short Interest" lead because that is how the per-ticker
 * queries are phrased ("4dx short interest", "droneshield short interest").
 */
export function stockPageTitle(
  code: string,
  companyName: string,
  percent: string | null,
): string {
  const level = percent ? `: ${percent}%` : "";
  return companyName
    ? `${code} Short Interest${level} (${companyName}, ASX)`
    : `${code} Short Interest${level} | ASX Short Position Data`;
}
