/**
 * Single source of truth for chart colors. Structural colors use CSS variables
 * so dark/light parity is automatic; semantic series roles keep the established
 * short=rust / price=blue identity, centralized here. Short interest is the
 * chart rust (DESIGN.md §2), not a red: true red and green are quarantined for
 * the direction of a number, and a falling price is drawn in that red.
 */
export const chartTheme = {
  axis: "hsl(var(--muted-foreground))",
  axisLabel: "hsl(var(--muted-foreground))",
  grid: "hsl(var(--border))",
  crosshair: "hsl(var(--foreground))",
  tooltipBg: "hsl(var(--popover))",
  tooltipFg: "hsl(var(--popover-foreground))",
  volume: "hsl(var(--muted-foreground))",
  // Volume is a bar per session, thinner than the area it replaced, so a touch
  // stronger to read as much; the bar under a reading stronger again.
  volumeOpacity: 0.26,
  volumeActiveOpacity: 0.6,
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
  if (role === "short") return "#D16A47";
  if (role === "price") return "#3b82f6";
  if (role === "volume") return "#94a3b8";
  return SERIES_PALETTE[index % SERIES_PALETTE.length]!;
}

/**
 * Indicator lines, drawn from the theme's own tokens (DESIGN.md's "Two Rooms
 * Rule"). `--primary` is burnt amber ink on warm paper and phosphor amber on CRT
 * black, so the amber lines read on both (a fixed #FFA94D measures 1.5:1 on
 * paper). `--secondary` is avocado on paper and sage on CRT. Where a hue repeats,
 * the dash tells the lines apart. Never the signal red or green (they mean the
 * direction of a number), never the price blue, and never the clay rust
 * (`--accent`, the short series' colour on the light theme) on the price axis.
 * Short interest's averages are the series' own rust, dashed (30 days) or dotted
 * (90).
 */
export const INDICATOR_COLORS = {
  sma20: "hsl(var(--primary))",
  sma50: "hsl(var(--secondary))",
  ema20: "hsl(var(--secondary))",
  wma20: "hsl(var(--muted-foreground))",
  sma200: "hsl(var(--foreground) / 0.7)",
  bollinger: "hsl(var(--muted-foreground))",
  shortAverage: seriesColor("short"),
  rsi: "hsl(var(--primary))",
  macd: "hsl(var(--primary))",
  macdSignal: "hsl(var(--muted-foreground))",
} as const;
