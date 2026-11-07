/// <reference types="jest" />

/**
 * The critique pass (spec 14.9), rule by rule: the map's ticker from its cell, the five
 * bins of every lens, the folded sankey, the toolbar's single row, a heatmap cell that
 * selects, and the holders' twenty largest.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { render, screen, fireEvent, within } from "@testing-library/react";
import type { OwnershipActivityPage, OwnershipFlowsPage, FlowPositionRow, FlowChangeRow } from "~/app/actions/ownershipDesk";
import { OwnershipMapStatic } from "../ownership-map-static";
import { OwnershipFlowsStatic } from "../ownership-flows-static";
import { MovementHeatmapView } from "../movement-heatmap-static";
import { tickerSize, labelColourFor, figureSizeFor } from "../ownership-map-static";
import { foldSectors, flowLayout, FLOW_SIZES, FLOW_SECTOR_KEEP, holderBodyFill, OwnershipFlowsView } from "../ownership-flows-static";
import { FOLDED_SECTOR_LABEL, KIND_ORDER, kindSelectLabel } from "~/@/lib/ownership/kinds";
import { Toolbar, TOOLBAR_COMBOBOX_ROW_CLASS } from "~/@/components/workspace/toolbar";
import { WindowSelect } from "../../workspace/window-select";
import { directoryRows, DIRECTORY_FIRST } from "../../holders/holder-browser";
import type { HolderRow } from "../../holders/holder-tree";
import { DESK_DEFAULT_WINDOW_STATE } from "../window-chips";
import { lensScale } from "../desk-scales";
import { DESK_DEFAULT_WINDOW_STATE as WINDOW } from "../window-chips";

const SECTORS = [
  "Materials",
  "Banks",
  "Energy",
  "Software & Services",
  "Insurance",
  "Utilities",
  "Transportation",
  "Telecommunication Services",
];

function position(industry: string, exposure: number, kind = "super_fund"): FlowPositionRow {
  return { kind, industry, exposureAud: exposure, holdings: 2, largestCode: "BHP", largestPct: 5 };
}

function flowPage(positions: FlowPositionRow[], changes: FlowChangeRow[] = []): OwnershipFlowsPage {
  return { ok: true, error: "", from: "2026-08-01", to: "2026-10-31", asOf: "2026-10-31", positions, changes };
}

describe("the map's ticker (spec 14.9)", () => {
  it("sizes the code from the cell: a fifth of its width or a quarter of its height, clamped to 12 to 64", () => {
    expect(tickerSize(500, 400)).toBe(64);
    expect(tickerSize(200, 120)).toBe(30);
    expect(tickerSize(40, 20)).toBe(12);
  });

  it("draws the code at that size in the cell's own SVG", () => {
    const page = {
      ok: true,
      error: "",
      asOf: "2026-11-03",
      stocks: [
        {
          code: "BHP",
          name: "BHP Group",
          industry: "Materials",
          marketCap: 2.4e11,
          disclosedPct: 9.8,
          institutionalPct: 9.8,
          hedgePct: 0,
          indexPct: null,
          flowPp: null,
          notices: 1,
        },
      ],
    } as unknown as Parameters<typeof OwnershipMapStatic>[0]["initial"];
    const { container } = render(<OwnershipMapStatic initial={page} variant="full" />);
    const label = container.querySelector('g[data-code="BHP"] text');
    expect(label).not.toBeNull();
    expect(Number(label?.getAttribute("font-size"))).toBeGreaterThanOrEqual(12);
  });

  it("sizes the figure from the ticker, so a large cell's figure is not a speck", () => {
    expect(figureSizeFor(tickerSize(500, 400))).toBe(28);
    expect(figureSizeFor(tickerSize(40, 20))).toBe(11);
    expect(figureSizeFor(tickerSize(200, 120))).toBeGreaterThan(11);
  });

  it("takes each stop's own ink token, so a full fill stays legible in both themes", () => {
    const scale = lensScale("disclosed", [10]);
    expect(labelColourFor(1, scale)).toBe("hsl(var(--desk-bin-ink-0))");
    expect(labelColourFor(10, scale)).toBe("hsl(var(--desk-bin-ink-4))");
    expect(labelColourFor(null, scale)).toBe("hsl(var(--foreground))");
  });
});

describe("the five bins of every lens (spec 14.9)", () => {
  it.each(["disclosed", "institutional", "hedge", "index", "short"] as const)("quantises %s into five steps", (lens) => {
    const scale = lensScale(lens, [1, 5, 10, 20]);
    expect(scale.hi / scale.step).toBeCloseTo(5, 10);
  });

  it("quantises the flow into five steps centred on zero", () => {
    const scale = lensScale("flow", [-3, 3]);
    expect(scale.mode).toBe("diverging");
    expect(scale.hi / scale.step).toBeCloseTo(2, 10);
    expect(scale.lo).toBe(-scale.hi);
  });
});

describe("the folded sankey (spec 14.9)", () => {
  const rows = SECTORS.map((industry, index) => position(industry, (SECTORS.length - index) * 1e9));

  it("keeps the six largest sectors and folds the rest into one bucket", () => {
    const folded = foldSectors(flowPage(rows));
    const sectors = new Set(folded.positions.map((row) => row.industry));
    expect(sectors.size).toBe(FLOW_SECTOR_KEEP + 1);
    expect(sectors.has(FOLDED_SECTOR_LABEL)).toBe(true);
    expect(folded.positions.filter((row) => row.industry === FOLDED_SECTOR_LABEL)).toHaveLength(2);
  });

  it("draws seven sector nodes folded and every sector unfolded, the table keeps every row", () => {
    const folded = flowLayout(foldSectors(flowPage(rows)), "positions", FLOW_SIZES.full);
    const sectorNodes = folded.nodes.filter((node) => node.kind === "sector");
    expect(sectorNodes).toHaveLength(FLOW_SECTOR_KEEP + 1);
    const open = flowLayout(flowPage(rows), "positions", FLOW_SIZES.full);
    expect(open.nodes.filter((node) => node.kind === "sector")).toHaveLength(SECTORS.length);
  });

  it("leaves a page with no more than six sectors as it is", () => {
    const few = flowPage(rows.slice(0, 3));
    expect(foldSectors(few)).toEqual(few);
  });

  it("muted for unclassified holders, never the brightest node", () => {
    expect(holderBodyFill("unclassified")).toBe("hsl(var(--muted-foreground))");
  });
});

describe("the toolbar's single row (spec 14.9)", () => {
  it("draws its controls once, in one row, and the fold only where an island passes one", () => {
    const { container, unmount } = render(
      <Toolbar>
        <span>Source</span>
        <span>Colour</span>
      </Toolbar>,
    );
    expect(container.querySelectorAll("details")).toHaveLength(0);
    expect(container.querySelectorAll(".flex")).toHaveLength(1);
    unmount();
    render(
      <Toolbar fold={(row) => <details data-fold="yes">{row}</details>}>
        <span>Source</span>
      </Toolbar>,
    );
    expect(document.querySelectorAll("details[data-fold='yes']")).toHaveLength(1);
    expect(screen.getAllByText("Source")).toHaveLength(1);
  });
});

describe("the heatmap's cell (spec 14.9)", () => {
  it("selects a visible cell on click and on Enter, and names its sector in full", () => {
    const onCellSelect = jest.fn();
    const weeks = ["2026-10-26", "2026-11-02"];
    const page: OwnershipActivityPage = {
      ok: true,
      error: "",
      fromWeek: weeks[0]!,
      toWeek: weeks[1]!,
      asOf: "2026-11-03",
      rows: [
        { industry: "Materials", weekStart: weeks[0]!, became: 1, increased: 1, decreased: 0, changed: 0, ceased: 0, nz: 0, netPp: 0.5 },
      ],
    };
    const { container } = render(
      <MovementHeatmapView
        page={page}
        state={DESK_DEFAULT_WINDOW_STATE}
        basePath="/ownership/activity"
        params={new URLSearchParams()}
        workspace
        onCellSelect={onCellSelect}
      />,
    );
    const cell = container.querySelector('g[role="button"][data-sector="Materials"][data-week="2026-10-26"]');
    expect(cell).not.toBeNull();
    fireEvent.click(cell as Element);
    expect(onCellSelect).toHaveBeenCalledWith("Materials", "2026-10-26");
    fireEvent.keyDown(cell as Element, { key: "Enter" });
    expect(onCellSelect).toHaveBeenCalledTimes(2);
  });
});

describe("the holders' directory (spec 14.9)", () => {
  const holders: HolderRow[] = Array.from({ length: 25 }, (_, i) => ({
    key: `h${i}`,
    name: `Holder ${i}`,
    kind: "index_manager",
    website: "",
    positions: i === 0 ? 0 : 100 - i,
  })) as HolderRow[];

  it("draws the twenty largest, hides a holder with no position, and offers the rest", () => {
    const { rows, total } = directoryRows(holders, "all", "", false);
    expect(rows).toHaveLength(DIRECTORY_FIRST);
    expect(total).toBe(24);
    expect(rows.every((row) => row.positions > 0)).toBe(true);
    expect(rows[0]!.positions).toBeGreaterThan(rows[1]!.positions - 1);
    expect(directoryRows(holders, "all", "", true).rows).toHaveLength(24);
  });

  it("shows a holder with no position under a kind chip, and every match of a find", () => {
    expect(directoryRows(holders, "index_manager", "", true).rows.some((row) => row.positions === 0)).toBe(true);
    // A find shows its matches, but a holder with no position stays hidden under the "all" chip.
    expect(directoryRows(holders, "all", "Holder 0", false).rows).toHaveLength(0);
    expect(directoryRows(holders, "all", "Holder 24", false).rows).toHaveLength(1);
  });
});

describe("the folded tail's band and toggle (spec 14.9)", () => {
  const rows = SECTORS.map((industry, index) => position(industry, (SECTORS.length - index) * 1e9));

  it("opens the tail when a folded band is pressed, and selects nothing", () => {
    const onSelect = jest.fn();
    const onExpandOther = jest.fn();
    const { container } = render(
      <OwnershipFlowsView
        page={flowPage(rows)}
        mode="positions"
        state={WINDOW}
        basePath="/ownership/connections"
        params={new URLSearchParams()}
        onSelect={onSelect}
        onExpandOther={onExpandOther}
      />,
    );
    const band = container.querySelector(`svg a[aria-label*="${FOLDED_SECTOR_LABEL}"]`);
    expect(band).not.toBeNull();
    fireEvent.click(band as Element);
    expect(onExpandOther).toHaveBeenCalledTimes(1);
    expect(onSelect).not.toHaveBeenCalled();
  });

  it("toggles the tail beneath the drawings, with aria-expanded, on the Connections page only", () => {
    const { rerender } = render(
      <OwnershipFlowsView
        page={flowPage(rows)}
        mode="positions"
        state={WINDOW}
        basePath="/ownership/connections"
        params={new URLSearchParams()}
        tailToggle
        onExpandOther={jest.fn()}
        onFoldOther={jest.fn()}
      />,
    );
    const open = screen.getByRole("button", { name: "Expand Other +" });
    expect(open).toHaveAttribute("aria-expanded", "false");
    rerender(
      <OwnershipFlowsView
        page={flowPage(rows)}
        mode="positions"
        state={WINDOW}
        basePath="/ownership/connections"
        params={new URLSearchParams()}
        tailToggle
        expandOther
        onExpandOther={jest.fn()}
        onFoldOther={jest.fn()}
      />,
    );
    expect(screen.getByRole("button", { name: "Fold to six sectors" })).toHaveAttribute("aria-expanded", "true");
  });
});

describe("the window is one labelled select on each instrument's toolbar (spec 14.9)", () => {
  const ACTIVITY: OwnershipActivityPage = {
    ok: true,
    error: "",
    fromWeek: "2026-10-26",
    toWeek: "2026-11-02",
    asOf: "2026-11-03",
    rows: [
      { industry: "Materials", weekStart: "2026-10-26", became: 1, increased: 1, decreased: 0, changed: 0, ceased: 0, nz: 0, netPp: 0.5 },
    ],
  };
  const MAP = {
    ok: true,
    error: "",
    asOf: "2026-11-03",
    stocks: [
      {
        code: "BHP",
        name: "BHP Group",
        industry: "Materials",
        marketCap: 2.4e11,
        disclosedPct: 9.8,
        institutionalPct: 9.8,
        hedgePct: 0,
        indexPct: null,
        flowPp: null,
        notices: 1,
      },
    ],
  } as unknown as Parameters<typeof OwnershipMapStatic>[0]["initial"];

  /** One select, four options, no window link, and the row it sits in is the toolbar's single row. */
  function expectOneWindowSelect(container: HTMLElement) {
    const window = within(container).getByRole("combobox", { name: "Window" }) as HTMLSelectElement;
    expect(window.tagName).toBe("SELECT");
    expect(Array.from(window.options).map((option) => option.textContent)).toEqual(["28 days", "91 days", "182 days", "364 days"]);
    expect(within(container).queryAllByRole("link", { name: /days$/ })).toHaveLength(0);
    expect(container.querySelectorAll("[data-toolbar]")).toHaveLength(1);
    expect(window.closest("[data-toolbar]")).not.toBeNull();
  }

  it("on the market map's static toolbar", () => {
    const { container } = render(<OwnershipMapStatic initial={MAP} />);
    expectOneWindowSelect(container);
  });

  it("on the connections' static toolbar, with Positions | Changes as the one segmented control", () => {
    const { container } = render(
      <OwnershipFlowsStatic page={flowPage([position("Materials", 1e9)])} state={WINDOW} basePath="/ownership/connections" />,
    );
    expectOneWindowSelect(container);
    expect(within(container).getByRole("group", { name: "What the bands show" })).toBeInTheDocument();
  });

  it("on the activity's static toolbar", () => {
    const { container } = render(
      <MovementHeatmapView page={ACTIVITY} state={DESK_DEFAULT_WINDOW_STATE} basePath="/ownership/activity" params={new URLSearchParams()} workspace />,
    );
    expectOneWindowSelect(container);
  });

  it("names a brushed window 'Brushed' (the dates are the caption's), so the select does not widen", () => {
    render(
      <WindowSelect
        active={{ window: 91, since: "2026-08-01", until: "2026-10-31" }}
        onWindowChange={() => undefined}
      />,
    );
    const select = screen.getByRole("combobox", { name: "Window" }) as HTMLSelectElement;
    expect(Array.from(select.options).map((option) => option.textContent)).toEqual(["Brushed", "28 days", "91 days", "182 days", "364 days"]);
  });

  it("names every kind in the Holder type select in at most 15 characters, so the activity row keeps its room", () => {
    // The Holder type select is the island's (the static view draws none), so the names are pinned by the function it reads.
    for (const kind of KIND_ORDER) expect(kindSelectLabel(kind).length).toBeLessThanOrEqual(15);
    expect(kindSelectLabel("sovereign_public")).toBe("Sovereign");
  });
});

describe("the map's toolbar placeholder matches its tallest control (spec 14.9)", () => {
  it("reserves the Gamma combobox's field height, which gamma.css sets as its min-height", () => {
    // The stylesheet is read rather than restated: a change to the library's min-height fails here first.
    const css = readFileSync(join(__dirname, "../../../gamma/gamma.css"), "utf8");
    const block = /\.search-combobox-field\s*\{([^}]*)\}/.exec(css)?.[1] ?? "";
    const minHeightPx = Number(/min-height:\s*(\d+)px/.exec(block)?.[1]);
    expect(minHeightPx).toBeGreaterThan(0);
    expect(TOOLBAR_COMBOBOX_ROW_CLASS).toBe(`h-5 sm:h-${minHeightPx / 4}`);
  });
});

describe("the heatmap's keyboard path (spec 14.9)", () => {
  it("reveals the sr-only table while one of its Select buttons has focus, and the button takes focus", () => {
    const page: OwnershipActivityPage = {
      ok: true,
      error: "",
      fromWeek: "2026-10-26",
      toWeek: "2026-11-02",
      asOf: "2026-11-03",
      rows: [
        { industry: "Materials", weekStart: "2026-10-26", became: 1, increased: 1, decreased: 0, changed: 0, ceased: 0, nz: 0, netPp: 0.5 },
      ],
    };
    render(
      <MovementHeatmapView
        page={page}
        state={DESK_DEFAULT_WINDOW_STATE}
        basePath="/ownership/activity"
        params={new URLSearchParams()}
        workspace
        onCellSelect={jest.fn()}
      />,
    );
    const select = screen.getByRole("button", { name: "Select Materials, week of 2026-10-26" });
    select.focus();
    expect(document.activeElement).toBe(select);
    // The table is the screen reader's clipped table until a Select has focus, then it shows (focus-within).
    expect(select.closest(".sr-only")).toHaveClass("focus-within:not-sr-only");
    expect(select.className).toContain("focus-visible:ring-2");
  });
});
