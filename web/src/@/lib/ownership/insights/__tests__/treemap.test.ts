import { join } from "node:path";

// d3-hierarchy ships ES modules that this Jest config does not transform; its
// UMD build is the same code.
jest.mock("d3-hierarchy", () =>
  jest.requireActual(join(__dirname, "..", "..", "..", "..", "..", "..", "node_modules", "d3-hierarchy", "dist", "d3-hierarchy.js")),
);

import { layoutMarketMap, readingOrder, stockChange, stockSize, tileLabelLevel } from "../treemap";
import { REMAINDERS, SECTORS, STOCKS } from "./fixtures";

const W = 800;
const H = 450;

function area(t: { x0: number; y0: number; x1: number; y1: number }) {
  return (t.x1 - t.x0) * (t.y1 - t.y0);
}

describe("the market map's geometry", () => {
  it("nests every stock with a size inside its sector, inside the box, sized by the measure", () => {
    const layout = layoutMarketMap({ sectors: SECTORS, stocks: STOCKS, remainders: REMAINDERS, measure: "funds", width: W, height: H, focus: null });
    const codes = layout.tiles.map((t) => t.id).sort();
    expect(codes).toEqual(["BHP", "CBA", "PLS", "rest:Materials"]);
    expect(layout.tiles.find((t) => t.code === "MIN")).toBeUndefined();
    for (const t of layout.tiles) {
      expect(t.x0).toBeGreaterThanOrEqual(0);
      expect(t.y0).toBeGreaterThanOrEqual(0);
      expect(t.x1).toBeLessThanOrEqual(W);
      expect(t.y1).toBeLessThanOrEqual(H);
      const group = layout.groups.find((g) => g.sector === t.sector)!;
      expect(t.x0).toBeGreaterThanOrEqual(group.x0);
      expect(t.y1).toBeLessThanOrEqual(group.y1);
    }
    const bhp = layout.tiles.find((t) => t.code === "BHP")!;
    const cba = layout.tiles.find((t) => t.code === "CBA")!;
    expect(area(bhp) / area(cba)).toBeGreaterThan(8);
    expect(layout.total).toBeCloseTo(5.12e9 + 9e8 + 3e8 + 2e8);
    const materials = layout.groups.find((g) => g.sector === "Materials")!;
    expect(materials.header).toBe(true);
    expect(materials.change).toBe(7.3);
    expect(bhp.change).toBe(10);
  });

  it("sizes by disclosed value under the other measure, and colours by the notices' net change", () => {
    const layout = layoutMarketMap({ sectors: SECTORS, stocks: STOCKS, remainders: [], measure: "disclosed", width: W, height: H, focus: null });
    expect(layout.tiles.map((t) => t.code).sort()).toEqual(["BHP", "MIN", "PLS"]);
    expect(layout.tiles.find((t) => t.code === "MIN")!.change).toBe(-3);
    expect(layout.groups.find((g) => g.sector === "")!.label).toBe("Other");
  });

  it("fills the box with one sector when it is focused, headers off", () => {
    const layout = layoutMarketMap({ sectors: SECTORS, stocks: STOCKS, remainders: REMAINDERS, measure: "funds", width: W, height: H, focus: "Materials" });
    expect(layout.tiles.map((t) => t.id).sort()).toEqual(["BHP", "PLS", "rest:Materials"]);
    expect(layout.groups).toHaveLength(1);
    expect(layout.groups[0]!.header).toBe(false);
    const covered = layout.tiles.reduce((sum, t) => sum + area(t), 0);
    expect(covered / (W * H)).toBeGreaterThan(0.95);
  });

  it("draws nothing without a box or a size", () => {
    expect(layoutMarketMap({ sectors: SECTORS, stocks: STOCKS, remainders: [], measure: "funds", width: 0, height: H, focus: null }).tiles).toEqual([]);
    expect(layoutMarketMap({ sectors: [], stocks: [], remainders: [], measure: "funds", width: W, height: H, focus: null }).total).toBe(0);
  });

  it("reads a stock's size and change by the measure, and n/a stays null", () => {
    const cba = STOCKS[2]!;
    expect(stockSize(cba, "funds")).toBe(3e8);
    expect(stockSize(cba, "disclosed")).toBe(0);
    expect(stockChange(cba, "funds")).toBeNull();
    expect(stockChange(cba, "disclosed")).toBe(0);
  });

  it("walks tiles top to bottom, then left to right, and labels only what fits", () => {
    const order = readingOrder([
      { id: "b", x0: 100, y0: 0 },
      { id: "c", x0: 0, y0: 50 },
      { id: "a", x0: 0, y0: 0 },
    ]);
    expect(order.map((t) => t.id)).toEqual(["a", "b", "c"]);
    expect(tileLabelLevel({ x0: 0, y0: 0, x1: 20, y1: 20 })).toBe(0);
    expect(tileLabelLevel({ x0: 0, y0: 0, x1: 40, y1: 20 })).toBe(1);
    expect(tileLabelLevel({ x0: 0, y0: 0, x1: 60, y1: 40 })).toBe(2);
  });
});
