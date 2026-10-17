import { chartTheme, seriesColor } from "../chart-theme";
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

  it("maps semantic series roles to stable colors", () => {
    expect(seriesColor("price")).toBe("#3b82f6");
    expect(seriesColor("series", 0)).toMatch(/^#/);
    expect(seriesColor("series", 99)).toMatch(/^#/); // wraps, never undefined
  });
});
