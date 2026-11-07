import { boxesOverlap, labelBox, placeLabel, CHART_LABEL_ROW_PX } from "../chart-labels";

describe("in-plot label placement", () => {
  it("estimates a box from the text's length and the 11px mono advance", () => {
    const box = labelBox("abcd", 100, 20, "end");
    expect(box.x1).toBeCloseTo(100 + 3, 5);
    expect(box.x0).toBeCloseTo(100 - 4 * 6.6 - 3, 5);
    expect(box.y0).toBe(20 - 9 - 3);
    expect(box.y1).toBe(20 + 3 + 3);
  });

  it("keeps a label on its first row when nothing is taken", () => {
    const placed = placeLabel("Recorded since 5 Nov", 300, "end", 24, CHART_LABEL_ROW_PX, 200, []);
    expect(placed.y).toBe(24);
  });

  it("stacks a right-edge label down until it clears the recorded label at 1280 and at 390", () => {
    for (const plotRight of [1280 - 112, 390 - 8]) {
      const recorded = placeLabel("Recorded since 5 Nov 2026", plotRight - 6, "end", 12, CHART_LABEL_ROW_PX, 12, []);
      const engine = placeLabel("engine v2 from 12 Oct", plotRight - 4, "end", 12, CHART_LABEL_ROW_PX, 300, [recorded.box]);
      expect(boxesOverlap(recorded.box, engine.box)).toBe(false);
      expect(engine.y).toBeGreaterThan(recorded.y);
    }
  });

  it("counts the clearance: two labels one row (12px) apart overlap, two rows (24px) apart do not", () => {
    const a = labelBox("abc", 100, 20, "end");
    expect(boxesOverlap(a, labelBox("abc", 100, 20, "end"))).toBe(true);
    expect(boxesOverlap(a, labelBox("abc", 100, 32, "end"))).toBe(true);
    expect(boxesOverlap(a, labelBox("abc", 100, 44, "end"))).toBe(false);
  });
});
