import { chartTheme, seriesColor } from "../chart-theme";

describe("chart-theme", () => {
  it("exposes structural colors via CSS variables (theme-adaptive)", () => {
    expect(chartTheme.axis).toContain("var(--");
    expect(chartTheme.grid).toContain("var(--");
    expect(chartTheme.tooltipBg).toContain("var(--");
  });
  it("maps semantic series roles to stable colors", () => {
    expect(seriesColor("short")).toBe("#ef4444");
    expect(seriesColor("price")).toBe("#3b82f6");
    expect(seriesColor("series", 0)).toMatch(/^#/);
    expect(seriesColor("series", 99)).toMatch(/^#/); // wraps, never undefined
  });
});
