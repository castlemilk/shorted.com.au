import { chartTheme, INDICATOR_COLORS, seriesColor } from "../chart-theme";
import { CHART_TOKENS, SEMANTIC_TOKENS } from "~/@/lib/design-tokens";

describe("chart-theme", () => {
  it("exposes structural colors via CSS variables (theme-adaptive)", () => {
    expect(chartTheme.axis).toContain("var(--");
    expect(chartTheme.grid).toContain("var(--");
    expect(chartTheme.tooltipBg).toContain("var(--");
  });

  // DESIGN.md §2: true red and green mean the direction of a number and nothing
  // else; chart series use the warm palette. Short interest is the rust.
  it("draws short interest in the chart rust, never in a direction red", () => {
    const rust = CHART_TOKENS.find((t) => t.name === "red")!.light;
    expect(rust).toBe("#D16A47");
    expect(seriesColor("short")).toBe(rust);
    const semantic = SEMANTIC_TOKENS.flatMap((t) => [t.light, t.dark]).map((c) => c.toLowerCase());
    expect(semantic).not.toContain(seriesColor("short").toLowerCase());
  });

  // Indicator lines never borrow a direction colour or the price blue; short
  // interest's averages are the series' own rust.
  it("draws indicator lines in colours that carry no direction", () => {
    const directional = ["#ef4444", "#22c55e", "#f87171", "#4ade80", "#3b82f6"];
    for (const color of Object.values(INDICATOR_COLORS)) {
      expect(directional).not.toContain(color.toLowerCase());
    }
    expect(INDICATOR_COLORS.shortAverage).toBe(seriesColor("short"));
  });

  // The theme's own tokens, so each line reads on warm paper and on CRT black
  // (DESIGN.md, "Two Rooms Rule"). The short series' rust is the one exception,
  // for the short averages.
  it("draws indicator lines from the theme's tokens, or the short series' own rust", () => {
    const token = /^hsl\(var\(--(primary|secondary|foreground|muted-foreground)\)( \/ 0\.\d+)?\)$/;
    for (const color of Object.values(INDICATOR_COLORS)) {
      expect(color === seriesColor("short") || token.test(color)).toBe(true);
    }
  });

  // A price-axis line sits beside the short line in Combined, so it must not
  // read as the short series: never the short rust, never the clay rust token.
  it("never draws a price-axis indicator in the short series' rust or the clay rust token", () => {
    const priceAxis = [
      INDICATOR_COLORS.sma20,
      INDICATOR_COLORS.sma50,
      INDICATOR_COLORS.ema20,
      INDICATOR_COLORS.wma20,
      INDICATOR_COLORS.sma200,
      INDICATOR_COLORS.bollinger,
    ];
    for (const color of priceAxis) {
      expect(color).not.toBe(seriesColor("short"));
      expect(color).not.toContain("--accent");
    }
  });

  it("maps semantic series roles to stable colors", () => {
    expect(seriesColor("price")).toBe("#3b82f6");
    expect(seriesColor("series", 0)).toMatch(/^#/);
    expect(seriesColor("series", 99)).toMatch(/^#/); // wraps, never undefined
  });
});
