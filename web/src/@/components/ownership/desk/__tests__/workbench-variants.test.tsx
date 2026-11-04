/// <reference types="jest" />

import { render, screen } from "@testing-library/react";
import type { OwnershipActivityPage, OwnershipFlowsPage, OwnershipMapPage } from "~/app/actions/ownershipDesk";
import { layoutMap, type MapStockRow } from "../map-layout";
import { DISCLOSED_AREA_FLOOR, OwnershipMapStatic, sizedRows } from "../ownership-map-static";
import { largestConnections, measurePage } from "../ownership-flows-static";
import { MovementHeatmapView, weekList } from "../movement-heatmap-static";
import { DESK_DEFAULT_WINDOW_STATE } from "../window-chips";

function stock(code: string, industry: string, disclosedPct: number, marketCap: number | null = 1e9): MapStockRow {
  return {
    code,
    name: `${code} Ltd`,
    industry,
    marketCap,
    disclosedPct,
    institutionalPct: 0,
    hedgePct: 0,
    indexPct: null,
    shortPct: null,
    flowPp: null,
    notices: 1,
  };
}

describe("the map's size (spec 14.3, Market map)", () => {
  const stocks = [stock("AAA", "Materials", 30), stock("BBB", "Materials", 10)];
  const areaOf = (layout: ReturnType<typeof layoutMap>, code: string) => {
    const cell = layout.cells.find((c) => c.code === code)!;
    return (cell.x1 - cell.x0) * (cell.y1 - cell.y0);
  };

  it("draws the market cap by default, so the two equal caps take equal areas", () => {
    const layout = layoutMap(stocks, { width: 1000, height: 560, lens: "disclosed" });
    expect(areaOf(layout, "AAA") / areaOf(layout, "BBB")).toBeCloseTo(1, 1);
  });

  it("draws the disclosed exposure when asked, so the larger interest takes the larger area", () => {
    const layout = layoutMap(sizedRows(stocks, "disclosed"), { width: 1000, height: 560, lens: "disclosed" });
    expect(areaOf(layout, "AAA") / areaOf(layout, "BBB")).toBeCloseTo(3, 1);
  });

  it("gives a stock with no disclosed interest a sliver, never zero area", () => {
    const layout = layoutMap(sizedRows([stock("AAA", "Materials", 0), stock("BBB", "Materials", 10)], "disclosed"), {
      width: 1000,
      height: 560,
      lens: "disclosed",
    });
    expect(areaOf(layout, "AAA")).toBeGreaterThan(0);
    expect(DISCLOSED_AREA_FLOOR).toBeGreaterThan(0);
    expect(sizedRows(stocks, "market_cap")).toBe(stocks);
  });
});

const flowRow = (kind: string, industry: string, exposureAud: number, holdings: number) => ({
  kind,
  industry,
  exposureAud,
  holdings,
  largestCode: "BHP",
  largestPct: 5,
});

const flows: OwnershipFlowsPage = {
  ok: true,
  error: "",
  from: "",
  to: "",
  asOf: "2026-10-30",
  positions: [
    flowRow("super_fund", "Materials", 900, 3),
    flowRow("index_manager", "Financials", 400, 9),
    flowRow("hedge_fund", "Health", 100, 1),
  ],
  changes: [],
};

describe("the flows' measure and largest connections (spec 14.3, Connections)", () => {
  it("keeps the exposure by default and draws the number of interests in count mode", () => {
    expect(measurePage(flows, "exposure")).toBe(flows);
    const counted = measurePage(flows, "count");
    expect(counted.positions.map((row) => row.exposureAud)).toEqual([3, 9, 1]);
  });

  it("keeps the N largest bands by the measure drawn, and every band for all", () => {
    expect(largestConnections(flows, "all")).toBe(flows);
    const top = largestConnections(flows, "10");
    expect(top.positions.map((row) => row.industry)).toEqual(["Materials", "Financials", "Health"]);
    expect(largestConnections(flows, "20").positions).toHaveLength(3);
    const one = largestConnections(measurePage(flows, "count"), "10");
    expect(one.positions.map((row) => row.exposureAud)).toEqual([3, 9, 1]);
  });
});

describe("the variants draw what their wireframe names", () => {
  const page: OwnershipMapPage = {
    ok: true,
    error: "",
    from: "2026-08-01",
    to: "2026-10-30",
    asOf: "2026-10-30",
    stocks: [stock("AAA", "Materials", 30), stock("BBB", "Financials", 10)],
  };

  it("draws the compact map without its window and colour chips, and the full map with its zoom and list links", () => {
    const { unmount } = render(<OwnershipMapStatic initial={page} variant="compact" />);
    expect(screen.queryByRole("combobox", { name: "Colour" })).toBeNull();
    expect(screen.queryByRole("link", { name: "View as list" })).toBeNull();
    unmount();
    render(<OwnershipMapStatic initial={page} variant="full" />);
    expect(screen.getByRole("combobox", { name: "Colour" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "View as list" })).toHaveAttribute("href", "/ownership/stocks");
  });

  it("draws the movement grid in count mode with the same sr-only table", () => {
    const weeks = weekList("2026-10-19", "2026-10-26");
    const activity: OwnershipActivityPage = {
      ok: true,
      error: "",
      fromWeek: weeks[0]!,
      toWeek: weeks[weeks.length - 1]!,
      asOf: "2026-10-30",
      rows: [
        {
          industry: "Materials",
          weekStart: weeks[0]!,
          became: 2,
          increased: 1,
          decreased: 0,
          changed: 0,
          ceased: 0,
          nz: 0,
          netPp: 1.5,
        },
      ],
    };
    render(
      <MovementHeatmapView
        page={activity}
        state={DESK_DEFAULT_WINDOW_STATE}
        basePath="/ownership/activity"
        params={new URLSearchParams()}
        measure="count"
        workspace
      />,
    );
    expect(screen.getByText(/the number of notices released that week/)).toBeInTheDocument();
  });
});
