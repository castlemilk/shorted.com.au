/// <reference types="jest" />

/**
 * The map's layout (spec 13.2). The cells tile the box, every sector holds its
 * cells, a stock with no market cap takes the universe's median and says so, a
 * figure the lens lacks is hatched and never zero, and a zoom keeps the market's
 * scale.
 */

import { layoutMap, lensFigure, sectorOf, type MapStockRow } from "../map-layout";

function stock(overrides: Partial<MapStockRow> & { code: string }): MapStockRow {
  return {
    name: `${overrides.code} Limited`,
    industry: "Materials",
    marketCap: 100,
    disclosedPct: 10,
    institutionalPct: 6,
    hedgePct: 2,
    indexPct: 3,
    shortPct: 4,
    flowPp: 0.5,
    notices: 1,
    ...overrides,
  };
}

/*
 * The reported caps are 300, 60, 200, 120, 90, 30, 15 and 180. NOC has none, so it
 * takes their median: the middle two of 15, 30, 60, 90, 120, 180, 200, 300 are 90
 * and 120, so 105. The whole market is then 1,100.
 */
const UNIVERSE: MapStockRow[] = [
  stock({ code: "BHP", industry: "Materials", marketCap: 300, disclosedPct: 12 }),
  stock({ code: "FMG", industry: "Materials", marketCap: 60, disclosedPct: 8 }),
  stock({ code: "CBA", industry: "Financials", marketCap: 200, disclosedPct: 9, indexPct: null, shortPct: null }),
  stock({ code: "WBC", industry: "Financials", marketCap: 120, disclosedPct: 5, flowPp: null }),
  stock({ code: "CSL", industry: "Health Care", marketCap: 90, disclosedPct: 7 }),
  stock({ code: "XYZ", industry: "Not Applic", marketCap: 30, disclosedPct: 2 }),
  stock({ code: "ABC", industry: "", marketCap: 15, disclosedPct: 1 }),
  stock({ code: "OIL", industry: "Energy", marketCap: 180, disclosedPct: 3 }),
  stock({ code: "NOC", industry: "Energy", marketCap: null, disclosedPct: 4 }),
];
const WHOLE_MARKET = 1100;

const W = 800;
const H = 500;

function area(box: { x0: number; y0: number; x1: number; y1: number }): number {
  return (box.x1 - box.x0) * (box.y1 - box.y0);
}

function near(actual: number, expected: number): void {
  expect(Math.abs(actual - expected)).toBeLessThanOrEqual(1e-6 * Math.max(1, Math.abs(expected)));
}

describe("map layout", () => {
  it("tiles the box: the cells' areas sum to the box, and every cell lies inside it", () => {
    const layout = layoutMap(UNIVERSE, { width: W, height: H, lens: "disclosed" });
    expect(layout.cells).toHaveLength(UNIVERSE.length);
    near(layout.cells.reduce((sum, cell) => sum + area(cell), 0), W * H);
    for (const cell of layout.cells) {
      expect(cell.x0).toBeGreaterThanOrEqual(-1e-9);
      expect(cell.y0).toBeGreaterThanOrEqual(-1e-9);
      expect(cell.x1).toBeLessThanOrEqual(W + 1e-9);
      expect(cell.y1).toBeLessThanOrEqual(H + 1e-9);
    }
  });

  it("gives each sector a rectangle of its stocks' share of the market, and holds its cells", () => {
    const layout = layoutMap(UNIVERSE, { width: W, height: H, lens: "disclosed" });
    near(layout.sectors.reduce((sum, sector) => sum + area(sector), 0), W * H);
    const materials = layout.sectors.find((s) => s.sector === "Materials")!;
    near(area(materials), (W * H * 360) / WHOLE_MARKET);
    expect(materials.stocks).toBe(2);
    for (const cell of layout.cells.filter((c) => c.sector === "Materials")) {
      expect(cell.x0).toBeGreaterThanOrEqual(materials.x0 - 1e-9);
      expect(cell.x1).toBeLessThanOrEqual(materials.x1 + 1e-9);
      expect(cell.y0).toBeGreaterThanOrEqual(materials.y0 - 1e-9);
      expect(cell.y1).toBeLessThanOrEqual(materials.y1 + 1e-9);
    }
  });

  it("makes each cell's area proportional to its market cap across the whole market", () => {
    const layout = layoutMap(UNIVERSE, { width: W, height: H, lens: "disclosed" });
    near(area(layout.cells.find((c) => c.code === "BHP")!) / (W * H), 300 / WHOLE_MARKET);
    near(area(layout.cells.find((c) => c.code === "CBA")!) / (W * H), 200 / WHOLE_MARKET);
  });

  it("takes the universe's median for a stock with no market cap, and flags its cell as estimated", () => {
    const layout = layoutMap(UNIVERSE, { width: W, height: H, lens: "disclosed" });
    const noc = layout.cells.find((c) => c.code === "NOC")!;
    expect(noc.areaEstimated).toBe(true);
    expect(noc.marketCap).toBeNull();
    near(area(noc) / (W * H), 105 / WHOLE_MARKET);
    const bhp = layout.cells.find((c) => c.code === "BHP")!;
    expect(bhp.areaEstimated).toBe(false);
    expect(bhp.marketCap).toBe(300);
  });

  it("keeps the market's scale in a zoom: the median is the universe's, not the sector's", () => {
    const zoomed = layoutMap(UNIVERSE, { width: W, height: H, lens: "disclosed", sector: "Energy" });
    expect(zoomed.zoomed).toBe(true);
    expect(zoomed.sectors).toHaveLength(1);
    near(area(zoomed.sectors[0]!), W * H);
    // Inside Energy the estimate is 105 against OIL's 180, not against itself.
    const noc = zoomed.cells.find((c) => c.code === "NOC")!;
    const oil = zoomed.cells.find((c) => c.code === "OIL")!;
    near(area(noc) / (W * H), 105 / 285);
    near(area(oil) / (W * H), 180 / 285);
  });

  it("zooms to a sector whose cells fill the box in proportion to their caps", () => {
    const zoomed = layoutMap(UNIVERSE, { width: W, height: H, lens: "disclosed", sector: "Financials" });
    expect(zoomed.cells.map((c) => c.code).sort()).toEqual(["CBA", "WBC"]);
    near(zoomed.cells.reduce((sum, cell) => sum + area(cell), 0), W * H);
    near(area(zoomed.cells.find((c) => c.code === "CBA")!) / (W * H), 200 / 320);
  });

  it("returns no cells for a sector the universe does not hold", () => {
    const zoomed = layoutMap(UNIVERSE, { width: W, height: H, lens: "disclosed", sector: "Nowhere" });
    expect(zoomed.zoomed).toBe(true);
    expect(zoomed.cells).toEqual([]);
    expect(zoomed.sectors).toEqual([]);
  });

  it("hatches a cell with no figure for the lens, and never draws it as zero", () => {
    const index = layoutMap(UNIVERSE, { width: W, height: H, lens: "index" });
    const cba = index.cells.find((c) => c.code === "CBA")!;
    expect(cba.hatched).toBe(true);
    expect(cba.value).toBeNull();
    const bhp = index.cells.find((c) => c.code === "BHP")!;
    expect(bhp.hatched).toBe(false);
    expect(bhp.value).toBe(3);

    const disclosed = layoutMap(UNIVERSE, { width: W, height: H, lens: "disclosed" });
    expect(disclosed.cells.some((c) => c.hatched)).toBe(false);
  });

  it("groups a placeholder industry and a blank one under Other", () => {
    expect(sectorOf("Not Applic")).toBe("Other");
    expect(sectorOf("  ")).toBe("Other");
    expect(sectorOf("Materials")).toBe("Materials");
    const layout = layoutMap(UNIVERSE, { width: W, height: H, lens: "disclosed" });
    expect(layout.cells.find((c) => c.code === "XYZ")!.sector).toBe("Other");
    expect(layout.cells.find((c) => c.code === "ABC")!.sector).toBe("Other");
  });

  it("returns an empty layout for a box with no size", () => {
    const layout = layoutMap(UNIVERSE, { width: 0, height: H, lens: "disclosed" });
    expect(layout.cells).toEqual([]);
    expect(layout.sectors).toEqual([]);
  });

  it("does not depend on the order the stocks arrive in", () => {
    const forward = layoutMap(UNIVERSE, { width: W, height: H, lens: "flow" });
    const backward = layoutMap([...UNIVERSE].reverse(), { width: W, height: H, lens: "flow" });
    expect(backward).toEqual(forward);
  });

  it("keeps cells close to square for an even market", () => {
    const even = Array.from({ length: 12 }, (_, i) =>
      stock({ code: `S${String(i).padStart(2, "0")}`, industry: "Materials", marketCap: 50 }),
    );
    const layout = layoutMap(even, { width: 600, height: 400, lens: "disclosed" });
    for (const cell of layout.cells) {
      const w = cell.x1 - cell.x0;
      const h = cell.y1 - cell.y0;
      expect(Math.max(w / h, h / w)).toBeLessThanOrEqual(3);
    }
  });
});

describe("lens figures", () => {
  it("reads each lens from its own figure, with a missing has-flag as null", () => {
    const row = stock({ code: "AAA", indexPct: null, shortPct: 5, flowPp: -1.5 });
    expect(lensFigure(row, "disclosed")).toBe(10);
    expect(lensFigure(row, "institutional")).toBe(6);
    expect(lensFigure(row, "hedge")).toBe(2);
    expect(lensFigure(row, "index")).toBeNull();
    expect(lensFigure(row, "short")).toBe(5);
    expect(lensFigure(row, "flow")).toBe(-1.5);
  });
});
