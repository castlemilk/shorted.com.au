import { render, screen, within } from "@testing-library/react";

import type { OwnershipMapPage } from "~/app/actions/ownershipDesk";
import { layoutMap, type MapCell, type MapStockRow } from "../map-layout";
import { DEFAULT_DESK_STATE } from "../desk-state";
import { mapCaption } from "../lens-legend";
import {
  HATCH_ID,
  MAP_EMPTY_COPY,
  MAP_HEIGHT,
  MAP_WIDTH,
  NO_FIGURE_COPY,
  OwnershipMapStatic,
  OwnershipMapView,
  labelColourFor,
  nextCellIndex,
  zoomPose,
  zoomStyle,
} from "../ownership-map-static";
import { lensScale } from "../desk-scales";

function stock(overrides: Partial<MapStockRow> & { code: string }): MapStockRow {
  return {
    name: `${overrides.code} Ltd`,
    industry: "Materials",
    marketCap: 1_000,
    disclosedPct: 10,
    institutionalPct: 6,
    hedgePct: 2,
    indexPct: 4,
    shortPct: 3,
    flowPp: 0.5,
    notices: 2,
    ...overrides,
  };
}

const STOCKS: MapStockRow[] = [
  stock({ code: "BHP", name: "BHP Group", marketCap: 300_000, disclosedPct: 41.2 }),
  stock({ code: "RIO", name: "Rio Tinto", marketCap: 200_000, disclosedPct: 12.5, industry: "Materials" }),
  stock({ code: "CBA", name: "Commonwealth Bank", marketCap: 150_000, disclosedPct: 9.5, industry: "Financials", shortPct: null }),
  stock({ code: "ZZZ", name: "Unclassified Co", marketCap: null, disclosedPct: 5, industry: "Not Applic", flowPp: -0.31 }),
];

function page(overrides: Partial<OwnershipMapPage> = {}): OwnershipMapPage {
  return {
    ok: true,
    error: "",
    from: "2026-07-14",
    to: "2026-10-12",
    asOf: "2026-10-12",
    stocks: STOCKS,
    ...overrides,
  };
}

function cell(overrides: Partial<MapCell> & { code: string; x0: number; y0: number; x1: number; y1: number }): MapCell {
  return {
    name: overrides.code,
    sector: "Materials",
    marketCap: 1,
    areaEstimated: false,
    value: 1,
    hatched: false,
    notices: 0,
    ...overrides,
  };
}

describe("nextCellIndex", () => {
  // A row of three across the top and one below the first.
  const cells: MapCell[] = [
    cell({ code: "A", x0: 0, y0: 0, x1: 100, y1: 100 }),
    cell({ code: "B", x0: 100, y0: 0, x1: 200, y1: 100 }),
    cell({ code: "C", x0: 200, y0: 0, x1: 300, y1: 100 }),
    cell({ code: "D", x0: 0, y0: 100, x1: 100, y1: 200 }),
  ];

  it("moves to the nearest cell in the arrow's direction, preferring the same row", () => {
    expect(nextCellIndex(cells, 0, "ArrowRight")).toBe(1);
    expect(nextCellIndex(cells, 2, "ArrowLeft")).toBe(1);
    expect(nextCellIndex(cells, 0, "ArrowDown")).toBe(3);
    expect(nextCellIndex(cells, 3, "ArrowUp")).toBe(0);
  });

  it("stays put at an edge, on a key it does not move by, and for a missing cell", () => {
    expect(nextCellIndex(cells, 2, "ArrowRight")).toBe(2);
    expect(nextCellIndex(cells, 0, "Enter")).toBe(0);
    expect(nextCellIndex(cells, 9, "ArrowRight")).toBe(9);
  });
});

describe("zoomPose and zoomStyle", () => {
  const box = { x0: 250, y0: 140, x1: 500, y1: 420 };

  it("starts a zoom in at the sector's box, so the sector fills the map", () => {
    expect(zoomPose(box, "in")).toBe(
      `translate(250px, 140px) scale(${250 / MAP_WIDTH}, ${280 / MAP_HEIGHT})`,
    );
  });

  it("starts a zoom out with the whole market scaled so the sector's box fills the map", () => {
    expect(zoomPose(box, "out")).toBe(
      `scale(${MAP_WIDTH / 250}, ${MAP_HEIGHT / 280}) translate(-250px, -140px)`,
    );
  });

  it("has no pose for a degenerate box", () => {
    expect(zoomPose({ x0: 10, y0: 10, x1: 10, y1: 80 }, "in")).toBeNull();
  });

  it("jumps to a pose with no transition, and carries no transform at rest", () => {
    expect(zoomStyle("translate(1px, 2px) scale(0.5, 0.5)")).toMatchObject({
      transform: "translate(1px, 2px) scale(0.5, 0.5)",
      transition: "none",
      transformOrigin: "0 0",
    });
    expect(zoomStyle(null)).not.toHaveProperty("transform");
  });
});

describe("labelColourFor", () => {
  it("is paper on the deepest step and ink on the pale ones (spec 14.9)", () => {
    const scale = lensScale("disclosed", [10]);
    expect(labelColourFor(1, scale)).toBe("hsl(var(--foreground))");
    expect(labelColourFor(10, scale)).toBe("hsl(var(--background))");
  });
});

describe("OwnershipMapStatic", () => {
  it("draws the default view on the server: a table row and a title for every stock", () => {
    const { container } = render(<OwnershipMapStatic initial={page()} />);
    const table = screen.getByRole("table", { name: "Sectors and stocks, by Disclosed by notices" });
    const rows = within(table).getAllByRole("row").slice(1);
    expect(rows).toHaveLength(STOCKS.length);
    for (const s of STOCKS) {
      expect(container.querySelector(`g[data-code="${s.code}"] > title`)?.textContent).toContain(s.code);
    }
  });

  it("draws no handler on the server: cells are images, not buttons", () => {
    const { container } = render(<OwnershipMapStatic initial={page()} />);
    expect(container.querySelectorAll('[role="button"]')).toHaveLength(0);
    expect(container.querySelector('g[data-code="BHP"]')?.getAttribute("role")).toBe("img");
  });

  it("hatches a stock with no figure for the lens, and never paints it as zero", () => {
    const { container } = render(
      <OwnershipMapView page={page()} desk={{ ...DEFAULT_DESK_STATE, lens: "short" }} status="idle" slow={false} basePath="/ownership" />,
    );
    // CBA has no short figure: its cell is the hatch, and its label is the foreground.
    expect(container.querySelector(`g[data-code="CBA"] rect`)?.getAttribute("fill")).toBe(`url(#${HATCH_ID})`);
    expect(container.querySelector(`g[data-code="BHP"] rect`)?.getAttribute("fill")).not.toContain(HATCH_ID);
    // CBA is the top-left cell of Financials, whose name is printed over its top: its code starts under
    // the 20-unit band, so a cell that fills its sector still prints its code.
    const cbaLabel = container.querySelector(`g[data-code="CBA"] text`);
    expect(Number(cbaLabel?.getAttribute("y"))).toBeGreaterThanOrEqual(20);
    expect(container.querySelector(`g[data-code="CBA"] title`)?.textContent).toContain("CBA");
  });

  it("prints the caption, the provenance and the window as one select, drawn disabled on the server", () => {
    render(<OwnershipMapStatic initial={page()} />);
    expect(screen.getByText(mapCaption("disclosed"))).toBeInTheDocument();
    expect(screen.getByText("2026-10-12").closest("time")).toHaveAttribute("dateTime", "2026-10-12");
    // The window is one labelled select with four options, not four links (spec 14.9).
    const window = screen.getByRole("combobox", { name: "Window" });
    expect(window).toBeDisabled();
    expect(Array.from((window as HTMLSelectElement).options).map((option) => option.textContent)).toEqual([
      "28 days",
      "91 days",
      "182 days",
      "364 days",
    ]);
    expect(window).toHaveValue("91");
    expect(screen.queryByRole("link", { name: "28 days" })).toBeNull();
    // The Colour control is a labelled select: drawn disabled on the server, a live control once the island mounts.
    const colour = screen.getByRole("combobox", { name: "Colour" });
    expect(colour).toBeDisabled();
    expect(screen.getByRole("option", { name: "Short interest" })).toBeInTheDocument();
  });

  it("says no stock is on the map for an empty universe, and draws no map for an empty answer", () => {
    render(<OwnershipMapStatic initial={page({ stocks: [] })} />);
    expect(screen.getByText(MAP_EMPTY_COPY)).toBeInTheDocument();
    expect(screen.queryByRole("table")).toBeNull();
  });

  it("draws a default view the server could not read as the outage line, never as an empty map", () => {
    render(<OwnershipMapStatic initial={page({ ok: false, stocks: [] })} />);
    expect(screen.getByText(/The map could not be read just now/)).toBeInTheDocument();
    expect(screen.queryByRole("status", { name: "Loading" })).toBeNull();
    expect(screen.queryByText(MAP_EMPTY_COPY)).toBeNull();
  });

  it("prints no scale for a lens no stock has a figure for, and says so in its place", () => {
    const none = STOCKS.map((stock) => ({ ...stock, flowPp: null }));
    const { container } = render(
      <OwnershipMapView page={page({ stocks: none })} desk={{ ...DEFAULT_DESK_STATE, lens: "flow" }} status="idle" slow={false} basePath="/ownership" />,
    );
    expect(screen.getByText(NO_FIGURE_COPY)).toBeInTheDocument();
    expect(screen.queryByRole("img", { name: /^Net change/ })).toBeNull();
    expect(container.querySelector('g[data-code="BHP"] rect')?.getAttribute("fill")).toBe(`url(#${HATCH_ID})`);
  });

  it("names the window in the caption: the days by default, the brushed dates when the window is brushed", () => {
    const { unmount } = render(<OwnershipMapStatic initial={page({ asOf: "2026-11-01" })} />);
    expect(document.body.textContent).toContain("released over the last 91 days");
    unmount();
    render(
      <OwnershipMapView
        page={page({ asOf: "2026-11-01" })}
        desk={DEFAULT_DESK_STATE}
        notice={{ window: 91, since: "2026-08-01", until: "2026-10-31" }}
        status="idle"
        slow={false}
        basePath="/ownership"
      />,
    );
    expect(document.body.textContent).toContain("released from 2026-08-01 to 2026-10-31");
    expect(screen.getByRole("combobox", { name: "Window" })).toHaveValue("brushed");
  });

  it("states the basis of each lens's figures, and never the disclosed wording for a fund file or a short position", () => {
    expect(mapCaption("disclosed")).toContain("What the notices disclose");
    expect(mapCaption("index")).toContain("Index fund holdings files");
    expect(mapCaption("index")).not.toContain("What the notices disclose");
    expect(mapCaption("short")).toContain("ASIC short position report, published T+4");
    expect(mapCaption("short")).not.toContain("What the notices disclose");
    for (const lens of ["disclosed", "institutional", "hedge", "flow"] as const) {
      expect(mapCaption(lens)).toContain("not a share of the company");
    }
  });

  it("writes no em dash in anything it draws", () => {
    const { container } = render(<OwnershipMapStatic initial={page()} />);
    expect(container.textContent).not.toContain(String.fromCharCode(0x2014));
  });
});

describe("layout inputs the view depends on", () => {
  it("groups an industry placeholder under Other, so no cell carries a placeholder sector", () => {
    const layout = layoutMap(STOCKS, { width: MAP_WIDTH, height: MAP_HEIGHT, lens: "disclosed" });
    expect(layout.cells.find((c) => c.code === "ZZZ")?.sector).toBe("Other");
  });
});

describe("the drawing's labels and the phone's way into a sector", () => {
  it("prints a banded cell's code under the sector's name band, so the name is never drawn over it", () => {
    // The band rule itself (static view's SECTOR_BAND and name width): a cell in it is drawn with no text.
    const layout = layoutMap(STOCKS, { width: MAP_WIDTH, height: MAP_HEIGHT, lens: "disclosed" });
    const { container } = render(<OwnershipMapStatic initial={page()} />);
    let banded = 0;
    for (const sector of layout.sectors) {
      if (sector.x1 - sector.x0 < 72) continue;
      const right = sector.x0 + sector.sector.length * 6.6 + 8;
      for (const cell of layout.cells) {
        const inBand = cell.sector === sector.sector && cell.y0 < sector.y0 + 20 && cell.x0 < right && cell.x1 > sector.x0;
        if (!inBand) continue;
        banded += 1;
        const label = container.querySelector(`g[data-code="${cell.code}"] text`);
        // A banded cell prints its code under the band, or none when it is too short for both.
        if (label) expect(Number(label.getAttribute("y"))).toBeGreaterThanOrEqual(cell.y0 + 20);
      }
    }
    expect(banded).toBeGreaterThan(0);
  });

  it("lists every sector as a link below the drawing, so a phone can zoom without the drawing's small targets", () => {
    render(<OwnershipMapStatic initial={page()} />);
    const nav = screen.getByRole("navigation", { name: "Sectors" });
    expect(nav).toHaveClass("sm:sr-only", "sm:focus-within:not-sr-only");
    expect(within(nav).getByRole("link", { name: "Materials" })).toHaveAttribute("href", "/ownership?sector=Materials");
    expect(within(nav).getByRole("link", { name: "Financials" })).toHaveAttribute("href", "/ownership?sector=Financials");
  });

  it("draws the cell labels and the sector names only from sm, so a phone shows no 4 px text", () => {
    const { container } = render(<OwnershipMapStatic initial={page()} />);
    const labels = Array.from(container.querySelectorAll("svg text"));
    expect(labels.length).toBeGreaterThan(0);
    for (const label of labels) expect(label).toHaveClass("hidden", "sm:inline");
  });
});
