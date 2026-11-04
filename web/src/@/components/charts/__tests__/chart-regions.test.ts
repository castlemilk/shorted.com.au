import { regionLabelShown, regionPaint } from "../chart-regions";

describe("regionPaint", () => {
  it("keeps the divergence pair's fixed fills, so existing charts paint unchanged", () => {
    expect(regionPaint("bearish")).toEqual({
      fill: "#ef4444",
      fillOpacity: 0.1,
    });
    expect(regionPaint("bullish")).toEqual({
      fill: "#22c55e",
      fillOpacity: 0.1,
    });
  });

  it("paints the live tone with a theme token, never a fixed red or green", () => {
    const paint = regionPaint("live");
    expect(paint.cssFill).toBe("hsl(var(--primary) / 0.06)");
    expect(paint.fill).toBeUndefined();
    expect(JSON.stringify(paint)).not.toMatch(/#ef4444|#22c55e/);
  });
});

describe("regionLabelShown", () => {
  it("writes the live band's label on the band when it fits", () => {
    // 20 characters at 6px, plus 12px of padding, in a 200px band.
    expect(regionLabelShown("live", "Recorded since 2026-01-01", 200)).toBe(
      true,
    );
  });

  it("leaves the label as a title only when the band is too narrow for it", () => {
    expect(regionLabelShown("live", "Recorded since 2026-01-01", 100)).toBe(
      false,
    );
  });

  it("never writes a divergence band's label on it", () => {
    expect(regionLabelShown("bearish", "Shorts up", 500)).toBe(false);
    expect(regionLabelShown("bullish", "Shorts down", 500)).toBe(false);
  });

  it("writes nothing for a region with no label", () => {
    expect(regionLabelShown("live", undefined, 500)).toBe(false);
  });
});
