/// <reference types="jest" />

/**
 * The flows' layouts (spec 13.3) and the fund window's lists (spec 13.5). Every
 * band sums into its nodes, a change keeps its two directions apart, a
 * position with no estimate is no band, and a stock held on one date only is
 * never a change from zero.
 */

import { FOLDED_SECTOR_LABEL } from "~/@/lib/ownership/kinds";
import {
  LABEL_GAP,
  changeFlows,
  flowGutters,
  labelLines,
  labelWidth,
  partitionFundChanges,
  positionFlows,
  splitLabel,
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

describe("the holder column's order (spec B6)", () => {
  const ROWS: FlowPositionRow[] = [
    { kind: "unclassified", industry: "Materials", exposureAud: 9_000_000_000, holdings: 5, largestCode: "", largestPct: 1 },
    { kind: "super_fund", industry: "Materials", exposureAud: 1_000_000_000, holdings: 2, largestCode: "BHP", largestPct: 9 },
    { kind: "hedge_fund", industry: "Materials", exposureAud: 3_000_000_000, holdings: 1, largestCode: "FMG", largestPct: 5 },
    { kind: "bank_broker", industry: "Financials", exposureAud: 2_000_000_000, holdings: 3, largestCode: "MQG", largestPct: 7 },
  ];

  function top(nodes: { kind: string; label: string; y0: number }[], kind: "holder" | "sector") {
    return nodes.filter((node) => node.kind === kind).sort((a, b) => a.y0 - b.y0).map((node) => node.label);
  }

  it("draws the kinds by exposure, largest at the top, and the unclassified holders last whatever their size", () => {
    const layout = positionFlows(ROWS, 400, 300);
    // The unclassified holders are the largest band here and still sit at the bottom.
    expect(top(layout.nodes, "holder")).toEqual(["Hedge fund", "Bank or broker", "Super fund", "Unclassified"]);
  });

  it("keeps the unclassified holders last in a change flow, whichever direction they moved", () => {
    const changes: FlowChangeRow[] = [
      { kind: "unclassified", industry: "Materials", direction: "down", exposureAud: 8_000_000_000, notices: 4 },
      { kind: "super_fund", industry: "Materials", direction: "up", exposureAud: 500_000_000, notices: 1 },
      { kind: "index_manager", industry: "Financials", direction: "down", exposureAud: 700_000_000, notices: 2 },
    ];
    const layout = changeFlows(changes, 400, 300);
    expect(top(layout.nodes, "holder")).toEqual(["Index manager", "Super fund", "Unclassified"]);
  });

  it("orders the sector column by exposure, largest at the top", () => {
    const layout = positionFlows(ROWS, 400, 300);
    expect(top(layout.nodes, "sector")).toEqual(["Materials", "Financials"]);
  });

  it("draws the Other sectors fold last in the sector column, even when it is the largest", () => {
    const folded: FlowPositionRow[] = [
      { kind: "super_fund", industry: "Materials", exposureAud: 1_000_000_000, holdings: 1, largestCode: "BHP", largestPct: 9 },
      { kind: "super_fund", industry: FOLDED_SECTOR_LABEL, exposureAud: 6_000_000_000, holdings: 4, largestCode: "", largestPct: 2 },
      { kind: "hedge_fund", industry: "Financials", exposureAud: 3_000_000_000, holdings: 1, largestCode: "CBA", largestPct: 6 },
    ];
    const layout = positionFlows(folded, 400, 300);
    expect(top(layout.nodes, "sector")).toEqual(["Financials", "Materials", FOLDED_SECTOR_LABEL]);
  });
});

describe("labels (spec B6)", () => {
  it("splits a label at the space that leaves its wider line the narrower", () => {
    expect(splitLabel("Pharma & biotech")).toEqual(["Pharma &", "biotech"]);
    expect(splitLabel("Durables & apparel")).toEqual(["Durables &", "apparel"]);
    expect(splitLabel("Professional services")).toEqual(["Professional", "services"]);
    expect(splitLabel("Other sectors")).toEqual(["Other", "sectors"]);
  });

  it("has no split for a single word, which is never cut", () => {
    expect(splitLabel("Semiconductors")).toBeNull();
  });

  it("keeps a label that fits its room on one line", () => {
    expect(labelLines("Materials", 10.5, 90)).toEqual(["Materials"]);
  });

  it("wraps a label longer than its room at a space, and the two lines join back to the label", () => {
    const lines = labelLines("Professional services", 10.5, 90);
    expect(lines).toEqual(["Professional", "services"]);
    expect(lines.join(" ")).toBe("Professional services");
  });

  it("keeps a single word whole, even past its room", () => {
    expect(labelLines("Semiconductors", 10.5, 40)).toEqual(["Semiconductors"]);
  });

  it("measures a label from its characters at the font size", () => {
    expect(labelWidth("Unclassified", 12)).toBeCloseTo(12 * 0.62 * 12, 6);
  });
});

describe("the gutters grown from the labels (spec B6)", () => {
  const DESKTOP = { left: 150, right: 150, font: 12, wrapRight: false };
  const PHONE = { left: 92, right: 96, font: 10.5, wrapRight: true };

  it("keeps the floor when every label fits inside it", () => {
    expect(flowGutters(["Unclassified", "Bank/broker"], ["Materials", "Other"], DESKTOP)).toEqual({ left: 150, right: 150 });
  });

  it("widens the left gutter to the longest label drawn in it", () => {
    const long = "A kind name of forty characters, drawn in full";
    const { left } = flowGutters([long], [], DESKTOP);
    expect(left).toBe(Math.ceil(labelWidth(long, 12) + LABEL_GAP));
    expect(left).toBeGreaterThan(150);
  });

  it("widens the desktop's right gutter to hold the longest sector name on one line", () => {
    const { right } = flowGutters([], ["Professional services"], DESKTOP);
    expect(right).toBe(Math.ceil(labelWidth("Professional services", 12) + LABEL_GAP));
    expect(right).toBeGreaterThan(150);
  });

  it("on the phone, wraps a right label to two lines before it widens the gutter", () => {
    // Its wider half, "Professional", is narrower than the phone's floor less the clearance.
    expect(flowGutters([], ["Professional services"], PHONE).right).toBe(96);
  });

  it("on the phone, widens for a single word wider than the floor, never cutting it", () => {
    const { right } = flowGutters([], ["Semiconductors"], PHONE);
    expect(right).toBe(Math.ceil(labelWidth("Semiconductors", 10.5) + LABEL_GAP));
    expect(right).toBeGreaterThan(96);
  });

  it("on the phone, widens a many-word label only to its narrowest two-line width", () => {
    // Split at the second space: "Corporation International" is the wider half, narrower than the whole.
    const { right } = flowGutters([], ["Quantum Widgets Corporation International"], PHONE);
    expect(right).toBe(Math.ceil(labelWidth("Corporation International", 10.5) + LABEL_GAP));
    expect(right).toBeLessThan(Math.ceil(labelWidth("Quantum Widgets Corporation International", 10.5) + LABEL_GAP));
  });
});

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
