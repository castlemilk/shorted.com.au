/// <reference types="jest" />

/**
 * The map's layout (spec 13.2). The cells tile the box, every sector holds its
 * cells, a stock with no market cap takes the universe's median and says so, a
 * figure the lens lacks is hatched and never zero, and a zoom keeps the market's
 * scale.
 */

import {
  layoutMap,
  lensFigure,
  phoneLayout,
  phoneSectors,
  phoneStockLayout,
  sectorOf,
  type MapLayout,
  type MapStockRow,
  type PhoneCell,
  type PhoneSector,
  PHONE_MIN_CELL,
} from "../map-layout";
import { FOLDED_SECTOR_LABEL } from "~/@/lib/ownership/kinds";

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

function phoneSector(sector: string, area: number, overrides: Partial<PhoneSector> = {}): PhoneSector {
  return { sector, area, stocks: 1, figured: 1, estimated: 0, figure: 1, figuredCap: area, ...overrides };
}

/** The cells in one column (the left one at x0 = 0), largest first. */
function column(cells: readonly PhoneCell[], x0: number): PhoneCell[] {
  return cells.filter((cell) => cell.x0 === x0);
}

describe("phoneLayout", () => {
  it("draws no cell for no sectors, and a lone sector fills the square", () => {
    expect(phoneLayout([], 360, 44).cells).toEqual([]);
    const [only] = phoneLayout([phoneSector("Materials", 5)], 360, 44).cells;
    expect(only).toMatchObject({ sector: "Materials", x0: 0, y0: 0, x1: 360, y1: 360, folded: [] });
  });

  it("makes each cell's height proportional to its area, and each column the full height", () => {
    // Areas 4, 3, 2, 1 in two columns: 4 goes left, 3 right, 2 right (3 < 4), 1 left (5 > 4 in the right).
    const cells = phoneLayout(
      [phoneSector("a", 4), phoneSector("b", 3), phoneSector("c", 2), phoneSector("d", 1)],
      100,
      0,
    ).cells;
    const left = column(cells, 0);
    const right = column(cells, 50);
    expect(left.map((cell) => cell.sector)).toEqual(["a", "d"]);
    expect(right.map((cell) => cell.sector)).toEqual(["b", "c"]);
    // Within a column the height per unit of area is constant: the column's scale.
    for (const col of [left, right]) {
      const scale = (col[0]!.y1 - col[0]!.y0) / col[0]!.area;
      for (const cell of col) expect((cell.y1 - cell.y0) / cell.area).toBeCloseTo(scale);
      expect(col[col.length - 1]!.y1).toBeCloseTo(100);
    }
    expect(left[0]!.y1 - left[0]!.y0).toBeCloseTo(80);
    expect(right[0]!.y1 - right[0]!.y0).toBeCloseTo(60);
  });

  it("balances the two columns: their totals never differ by more than the largest area", () => {
    const areas = [10, 9, 8, 7, 6, 5, 4, 3, 2, 1];
    const sectors = areas.map((area, index) => phoneSector(`s${index}`, area));
    const cells = phoneLayout(sectors, 360, 0).cells;
    const total = (x0: number) => column(cells, x0).reduce((sum, cell) => sum + cell.area, 0);
    expect(Math.abs(total(0) - total(180))).toBeLessThanOrEqual(10);
    expect(total(0) + total(180)).toBe(areas.reduce((sum, area) => sum + area, 0));
  });

  it("folds the sectors too thin to read into one cell, placed last in the shorter column", () => {
    // Big and Mid are 100 each; Small is 100 and Tiny is 1. Tiny alone would be 3.6 units tall, so the
    // fold takes Small and Tiny: 101 of 201 units in its column, 180.9 tall.
    const cells = phoneLayout(
      [phoneSector("A Big", 100), phoneSector("B Mid", 100), phoneSector("C Small", 100), phoneSector("D Tiny", 1)],
      360,
      44,
    ).cells;
    expect(cells.map((cell) => cell.sector)).toEqual(["A Big", "B Mid", FOLDED_SECTOR_LABEL]);
    const fold = cells[2]!;
    expect(fold.folded).toEqual(["C Small", "D Tiny"]);
    expect(fold.stocks).toBe(2);
    expect(fold.x0).toBe(0);
    expect(fold.y1).toBeCloseTo(360);
  });

  it("keeps every drawn cell at least minCell tall", () => {
    const areas = [50, 40, 30, 20, 10, 5, 2, 1];
    const cells = phoneLayout(areas.map((area, index) => phoneSector(`s${index}`, area)), 360, 44).cells;
    expect(cells.length).toBeGreaterThan(1);
    for (const cell of cells) expect(cell.y1 - cell.y0).toBeGreaterThanOrEqual(44 - 1e-9);
  });

  it("draws every sector individually when every cell is tall enough, with no fold cell", () => {
    const cells = phoneLayout([phoneSector("a", 3), phoneSector("b", 2), phoneSector("c", 2)], 360, 44).cells;
    expect(cells.map((cell) => cell.sector)).toEqual(["a", "b", "c"]);
    expect(cells.every((cell) => cell.folded.length === 0)).toBe(true);
  });

  it("is deterministic: the same sectors in any order give the same cells", () => {
    const sectors = [phoneSector("Materials", 500), phoneSector("Other", 200), phoneSector("Financials", 150)];
    expect(phoneLayout(sectors, 360, 44)).toEqual(phoneLayout([...sectors].reverse(), 360, 44));
  });

  it("does not draw a sector with no area", () => {
    const cells = phoneLayout([phoneSector("Empty", 0), phoneSector("Full", 5)], 360, 44).cells;
    expect(cells.map((cell) => cell.sector)).toEqual(["Full"]);
  });

  it("gives the fold cell the market-cap-weighted mean of the folded sectors' figures", () => {
    const folded = phoneLayout(
      [
        phoneSector("Big", 100),
        phoneSector("Mid", 100),
        phoneSector("Small", 100, { figure: 10, figuredCap: 100, stocks: 2, figured: 2 }),
        phoneSector("Tiny", 1, { figure: 20, figuredCap: 1, stocks: 3, figured: 1 }),
      ],
      360,
      44,
    ).cells.find((cell) => cell.sector === FOLDED_SECTOR_LABEL);
    expect(folded?.figure).toBeCloseTo((10 * 100 + 20 * 1) / 101);
    expect(folded?.stocks).toBe(5);
    expect(folded?.figured).toBe(3);
  });

  it("gives a fold of sectors with no figure a null figure, never zero", () => {
    // N1 and N2 state no figure. Alone, N2 is too thin and N1 too, so the fold takes both, and the two
    // big sectors are drawn: the fold is 151 of 1151 units, 47 tall.
    const none = { figure: null, figured: 0, figuredCap: 0 };
    const cells = phoneLayout(
      [phoneSector("Big", 1000), phoneSector("Mid", 1000), phoneSector("N1", 150, none), phoneSector("N2", 1, none)],
      360,
      44,
    ).cells;
    const fold = cells.find((cell) => cell.sector === FOLDED_SECTOR_LABEL);
    expect(fold?.folded).toEqual(["N1", "N2"]);
    expect(fold?.figure).toBeNull();
    expect(fold?.figured).toBe(0);
  });
});

describe("phoneSectors", () => {
  const rows = [
    stock({ code: "BHP", industry: "Materials", marketCap: 300, disclosedPct: 40 }),
    stock({ code: "RIO", industry: "Materials", marketCap: 100, disclosedPct: 20 }),
    stock({ code: "NOC", industry: "Financials", marketCap: null, disclosedPct: 6 }),
    stock({ code: "CBA", industry: "Financials", marketCap: 200, disclosedPct: null as unknown as number, shortPct: null }),
  ];

  it("sums the Size's area per sector, estimating a missing market cap with the median, as the layout does", () => {
    const sectors = phoneSectors(rows, rows, "disclosed");
    const materials = sectors.find((sector) => sector.sector === "Materials");
    const financials = sectors.find((sector) => sector.sector === "Financials");
    expect(materials?.area).toBe(400);
    // The median of 100, 200, 300 is 200: NOC takes it, so Financials is 200 + 200.
    expect(financials?.area).toBe(400);
    expect(materials?.stocks).toBe(2);
    expect(financials?.stocks).toBe(2);
  });

  it("takes the figure as the market-cap-weighted mean over the stocks that state one", () => {
    const materials = phoneSectors(rows, rows, "disclosed").find((sector) => sector.sector === "Materials");
    // (40 x 300 + 20 x 100) / 400 = 35.
    expect(materials?.figure).toBeCloseTo(35);
    expect(materials?.figured).toBe(2);
    expect(materials?.figuredCap).toBe(400);
  });

  it("weights the figure by market cap even when the Size draws another area", () => {
    // Disclosed exposure: BHP's area is 40% of 300 = 120, RIO's 20% of 100 = 20. The figure is still weighted by cap.
    const sized = rows.map((row) => ({ ...row, marketCap: (row.disclosedPct ?? 0) / 100 * (row.marketCap ?? 200) }));
    const materials = phoneSectors(rows, sized, "disclosed").find((sector) => sector.sector === "Materials");
    expect(materials?.figure).toBeCloseTo(35);
    expect(materials?.area).toBe(140);
  });

  it("counts the stocks with no market cap of their own as estimated, and none in a sector that has them all", () => {
    const sectors = phoneSectors(rows, rows, "disclosed");
    expect(sectors.find((sector) => sector.sector === "Financials")?.estimated).toBe(1);
    expect(sectors.find((sector) => sector.sector === "Materials")?.estimated).toBe(0);
  });

  it("states a null figure when no stock of the sector states one, and counts only the stocks that do", () => {
    // Financials' short positions are all unstated; Materials' are not, so only they have a figure.
    const short = rows.map((row) => (row.industry === "Financials" ? { ...row, shortPct: null } : row));
    const sectors = phoneSectors(short, short, "short");
    const financials = sectors.find((sector) => sector.sector === "Financials");
    expect(financials?.figure).toBeNull();
    expect(financials?.figured).toBe(0);
    expect(financials?.stocks).toBe(2);
  });
});

describe("phoneStockLayout", () => {
  const stocks = [
    stock({ code: "BHP", industry: "Materials", marketCap: 300, disclosedPct: 40 }),
    stock({ code: "RIO", industry: "Materials", marketCap: 100, disclosedPct: 20 }),
    stock({ code: "NOC", industry: "Materials", marketCap: null, disclosedPct: 6 }),
    stock({ code: "CBA", industry: "Financials", marketCap: 200, disclosedPct: 9 }),
  ];

  it("lays out only the sector's stocks in the square, each area its market cap", () => {
    const cells = phoneStockLayout(stocks, "Materials", "disclosed", 360);
    expect(cells.map((cell) => cell.code).sort()).toEqual(["BHP", "NOC", "RIO"]);
    const noc = cells.find((cell) => cell.code === "NOC");
    expect(noc?.areaEstimated).toBe(true);
    expect(noc?.marketCap).toBeNull();
    const bhp = cells.find((cell) => cell.code === "BHP");
    expect(bhp?.areaEstimated).toBe(false);
    expect(bhp?.value).toBe(40);
    for (const cell of cells) {
      expect(cell.x0).toBeGreaterThanOrEqual(0);
      expect(cell.x1).toBeLessThanOrEqual(360);
      expect(cell.y1).toBeLessThanOrEqual(360 + 1e-9);
    }
  });

  it("hatches a stock with no figure for the lens, never as zero", () => {
    const unstated = stocks.map((row) => ({ ...row, shortPct: null }));
    const cells = phoneStockLayout(unstated, "Materials", "short", 360);
    expect(cells).toHaveLength(3);
    expect(cells.every((cell) => cell.hatched && cell.value === null)).toBe(true);
  });

  it("draws nothing for a sector with no stocks, and nothing for a size of zero", () => {
    expect(phoneStockLayout(stocks, "Energy", "disclosed", 360)).toEqual([]);
    expect(phoneStockLayout(stocks, "Materials", "disclosed", 0)).toEqual([]);
  });

  it("folds the stocks too thin to draw into one cell, so every drawn cell is at least the minimum", () => {
    // Sixty stocks whose market caps fall by 15% each: the largest twelve or so fit, the rest fold.
    const many = Array.from({ length: 60 }, (_, i) =>
      stock({ code: `S${String(i).padStart(2, "0")}`, industry: "Materials", marketCap: 1000 * 0.85 ** i, disclosedPct: 10 - i * 0.1 }),
    );
    const cells = phoneStockLayout(many, "Materials", "disclosed", 360);
    const drawn = cells.filter((cell) => cell.folded.length === 0);
    const folds = cells.filter((cell) => cell.folded.length > 0);
    expect(folds).toHaveLength(1);
    const [fold] = folds;
    expect(fold!.code).toBe("");
    expect(fold!.name).toBe(`Other stocks (${fold!.folded.length})`);
    expect(drawn.length + fold!.folded.length).toBe(60);
    expect(fold!.folded.length).toBeGreaterThan(40);
    expect(fold!.folded).toContain("S59");
    // The folded stocks are the smallest: their codes ascend, as their caps descend.
    expect(fold!.folded).toEqual([...fold!.folded].sort());
    for (const cell of drawn) expect(cell.y1 - cell.y0).toBeGreaterThanOrEqual(PHONE_MIN_CELL - 1e-9);
    expect(fold!.y1 - fold!.y0).toBeGreaterThanOrEqual(PHONE_MIN_CELL - 1e-9);
    expect(fold!.figured).toBe(fold!.folded.length);
    for (const cell of cells) {
      expect(cell.x0).toBeGreaterThanOrEqual(0);
      expect(cell.x1).toBeLessThanOrEqual(360);
      expect(cell.y1).toBeLessThanOrEqual(360 + 1e-9);
    }
  });

  it("draws every stock as its own cell when they all fit, and no fold cell", () => {
    const cells = phoneStockLayout(stocks, "Materials", "disclosed", 360);
    expect(cells.every((cell) => cell.folded.length === 0 && cell.code !== "")).toBe(true);
    expect(cells.every((cell) => cell.figured === 1)).toBe(true);
  });
});

/*
 * The change order (backlog C3). Under the flow lens: Financials states one figure (CBA, -2.00, WBC
 * has none), so its net is -2.00; Energy's is the cap-weighted mean of +0.50 (180) and +6.00 (10),
 * 0.79; Materials' is (300 x +1.00 + 60 x -4.00) / 360, 0.17; Health Care states none. By area the
 * order is Materials, Financials, Energy, Health Care; by magnitude of change it is Financials,
 * Energy, Materials, Health Care.
 */
const MOVERS: MapStockRow[] = [
  stock({ code: "BHP", industry: "Materials", marketCap: 300, flowPp: 1 }),
  stock({ code: "FMG", industry: "Materials", marketCap: 60, flowPp: -4 }),
  stock({ code: "CBA", industry: "Financials", marketCap: 200, flowPp: -2 }),
  stock({ code: "WBC", industry: "Financials", marketCap: 120, flowPp: null }),
  stock({ code: "OIL", industry: "Energy", marketCap: 180, flowPp: 0.5 }),
  stock({ code: "NOC", industry: "Energy", marketCap: 10, flowPp: 6 }),
  stock({ code: "CSL", industry: "Health Care", marketCap: 90, flowPp: null }),
];

function areaOfBox(box: { x0: number; y0: number; x1: number; y1: number }): number {
  return (box.x1 - box.x0) * (box.y1 - box.y0);
}

describe("layoutMap under the change order (backlog C3)", () => {
  const changed = (lens: "flow" | "index_flow" | "disclosed" | "short" = "flow", sector?: string) =>
    layoutMap(MOVERS, { width: W, height: H, lens, sector, sort: "changed" });
  const largest = (lens: "flow" | "index_flow" | "disclosed" | "short" = "flow", sector?: string) =>
    layoutMap(MOVERS, { width: W, height: H, lens, sector, sort: "largest" });

  it("orders the sectors by the magnitude of their net change, with an unmeasured sector last", () => {
    expect(changed().sectors.map((s) => s.sector)).toEqual(["Financials", "Energy", "Materials", "Health Care"]);
  });

  it("keeps the order by area under the largest sort", () => {
    expect(largest().sectors.map((s) => s.sector)).toEqual(["Materials", "Financials", "Energy", "Health Care"]);
  });

  it("states each sector's net change, the cap-weighted figure the phone map states, and none for a sector with no figure", () => {
    const sectors = changed().sectors;
    expect(sectors.find((s) => s.sector === "Financials")?.change).toBeCloseTo(-2, 9);
    expect(sectors.find((s) => s.sector === "Energy")?.change).toBeCloseTo(150 / 190, 9);
    expect(sectors.find((s) => s.sector === "Materials")?.change).toBeCloseTo(60 / 360, 9);
    expect(sectors.find((s) => s.sector === "Health Care")?.change).toBeNull();
  });

  it("weights a sector's net change by the rows it is given as weights, whatever the Size draws", () => {
    // Under the exposure Size the drawn rows carry exposures as their market caps: BHP's 30 against FMG's 60.
    // The change is weighted by the stocks' own market caps (300 and 60), as the phone square weights it.
    const sized = MOVERS.map((s) => (s.code === "BHP" ? { ...s, marketCap: 30 } : s.code === "FMG" ? { ...s, marketCap: 60 } : s));
    const materialsOf = (layout: MapLayout) => layout.sectors.find((s) => s.sector === "Materials")?.change;
    const weighted = layoutMap(sized, { width: W, height: H, lens: "flow", sort: "changed", weights: MOVERS });
    expect(materialsOf(weighted)).toBeCloseTo(60 / 360, 9);
    const unweighted = layoutMap(sized, { width: W, height: H, lens: "flow", sort: "changed" });
    expect(materialsOf(unweighted)).toBeCloseTo((30 * 1 + 60 * -4) / 90, 9);
  });

  it("states no change on a sector under the largest sort", () => {
    for (const sector of largest().sectors) expect(sector.change).toBeUndefined();
  });

  it("puts the biggest mover in the top-left corner", () => {
    const layout = changed();
    const first = layout.sectors[0]!;
    expect(first.sector).toBe("Financials");
    expect(first.x0).toBe(0);
    expect(first.y0).toBe(0);
  });

  it("orders the stocks inside a sector by the magnitude of their own figure, a stock with no figure last", () => {
    const codes = changed().cells.map((cell) => cell.code);
    // Financials: CBA (-2.00) before WBC (no figure); Energy: NOC (+6.00) before OIL (+0.50);
    // Materials: FMG (-4.00) before BHP (+1.00); Health Care: CSL (no figure).
    expect(codes).toEqual(["CBA", "WBC", "NOC", "OIL", "FMG", "BHP", "CSL"]);
  });

  it("orders the stocks inside a sector by area under the largest sort", () => {
    const materials = largest().cells.filter((cell) => cell.sector === "Materials").map((cell) => cell.code);
    expect(materials).toEqual(["BHP", "FMG"]);
  });

  it("keeps the sr-only table's order with the drawing: the cells come in the order they are drawn", () => {
    const layout = changed();
    const firstCellOfSector = (name: string) => layout.cells.findIndex((cell) => cell.sector === name);
    expect(firstCellOfSector("Financials")).toBeLessThan(firstCellOfSector("Energy"));
    expect(firstCellOfSector("Energy")).toBeLessThan(firstCellOfSector("Materials"));
    expect(firstCellOfSector("Materials")).toBeLessThan(firstCellOfSector("Health Care"));
  });

  it("keeps every cell and every sector inside the box, and tiles it, under the change order", () => {
    const layout = changed();
    const total = layout.sectors.reduce((sum, sector) => sum + areaOfBox(sector), 0);
    expect(total).toBeCloseTo(W * H, 6);
    for (const cell of layout.cells) {
      expect(cell.x0).toBeGreaterThanOrEqual(0);
      expect(cell.y0).toBeGreaterThanOrEqual(0);
      expect(cell.x1).toBeLessThanOrEqual(W + 1e-9);
      expect(cell.y1).toBeLessThanOrEqual(H + 1e-9);
    }
  });

  it("keeps each sector's size the Size's share of the market under either sort: only its place moves", () => {
    const byChange = changed();
    const byArea = largest();
    for (const sector of byArea.sectors) {
      const other = byChange.sectors.find((s) => s.sector === sector.sector)!;
      expect(areaOfBox(other)).toBeCloseTo(areaOfBox(sector), 6);
      expect(other.stocks).toBe(sector.stocks);
    }
  });

  it("orders by area under a lens that states no change, even when the sort is changed", () => {
    expect(changed("disclosed").sectors.map((s) => s.sector)).toEqual(
      largest("disclosed").sectors.map((s) => s.sector),
    );
    expect(changed("disclosed").cells.map((c) => c.code)).toEqual(largest("disclosed").cells.map((c) => c.code));
    expect(changed("short").sectors[0]?.change).toBeUndefined();
  });

  it("applies the same rule to the index flow lens, which states a change too", () => {
    const withFunds = MOVERS.map((s) => ({ ...s, fundChangePct: s.code === "OIL" ? 9 : null }));
    const layout = layoutMap(withFunds, { width: W, height: H, lens: "index_flow", sort: "changed" });
    expect(layout.sectors[0]?.sector).toBe("Energy");
    expect(layout.cells.find((c) => c.sector === "Energy")?.code).toBe("OIL");
  });

  it("orders a zoomed sector's stocks by change, and reports the zoom's one sector", () => {
    const layout = changed("flow", "Materials");
    expect(layout.zoomed).toBe(true);
    expect(layout.cells.map((c) => c.code)).toEqual(["FMG", "BHP"]);
    expect(layout.sectors.map((s) => s.sector)).toEqual(["Materials"]);
  });

  it("does not read the order of the stocks it is given, under either sort", () => {
    const shuffled = [...MOVERS].reverse();
    const a = layoutMap(shuffled, { width: W, height: H, lens: "flow", sort: "changed" });
    expect(a.cells.map((c) => c.code)).toEqual(changed().cells.map((c) => c.code));
  });
});
