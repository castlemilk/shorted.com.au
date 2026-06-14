/**
 * Single source of truth for chart colors. Structural colors use CSS variables
 * so dark/light parity is automatic; semantic series roles keep the established
 * short=red / price=blue identity, centralized here.
 */
export const chartTheme = {
  axis: "hsl(var(--muted-foreground))",
  axisLabel: "hsl(var(--muted-foreground))",
  grid: "hsl(var(--border))",
  crosshair: "hsl(var(--foreground))",
  tooltipBg: "hsl(var(--popover))",
  tooltipFg: "hsl(var(--popover-foreground))",
  volume: "hsl(var(--muted-foreground))",
  volumeOpacity: 0.18,
} as const;

const SERIES_PALETTE = [
  "#3b82f6",
  "#ef4444",
  "#22c55e",
  "#a855f7",
  "#f59e0b",
  "#06b6d4",
  "#ec4899",
  "#84cc16",
  "#6366f1",
  "#f97316",
] as const;

/** Stable color for a semantic role; for "series" use the palette index (wraps). */
export function seriesColor(
  role: "short" | "price" | "volume" | "series",
  index = 0,
): string {
  if (role === "short") return "#ef4444";
  if (role === "price") return "#3b82f6";
  if (role === "volume") return "#94a3b8";
  return SERIES_PALETTE[index % SERIES_PALETTE.length]!;
}
