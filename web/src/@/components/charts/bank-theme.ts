/**
 * Fixed bank-identity colors for the big-four short comparison. Kept separate
 * from chart-theme.ts (whose seriesColor stays the short=red / price=blue source
 * of truth) so these brand hues don't leak into the generic series palette.
 * Hues chosen for max separation on the dark editorial canvas.
 */
export const BANK_COLORS: Record<string, string> = {
  CBA: "#2563eb", // blue
  NAB: "#10b981", // green
  WBC: "#8b5cf6", // violet
  ANZ: "#06b6d4", // cyan
};

const FALLBACK = ["#f59e0b", "#ec4899", "#84cc16", "#6366f1", "#f97316"] as const;

/** Stable color for a bank code; deterministic palette fallback for unknown codes. */
export function bankColor(code: string, index = 0): string {
  return BANK_COLORS[code] ?? FALLBACK[index % FALLBACK.length]!;
}

// Categorical palette for arbitrary basket members (lithium, iron ore, …).
// Deliberately avoids amber — that hue is the RECORD reference line.
const BASKET_PALETTE = [
  "#2563eb", // blue
  "#10b981", // green
  "#8b5cf6", // violet
  "#06b6d4", // cyan
  "#f43f5e", // rose
  "#84cc16", // lime
] as const;

/**
 * Stable color for a basket member: known bank identity colors win, otherwise a
 * deterministic palette slot by the member's canonical index.
 */
export function basketColor(code: string, index = 0): string {
  return BANK_COLORS[code] ?? BASKET_PALETTE[index % BASKET_PALETTE.length]!;
}
