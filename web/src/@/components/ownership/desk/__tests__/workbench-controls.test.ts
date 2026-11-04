/// <reference types="jest" />

import type { OwnershipFlowsPage } from "~/app/actions/ownershipDesk";
import { cellFigure, type HeatCell } from "../movement-heatmap-static";
import { drillPage, type DrillPatch } from "../ownership-flows-static";
import { drillCrumbs } from "../ownership-flows";
import { DISCLOSED_AREA_FLOOR, estimatedAreaCodes, sizedRows } from "../ownership-map-static";
import { findOptions } from "../desk-toolbar";
import type { MapStockRow } from "../map-layout";
import { cellNoticesHref } from "~/@/components/ownership/workspace/inspectors/cell-inspector";

const EM_DASH = String.fromCharCode(0x2014);
const TRUE_MINUS = String.fromCharCode(0x2212);

function flows(overrides: Partial<OwnershipFlowsPage> = {}): OwnershipFlowsPage {
  return {
    ok: true,
    error: "",
    from: "",
    to: "",
    asOf: "2026-10-30",
    positions: [
      { kind: "index_manager", industry: "Materials", exposureAud: 5, holdings: 2, largestCode: "BHP", largestPct: 4 },
      { kind: "index_manager", industry: "Banks", exposureAud: 3, holdings: 1, largestCode: "CBA", largestPct: 2 },
      { kind: "super_fund", industry: "Materials", exposureAud: 1, holdings: 1, largestCode: "RIO", largestPct: 1 },
    ],
    changes: [],
    ...overrides,
  };
}

function stock(code: string, marketCap: number | null, disclosedPct: number): MapStockRow {
  return {
    code,
    name: code,
    industry: "Materials",
    marketCap,
    disclosedPct,
    institutionalPct: 0,
    hedgePct: 0,
  } as unknown as MapStockRow;
}

describe("the Connections drilldown (spec 14.3, Connections; spec 14.7)", () => {
  it("builds the breadcrumb from the kind and the sector, and none when nothing is drilled", () => {
    expect(drillCrumbs({})).toEqual([]);
    expect(drillCrumbs({ kind: "index_manager" }).map((c) => c.label)).toEqual(["All holders", "Index managers"]);
    expect(drillCrumbs({ kind: "index_manager", sector: "Materials" }).map((c) => c.label)).toEqual([
      "All holders",
      "Index managers",
      "Materials",
    ]);
  });

  it("keeps the bands of the kind, of the sector, or of both", () => {
    const drilled = (drill: DrillPatch) => drillPage(flows(), drill).positions.map((row) => `${row.kind}/${row.industry}`);
    expect(drilled({})).toHaveLength(3);
    expect(drilled({ kind: "index_manager" })).toEqual(["index_manager/Materials", "index_manager/Banks"]);
    expect(drilled({ sector: "Materials" })).toEqual(["index_manager/Materials", "super_fund/Materials"]);
    expect(drilled({ kind: "index_manager", sector: "Materials" })).toEqual(["index_manager/Materials"]);
  });
});

describe("the Activity grid's figures (spec 14.3, Activity)", () => {
  const cell = (overrides: Partial<HeatCell>): HeatCell => ({
    weekStart: "2026-10-26",
    notices: 0,
    counts: { became: 0, increased: 0, decreased: 0, changed: 0, ceased: 0, nz: 0 },
    netPp: null,
    ...overrides,
  });

  it("prints the count in count mode, and the net in points with a true minus in pp mode", () => {
    expect(cellFigure(cell({ notices: 14 }), "count")).toBe("14");
    expect(cellFigure(cell({ notices: 3, netPp: -1.25 }), "pp")).toBe(`${TRUE_MINUS}1.3`);
    expect(cellFigure(cell({ notices: 3, netPp: 2.04 }), "pp")).toBe("+2.0");
  });

  it("prints a dash for a zero net, and nothing for a cell that states no figure", () => {
    expect(cellFigure(cell({ notices: 2, netPp: 0 }), "pp")).toBe(String.fromCharCode(0x2013));
    expect(cellFigure(cell({ notices: 2, netPp: null }), "pp")).toBeNull();
  });

  it("carries the holder kind into the cell's feed link, and omits it for every kind", () => {
    expect(cellNoticesHref("Materials", "2026-10-26", "index_manager")).toBe(
      "/ownership/notices?industry=Materials&kind=index_manager&since=2026-10-26&until=2026-11-01",
    );
    expect(cellNoticesHref("Materials", "2026-10-26")).not.toContain("kind=");
  });
});

describe("the compact map's areas (spec 14.3, Market map's Size)", () => {
  it("scales the floor of a stock with no interest to the data, so it is drawn", () => {
    const rows = [stock("AAA", 1e11, 10), stock("BBB", 1e11, 0)];
    const sized = sizedRows(rows, "disclosed");
    const smallest = Math.min(...sized.map((row) => row.marketCap ?? 0));
    expect(smallest).toBeGreaterThan(0);
    expect(sized[1]?.marketCap).toBeCloseTo(1e10 * DISCLOSED_AREA_FLOOR, 0);
    expect(DISCLOSED_AREA_FLOOR).toBeGreaterThan(0);
  });

  it("names the stocks whose area is estimated from the median, as the Size draws them", () => {
    expect([...estimatedAreaCodes([stock("AAA", null, 1), stock("BBB", 5, 1)])]).toEqual(["AAA"]);
  });
});

describe("the Overview's toolbar (spec 14.3, Overview)", () => {
  it("offers every stock by its code and every holder by its name, and never an em dash", () => {
    const options = findOptions([{ code: "BHP", name: "BHP Group" }], [{ slug: "vanguard", name: "Vanguard" }]);
    expect(options).toEqual([
      { value: "stock:BHP", label: "BHP, BHP Group", keywords: ["BHP Group"] },
      { value: "holder:vanguard", label: "Vanguard", description: "Holder" },
    ]);
    expect(JSON.stringify(options)).not.toContain(EM_DASH);
  });
});
