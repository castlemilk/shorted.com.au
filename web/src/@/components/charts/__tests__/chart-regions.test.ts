import { regionPaint } from "../chart-regions";

describe("regionPaint", () => {
  it("keeps the divergence pair's fixed fills, so existing charts paint unchanged", () => {
    expect(regionPaint("bearish")).toEqual({ fill: "#ef4444", fillOpacity: 0.1 });
    expect(regionPaint("bullish")).toEqual({ fill: "#22c55e", fillOpacity: 0.1 });
  });

  it("paints the live tone with a theme token, never a fixed red or green", () => {
    const paint = regionPaint("live");
    expect(paint.cssFill).toBe("hsl(var(--primary) / 0.06)");
    expect(paint.fill).toBeUndefined();
    expect(JSON.stringify(paint)).not.toMatch(/#ef4444|#22c55e/);
  });
});
