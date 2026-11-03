/// <reference types="jest" />

/**
 * The flows' layouts (spec 13.3) and the fund window's lists (spec 13.5). Every
 * band sums into its nodes, a change keeps its two directions apart, a
 * position with no estimate is no band, and a stock held on one date only is
 * never a change from zero.
 */

import {
  changeFlows,
  partitionFundChanges,
  positionFlows,
  type FlowChangeRow,
  type FlowPositionRow,
  type FundChangeRow,
} from "../flows-layout";

const POSITIONS: FlowPositionRow[] = [
  { kind: "super_fund", industry: "Materials", exposureAud: 3_000_000_000, holdings: 4, largestCode: "BHP", largestPct: 9.2 },
  { kind: "super_fund", industry: "Financials", exposureAud: 1_500_000_000, holdings: 2, largestCode: "CBA", largestPct: 6.1 },
  { kind: "hedge_fund", industry: "Materials", exposureAud: 500_000_000, holdings: 1, largestCode: "FMG", largestPct: 5.4 },
  { kind: "hedge_fund", industry: "Health Care", exposureAud: 250_000_000, holdings: 1, largestCode: "CSL", largestPct: 5.0 },
  { kind: "bank_broker", industry: "Financials", exposureAud: null, holdings: 3, largestCode: "MQG", largestPct: 7.7 },
  { kind: "insurer", industry: "Health Care", exposureAud: 0, holdings: 1, largestCode: "NHF", largestPct: 5.2 },
];

const CHANGES: FlowChangeRow[] = [
  { kind: "super_fund", industry: "Materials", direction: "up", exposureAud: 400_000_000, notices: 3 },
  { kind: "super_fund", industry: "Materials", direction: "down", exposureAud: 150_000_000, notices: 1 },
  { kind: "hedge_fund", industry: "Financials", direction: "down", exposureAud: 90_000_000, notices: 2 },
  { kind: "hedge_fund", industry: "Health Care", direction: "up", exposureAud: null, notices: 1 },
];

const W = 900;
const H = 480;

describe("position flow", () => {
  it("draws one band per estimable cell, and holder kinds on the left and sectors on the right", () => {
    const layout = positionFlows(POSITIONS, W, H);
    expect(layout.empty).toBe(false);
    expect(layout.bands).toHaveLength(4);
    const holder = layout.nodes.filter((n) => n.kind === "holder");
    const sector = layout.nodes.filter((n) => n.kind === "sector");
    // The insurer's exposure is zero, so it draws no band and no node.
    expect(holder.map((n) => n.label).sort()).toEqual(["Hedge fund", "Super fund"]);
    expect(sector.map((n) => n.label).sort()).toEqual(["Financials", "Health Care", "Materials"]);
    for (const h of holder) for (const s of sector) expect(h.x0).toBeLessThan(s.x0);
  });

  it("sums the bands at each node to the node's value, and the band widths to its height", () => {
    const layout = positionFlows(POSITIONS, W, H);
    for (const [index, node] of layout.nodes.entries()) {
      const touching = layout.bands.filter((b) => b.source === index || b.target === index);
      const total = touching.reduce((sum, b) => sum + b.value, 0);
      const widths = touching.reduce((sum, b) => sum + b.width, 0);
      expect(node.value).toBeCloseTo(total, 3);
      expect(widths).toBeCloseTo(node.y1 - node.y0, 3);
    }
  });

  it("carries each band's holdings and largest holder, and draws it as a path", () => {
    const layout = positionFlows(POSITIONS, W, H);
    const band = layout.bands.find((b) => b.value === 3_000_000_000)!;
    expect(band.holdings).toBe(4);
    expect(band.largestCode).toBe("BHP");
    expect(band.largestPct).toBe(9.2);
    expect(band.direction).toBeNull();
    expect(band.path.startsWith("M")).toBe(true);
  });

  it("draws no band for a cell with no estimate, a zero, or nothing at all", () => {
    expect(positionFlows([POSITIONS[4]!, POSITIONS[5]!], W, H)).toEqual({
      width: W,
      height: H,
      empty: true,
      nodes: [],
      bands: [],
    });
  });

  it("is empty for a box with no size", () => {
    expect(positionFlows(POSITIONS, 0, H).empty).toBe(true);
  });
});

describe("change flow", () => {
  it("keeps the increase and the decrease of one kind in one industry as two bands", () => {
    const layout = changeFlows(CHANGES, W, H);
    const materials = layout.nodes.findIndex((n) => n.kind === "sector" && n.label === "Materials");
    const between = layout.bands.filter((b) => b.target === materials);
    expect(between.map((b) => b.direction).sort()).toEqual(["down", "up"]);
    expect(between.find((b) => b.direction === "up")!.value).toBe(400_000_000);
    expect(between.find((b) => b.direction === "down")!.value).toBe(150_000_000);
  });

  it("sums the bands at each node, both directions together", () => {
    const layout = changeFlows(CHANGES, W, H);
    for (const [index, node] of layout.nodes.entries()) {
      const touching = layout.bands.filter((b) => b.source === index || b.target === index);
      const total = touching.reduce((sum, b) => sum + b.value, 0);
      const widths = touching.reduce((sum, b) => sum + b.width, 0);
      expect(node.value).toBeCloseTo(total, 3);
      expect(widths).toBeCloseTo(node.y1 - node.y0, 3);
    }
  });

  it("carries the notice count and no holding count into a change band", () => {
    const layout = changeFlows(CHANGES, W, H);
    const up = layout.bands.find((b) => b.direction === "up" && b.value === 400_000_000)!;
    expect(up.notices).toBe(3);
    expect(up.holdings).toBe(0);
    expect(up.largestCode).toBe("");
    expect(up.largestPct).toBeNull();
  });

  it("is empty when no change carries an estimate", () => {
    expect(changeFlows([CHANGES[3]!], W, H).empty).toBe(true);
  });
});

function fundRow(overrides: Partial<FundChangeRow> & { code: string }): FundChangeRow {
  return {
    name: `${overrides.code} Limited`,
    weightFrom: 2,
    weightTo: 2,
    delta: 0,
    valueFrom: null,
    valueTo: null,
    funds: 1,
    state: "current",
    ...overrides,
  };
}

describe("index fund window lists", () => {
  const rows: FundChangeRow[] = [
    fundRow({ code: "BHP", weightFrom: 4, weightTo: 5, delta: 1 }),
    fundRow({ code: "CBA", weightFrom: 6, weightTo: 5.5, delta: -0.5 }),
    fundRow({ code: "WBC", weightFrom: 3, weightTo: 3, delta: 0 }),
    fundRow({ code: "NEW1", weightFrom: null, weightTo: 1.2, delta: null, state: "new" }),
    fundRow({ code: "NEW2", weightFrom: null, weightTo: 0.4, delta: null, state: "new" }),
    fundRow({ code: "OLD1", weightFrom: 0.9, weightTo: null, delta: null, state: "dropped" }),
    fundRow({ code: "RIO", weightFrom: 7, weightTo: 9, delta: 2 }),
    fundRow({ code: "MIN", weightFrom: 2, weightTo: 1.5, delta: -0.5, state: "current" }),
  ];

  it("lists rises largest first and falls most negative first", () => {
    const lists = partitionFundChanges(rows);
    expect(lists.rises.map((r) => r.code)).toEqual(["RIO", "BHP"]);
    expect(lists.falls.map((r) => r.code)).toEqual(["CBA", "MIN"]);
  });

  it("never counts a stock held on one date as a change from zero", () => {
    const lists = partitionFundChanges(rows);
    expect(lists.rises.concat(lists.falls).map((r) => r.code)).not.toContain("NEW1");
    expect(lists.rises.concat(lists.falls).map((r) => r.code)).not.toContain("OLD1");
    expect(lists.added.map((r) => r.code)).toEqual(["NEW1", "NEW2"]);
    expect(lists.dropped.map((r) => r.code)).toEqual(["OLD1"]);
  });

  it("leaves out a stock whose weight did not move", () => {
    const lists = partitionFundChanges(rows);
    const all = [...lists.rises, ...lists.falls, ...lists.added, ...lists.dropped].map((r) => r.code);
    expect(all).not.toContain("WBC");
  });

  it("caps each list at the limit, and takes the default when none or a bad one is given", () => {
    expect(partitionFundChanges(rows, 1).rises.map((r) => r.code)).toEqual(["RIO"]);
    expect(partitionFundChanges(rows, 0).rises).toHaveLength(2);
    expect(partitionFundChanges(rows, Number.NaN).falls).toHaveLength(2);
    expect(partitionFundChanges(rows, 500).rises).toHaveLength(2);
  });

  it("sorts the input itself, so the order the API sent does not matter", () => {
    const reversed = partitionFundChanges([...rows].reverse());
    expect(reversed.rises.map((r) => r.code)).toEqual(["RIO", "BHP"]);
    expect(reversed.added.map((r) => r.code)).toEqual(["NEW1", "NEW2"]);
  });
});
