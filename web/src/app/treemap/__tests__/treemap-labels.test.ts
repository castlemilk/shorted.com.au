import {
  headerHeightFor,
  leafLabelFontSize,
  treemapHeightFor,
} from "../treemap-labels";

const PHONE = 390;
const TABLET = 768;
const DESKTOP = 1440;

describe("leafLabelFontSize", () => {
  it("labels a small phone tile that the desktop gate would have hidden", () => {
    // 44x28 is typical of a phone tile and is under the 60x32 desktop gate.
    expect(leafLabelFontSize(44, 28, "BHP", PHONE)).not.toBeNull();
    expect(leafLabelFontSize(44, 28, "BHP", DESKTOP)).toBeNull();
  });

  it("keeps phone labels between 7 and 12px", () => {
    const sizes = [
      [30, 20],
      [44, 28],
      [80, 60],
      [200, 180],
    ].map(([w, h]) => leafLabelFontSize(w!, h!, "BHP", PHONE));

    for (const size of sizes) {
      expect(size).not.toBeNull();
      expect(size!).toBeGreaterThanOrEqual(7);
      expect(size!).toBeLessThanOrEqual(12);
    }
  });

  it("scales the label up as the tile grows, rather than pinning at the floor", () => {
    const small = leafLabelFontSize(20, 14, "BHP", PHONE)!;
    const large = leafLabelFontSize(120, 90, "BHP", PHONE)!;
    expect(large).toBeGreaterThan(small);
  });

  it("never renders a label wider or taller than its tile", () => {
    for (const width of [PHONE, TABLET, DESKTOP]) {
      for (const w of [12, 20, 30, 44, 61, 120, 300]) {
        for (const h of [8, 14, 20, 33, 60, 200]) {
          const size = leafLabelFontSize(w, h, "WBC", width);
          if (size === null) continue;
          expect(size).toBeLessThanOrEqual(h);
          expect(size * 3 * 0.64).toBeLessThanOrEqual(w);
        }
      }
    }
  });

  it("hides the label when the tile is too small for the floor size", () => {
    expect(leafLabelFontSize(10, 10, "BHP", PHONE)).toBeNull();
    expect(leafLabelFontSize(200, 9, "BHP", PHONE)).toBeNull();
  });

  it("gives longer codes a smaller size in the same tile", () => {
    const short = leafLabelFontSize(30, 40, "A2M", PHONE)!;
    const long = leafLabelFontSize(30, 40, "ABCDE", PHONE)!;
    expect(long).toBeLessThan(short);
  });

  it("leaves wide viewports on their original gate and sizing", () => {
    expect(leafLabelFontSize(60, 40, "BHP", DESKTOP)).toBeNull();
    expect(leafLabelFontSize(100, 32, "BHP", DESKTOP)).toBeNull();
    expect(leafLabelFontSize(100, 60, "BHP", DESKTOP)).toBe(12);
    expect(leafLabelFontSize(200, 200, "BHP", DESKTOP)).toBe(20);
  });

  it("treats tablets as compact too", () => {
    expect(leafLabelFontSize(50, 30, "BHP", TABLET)).not.toBeNull();
    expect(leafLabelFontSize(50, 30, "BHP", TABLET)!).toBeGreaterThanOrEqual(8);
  });
});

describe("map dimensions", () => {
  it("shortens the map and its sector headers on phones", () => {
    expect(treemapHeightFor(PHONE)).toBeLessThan(treemapHeightFor(DESKTOP));
    expect(headerHeightFor(PHONE)).toBeLessThan(headerHeightFor(DESKTOP));
  });

  it("falls back to the full size before ParentSize has measured", () => {
    expect(treemapHeightFor(0)).toBe(treemapHeightFor(DESKTOP));
    expect(headerHeightFor(0)).toBe(headerHeightFor(DESKTOP));
  });
});
