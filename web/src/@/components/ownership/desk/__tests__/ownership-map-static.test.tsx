import { fireEvent, render, screen, within } from "@testing-library/react";

import type { OwnershipMapPage } from "~/app/actions/ownershipDesk";
import { layoutMap, type MapCell, type MapStockRow } from "../map-layout";
import { DEFAULT_DESK_STATE } from "../desk-state";
import { DESK_DEFAULT_WINDOW_STATE } from "../window-chips";
import { mapCaption } from "../lens-legend";
import {
  HATCH_ID,
  MAP_EMPTY_COPY,
  MAP_HEIGHT,
  MAP_WIDTH,
  NO_FIGURE_COPY,
  OwnershipMapStatic,
  OwnershipMapView,
  PHONE_CAPTION,
  PHONE_STOCKS_CAPTION,
  coverageLine,
  labelColourFor,
  nextCellIndex,
  windowClause,
  wrapPhoneLabel,
  zoomPose,
  zoomStyle,
  foldDetail,
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
    expect(labelColourFor(1, scale)).toBe("hsl(var(--desk-bin-ink-0))");
    expect(labelColourFor(10, scale)).toBe("hsl(var(--desk-bin-ink-4))");
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
    expect(document.body.textContent).toContain("Notices read to 2026-11-01 · the last 91 days");
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
    expect(document.body.textContent).toContain("Notices read to 2026-11-01 · from 2026-08-01 to 2026-10-31");
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

  it("lists every sector as a link below the drawing, visually hidden at every width and shown on focus", () => {
    render(<OwnershipMapStatic initial={page()} />);
    const nav = screen.getByRole("navigation", { name: "Sectors" });
    // The phone map draws the sectors below sm; the chips are its keyboard and screen reader list, not a view.
    expect(nav).toHaveClass("sr-only", "focus-within:not-sr-only");
    expect(nav.className).not.toMatch(/sm:/);
    expect(within(nav).getByRole("link", { name: "Materials" })).toHaveAttribute("href", "/ownership?sector=Materials");
    expect(within(nav).getByRole("link", { name: "Financials" })).toHaveAttribute("href", "/ownership?sector=Financials");
  });

  it("draws the full treemap's cell labels and sector names only from sm, so a phone shows no 4 px text", () => {
    const { container } = render(<OwnershipMapStatic initial={page()} />);
    const full = container.querySelector('svg[aria-label^="Sectors and stocks"]');
    expect(full).not.toBeNull();
    const labels = Array.from(full?.querySelectorAll("text") ?? []);
    expect(labels.length).toBeGreaterThan(0);
    for (const label of labels) expect(label).toHaveClass("hidden", "sm:inline");
  });
});

describe("the coverage line's fund comparison (spec 14.10)", () => {
  const FUND_PAGE = {
    fundsCompared: 2,
    startFilesFrom: "2026-06-30",
    startFilesTo: "2026-07-31",
    endFilesFrom: "2026-10-30",
    endFilesTo: "2026-10-30",
  };

  function drawn(overrides: Partial<OwnershipMapPage>) {
    return render(
      <OwnershipMapView
        page={page({ ...FUND_PAGE, ...overrides })}
        desk={DEFAULT_DESK_STATE}
        status="idle"
        slow={false}
        basePath="/ownership/map"
      />,
    );
  }

  it("states the funds compared and the files each side reads, from the answer the view draws", () => {
    drawn({});
    expect(screen.getByText(/2 funds compared, files 2026-06-30 to 2026-07-31 against 2026-10-30/)).toBeInTheDocument();
  });

  it("says one file per fund, and every change n/a, when the window compares no fund", () => {
    drawn({ fundsCompared: 0 });
    expect(screen.getByText("One file per fund: changes n/a")).toBeInTheDocument();
    expect(screen.queryByText(/funds compared/)).toBeNull();
  });

  it("states one fund in the singular, with its single-date files", () => {
    drawn({ fundsCompared: 1, startFilesFrom: "2026-06-30", startFilesTo: "2026-06-30" });
    expect(screen.getByText(/1 fund compared, files 2026-06-30 against 2026-10-30/)).toBeInTheDocument();
  });

  it("says no index fund file is in the window when no tracked fund has a file there", () => {
    drawn({ fundsCompared: 0, startFilesFrom: "", startFilesTo: "", endFilesFrom: "", endFilesTo: "" });
    expect(screen.getByText("No index fund file in the window")).toBeInTheDocument();
    expect(screen.queryByText("One file per fund: changes n/a")).toBeNull();
  });

  it("marks the held comparison while a read is in flight, as the hatched changes are", () => {
    const { container } = render(
      <OwnershipMapView
        page={page(FUND_PAGE)}
        desk={DEFAULT_DESK_STATE}
        status="loading"
        slow={false}
        basePath="/ownership/map"
      />,
    );
    const line = screen.getByText(/^Updating: 2 funds compared, files 2026-06-30 to 2026-07-31/);
    expect(line).toHaveAttribute("data-stale", "true");
    expect(container.querySelector("[data-stale='true']")).toBe(line);
  });

  it("leaves the comparison unmarked once the answer is the one drawn", () => {
    drawn({});
    const line = screen.getByText(/^2 funds compared, files/);
    expect(line).not.toHaveAttribute("data-stale");
  });
});

describe("the map's one coverage line (backlog B1)", () => {
  const DAYS_91 = { window: 91, since: "", until: "" };
  const BRUSHED = { window: 91, since: "2026-08-01", until: "2026-10-31" };

  it("names the window as the last N days, or the two dates of a brushed pair", () => {
    expect(windowClause(DAYS_91)).toBe("the last 91 days");
    expect(windowClause(BRUSHED)).toBe("from 2026-08-01 to 2026-10-31");
  });

  it("orders the read-to date, the window, the fund comparison and the Coverage link", () => {
    expect(
      coverageLine({ asOf: "2026-11-03", window: DAYS_91, fund: "7 funds compared, files a against b", stale: false }),
    ).toEqual([
      { text: "Notices read to", time: "2026-11-03" },
      { text: "the last 91 days" },
      { text: "7 funds compared, files a against b" },
      { text: "Coverage", href: "/ownership#coverage" },
    ]);
  });

  it("drops the read-to clause when the date is missing, and the fund clause when the answer states none", () => {
    expect(coverageLine({ asOf: "", window: DAYS_91, fund: null, stale: false })).toEqual([
      { text: "the last 91 days" },
      { text: "Coverage", href: "/ownership#coverage" },
    ]);
  });

  it("marks a held fund comparison as updating while a read is in flight", () => {
    const clauses = coverageLine({ asOf: "2026-11-03", window: BRUSHED, fund: "3 funds compared", stale: true });
    expect(clauses[2]).toEqual({ text: "Updating: 3 funds compared", stale: true });
  });

  it("is one line of text in the full map, with the Coverage link and the dates as <time>", () => {
    const { container } = render(
      <OwnershipMapView
        page={page({ asOf: "2026-11-01", fundsCompared: 2, startFilesFrom: "2026-06-30", startFilesTo: "2026-06-30", endFilesFrom: "2026-10-30", endFilesTo: "2026-10-30" })}
        desk={DEFAULT_DESK_STATE}
        status="idle"
        slow={false}
        basePath="/ownership"
      />,
    );
    const lines = container.querySelectorAll("p.text-xs.text-muted-foreground");
    const coverage = Array.from(lines).filter((line) => line.textContent?.startsWith("Notices read to"));
    expect(coverage).toHaveLength(1);
    expect(coverage[0]?.textContent).toBe(
      "Notices read to 2026-11-01 · the last 91 days · 2 funds compared, files 2026-06-30 against 2026-10-30 · Coverage",
    );
    expect(coverage[0]?.querySelector("time")).toHaveAttribute("dateTime", "2026-11-01");
    expect(within(coverage[0] as HTMLElement).getByRole("link", { name: "Coverage" })).toHaveAttribute(
      "href",
      "/ownership#coverage",
    );
  });

  it("drops the old net change sentence and the fund line that the legend repeated", () => {
    const withFlow = STOCKS.map((stock, index) => ({ ...stock, fundChangePct: index + 1 }));
    render(
      <OwnershipMapView
        page={page({ stocks: withFlow, fundsCompared: 2, startFilesFrom: "2026-06-30", startFilesTo: "2026-06-30", endFilesFrom: "2026-10-30", endFilesTo: "2026-10-30" })}
        desk={{ ...DEFAULT_DESK_STATE, lens: "index_flow" }}
        status="idle"
        slow={false}
        basePath="/ownership"
      />,
    );
    expect(screen.queryByText(/The net change and the notice counts cover/)).toBeNull();
    expect(screen.getAllByText(/2 funds compared, files 2026-06-30 against 2026-10-30/)).toHaveLength(1);
  });

  it("gives the compact pane no read-to line or caption, and its legend repeats the fund comparison", () => {
    const withFlow = STOCKS.map((stock, index) => ({ ...stock, fundChangePct: index + 1 }));
    const { container } = render(
      <OwnershipMapView
        variant="compact"
        page={page({ asOf: "2026-11-01", stocks: withFlow, fundsCompared: 2, startFilesFrom: "2026-06-30", startFilesTo: "2026-06-30", endFilesFrom: "2026-10-30", endFilesTo: "2026-10-30" })}
        desk={{ ...DEFAULT_DESK_STATE, lens: "index_flow" }}
        status="idle"
        slow={false}
        basePath="/ownership"
      />,
    );
    expect(container.textContent).not.toContain("Notices read to");
    expect(container.textContent).not.toContain(PHONE_CAPTION);
    expect(container.textContent).not.toContain("Coverage");
    expect(screen.getAllByText(/2 funds compared, files 2026-06-30 against 2026-10-30/)).toHaveLength(1);
  });
});

describe("the phone map (D1)", () => {
  // Three sectors by market cap: Materials 500k (BHP, RIO), Other 200k (ZZZ, no cap, the median), Financials 150k.
  // Their cells are 360 tall, 205.7 and 154.3 in two columns, so none folds.
  function phoneSquare(container: HTMLElement): SVGSVGElement {
    const svg = container.querySelector<SVGSVGElement>('svg[viewBox="0 0 360 360"]');
    if (svg === null) throw new Error("no phone square");
    return svg;
  }

  it("draws the sectors as a square below sm: one link per sector, its figure in its title and name", () => {
    const { container } = render(<OwnershipMapStatic initial={page()} />);
    const square = phoneSquare(container);
    expect(square).toHaveClass("aspect-square", "h-auto", "w-full");
    const sectors = Array.from(square.querySelectorAll("g[data-phone-sector]")).map((g) => g.getAttribute("data-phone-sector"));
    expect(sectors.sort()).toEqual(["Financials", "Materials", "Other"]);
    // The market-cap-weighted mean of BHP (41.2 at 300k) and RIO (12.5 at 200k), at two decimals.
    const materials = square.querySelector('g[data-phone-sector="Materials"]');
    expect(materials?.querySelector("title")?.textContent).toBe(
      "Materials: 29.72%, the market-cap-weighted mean of 2 of 2 stocks; area: market cap",
    );
    const link = within(square).getByRole("link", { name: "Materials, 29.72%" });
    expect(link).toHaveAttribute("href", "/ownership?sector=Materials");
    // The chips the full map keeps out of the index are nofollow; the phone's sector links are the same links.
    expect(link).toHaveAttribute("rel", "nofollow");
    expect(within(square).getByRole("link", { name: "Financials, 9.50%" })).toBeInTheDocument();
    // ZZZ has no market cap: it takes the median, and its figure is its own.
    expect(within(square).getByRole("link", { name: "Other, 5.00%" })).toBeInTheDocument();
  });

  it("is drawn below sm only, and the full treemap from sm only", () => {
    const { container } = render(<OwnershipMapStatic initial={page()} />);
    expect(phoneSquare(container).parentElement).toHaveClass("sm:hidden");
    const full = container.querySelector('svg[aria-label^="Sectors and stocks"]');
    expect(full?.parentElement).toHaveClass("hidden", "sm:block");
  });

  it("prints the sector's short name and its figure inside each cell, and the caption under the square", () => {
    const { container } = render(<OwnershipMapStatic initial={page()} />);
    const materials = phoneSquare(container).querySelector('g[data-phone-sector="Materials"]');
    const texts = Array.from(materials?.querySelectorAll("text") ?? []).map((t) => t.textContent);
    expect(texts).toEqual(["Materials", "29.72%"]);
    expect(screen.getByText(PHONE_CAPTION)).toBeInTheDocument();
  });

  it("folds the smallest sectors into one cell that opens in place, its sectors as links under the square", () => {
    // Materials is two million, Financials one million, Energy and Utilities a thousand each. The small
    // sectors' cells would be under 44 units, and the fold has to reach 44 units too, so the fold takes
    // Financials and both small sectors, and Materials is the one sector drawn.
    const stocks = [
      stock({ code: "BHP", industry: "Materials", marketCap: 2_000_000 }),
      stock({ code: "CBA", industry: "Financials", marketCap: 1_000_000, disclosedPct: 9.5 }),
      stock({ code: "WPL", industry: "Energy", marketCap: 1_000 }),
      stock({ code: "AGL", industry: "Utilities", marketCap: 1_000 }),
    ];
    const { container } = render(<OwnershipMapStatic initial={page({ stocks })} />);
    const square = phoneSquare(container);
    const folded = square.querySelector('g[data-phone-sector="Other sectors"]');
    expect(folded?.querySelector("title")?.textContent).toMatch(/^Other sectors \(3\): /);
    // The fold cell is an anchor to the details beneath the square, which open in place.
    expect(folded?.querySelector("a")).toHaveAttribute("href", "#ownership-desk-phone-fold");
    const details = container.querySelector("details") as HTMLElement;
    // The fragment target sits INSIDE the details (a descendant opens it on navigation); the details carries no id.
    expect(details).not.toHaveAttribute("id");
    const target = details.querySelector("#ownership-desk-phone-fold");
    expect(target).not.toBeNull();
    expect(details.contains(target)).toBe(true);
    expect(within(details as HTMLElement).getByText("Other sectors (3)")).toBeInTheDocument();
    expect(within(details as HTMLElement).getByRole("link", { name: "Financials" })).toHaveAttribute("href", "/ownership?sector=Financials");
    expect(within(details as HTMLElement).getByRole("link", { name: "Energy" })).toHaveAttribute("href", "/ownership?sector=Energy");
    expect(within(details as HTMLElement).getByRole("link", { name: "Utilities" })).toHaveAttribute("href", "/ownership?sector=Utilities");
  });

  it("draws a zoomed sector's stocks in the square, each a button with its own figure", () => {
    const desk = { ...DEFAULT_DESK_STATE, sector: "Materials" };
    const { container } = render(
      <OwnershipMapView
        page={page()}
        desk={desk}
        status="idle"
        slow={false}
        basePath="/ownership"
        handlers={{ onCellClick: jest.fn(), onCellKey: jest.fn(), onCellHover: jest.fn(), onSectorZoom: jest.fn() }}
      />,
    );
    const square = phoneSquare(container);
    const cells = Array.from(square.querySelectorAll("g[data-phone-code]")).map((g) => g.getAttribute("data-phone-code"));
    expect(cells.sort()).toEqual(["BHP", "RIO"]);
    expect(square.querySelector("g[data-phone-sector]")).toBeNull();
    // Every stock is a tab stop below sm, as the sectors are: no roving stop hides a stock from a keyboard.
    for (const g of Array.from(square.querySelectorAll("g[data-phone-code]"))) {
      expect(g).toHaveAttribute("tabindex", "0");
    }
    const bhp = within(square).getByRole("button", { name: /^BHP, BHP Group, Materials\./ });
    expect(bhp.querySelector("text")?.textContent).toBe("BHP");
    expect(within(square).getByText("41.20%")).toBeInTheDocument();
    expect(screen.getByRole("navigation", { name: "Map location" })).toHaveTextContent("Materials");
    expect(screen.getByText(PHONE_STOCKS_CAPTION)).toBeInTheDocument();
  });

  it("folds a zoomed sector's smallest stocks into one anchor, and lists them in a details under the square", () => {
    // Sixty stocks whose caps fall by 15% each: the largest fit, the rest fold into one cell.
    const many = Array.from({ length: 60 }, (_, i) =>
      stock({ code: `S${String(i).padStart(2, "0")}`, name: `Stock ${i}`, industry: "Materials", marketCap: 1000 * 0.85 ** i, disclosedPct: 10 }),
    );
    const desk = { ...DEFAULT_DESK_STATE, sector: "Materials" };
    const onCellClick = jest.fn();
    const { container } = render(
      <OwnershipMapView
        page={page({ stocks: many })}
        desk={desk}
        status="idle"
        slow={false}
        basePath="/ownership"
        handlers={{ onCellClick, onCellKey: jest.fn(), onCellHover: jest.fn(), onSectorZoom: jest.fn() }}
      />,
    );
    const square = phoneSquare(container);
    const fold = square.querySelector("a[data-phone-stock-fold]");
    expect(fold).toHaveAttribute("href", "#ownership-desk-phone-stock-fold");
    expect(fold?.querySelector("title")?.textContent).toMatch(/^Other stocks \(\d+\): .*, weighted by area; area: market cap$/);
    const drawn = square.querySelectorAll("g[data-phone-code]");
    const details = container.querySelector("details");
    expect(details).not.toBeNull();
    // The fragment target is a descendant of the details, never the details itself.
    expect(details).not.toHaveAttribute("id");
    expect(details?.querySelector("#ownership-desk-phone-stock-fold")).not.toBeNull();
    // Every stock is either drawn or listed under the square: none is lost to the fold.
    const listed = within(details as HTMLElement).getAllByRole("button");
    expect(drawn.length + listed.length).toBe(60);
    expect(within(details as HTMLElement).getByText(`Other stocks (${listed.length})`)).toBeInTheDocument();
    // A listed stock selects it, as its cell does.
    const code = listed[0]!.textContent!.split(",")[0]!;
    fireEvent.click(listed[0]!);
    expect(onCellClick).toHaveBeenCalledWith(code);
  });

  it("lists a zoomed sector's folded stocks as text on the server, with no button", () => {
    const many = Array.from({ length: 60 }, (_, i) =>
      stock({ code: `S${String(i).padStart(2, "0")}`, name: `Stock ${i}`, industry: "Materials", marketCap: 1000 * 0.85 ** i, disclosedPct: 10 }),
    );
    const { container } = render(
      <OwnershipMapView page={page({ stocks: many })} desk={{ ...DEFAULT_DESK_STATE, sector: "Materials" }} status="idle" slow={false} basePath="/ownership" />,
    );
    const details = container.querySelector("details") as HTMLElement;
    expect(details).not.toBeNull();
    expect(details).not.toHaveAttribute("id");
    expect(details.querySelector("#ownership-desk-phone-stock-fold")).not.toBeNull();
    expect(within(details).queryAllByRole("button")).toHaveLength(0);
    expect(within(details).getByText(/^S59, Stock 59$/)).toBeInTheDocument();
  });

  it("hatches a sector no stock of which states a figure, and prints n/a for it", () => {
    const stocks = STOCKS.map((row) => ({ ...row, indexPct: null }));
    const desk = { ...DEFAULT_DESK_STATE, lens: "index" as const };
    const { container } = render(
      <OwnershipMapView page={page({ stocks })} desk={desk} status="idle" slow={false} basePath="/ownership" />,
    );
    const materials = phoneSquare(container).querySelector('g[data-phone-sector="Materials"]');
    expect(materials?.querySelector("title")?.textContent).toBe(
      "Materials: n/a, none of its 2 stocks states a figure; area: market cap",
    );
    expect(materials?.querySelector("rect")?.getAttribute("fill")).toBe("url(#ownership-desk-phone-hatch)");
  });

  it("links a sector from the compact pane to the full map at that sector, as its zoom does", () => {
    const { container } = render(<OwnershipMapStatic initial={page()} variant="compact" />);
    expect(within(phoneSquare(container)).getByRole("link", { name: "Materials, 29.72%" })).toHaveAttribute(
      "href",
      "/ownership/map?sector=Materials",
    );
  });
});

describe("wrapPhoneLabel", () => {
  it("keeps a name that fits on one line", () => {
    expect(wrapPhoneLabel("Materials", 20)).toEqual(["Materials"]);
  });

  it("breaks a long name into two lines at a space", () => {
    expect(wrapPhoneLabel("Pharma & biotech services", 16)).toEqual(["Pharma & biotech", "services"]);
  });

  it("cuts a second line that still does not fit, with an ellipsis", () => {
    const [first, second] = wrapPhoneLabel("Alpha beta gamma delta epsilon", 12);
    expect(first).toBe("Alpha beta");
    expect(second).toBe("gamma delta…");
    expect(second.length).toBeLessThanOrEqual(12);
  });

  it("cuts a name with no space to one line with an ellipsis", () => {
    expect(wrapPhoneLabel("Unbrokenword", 6)).toEqual(["Unbro…"]);
  });
});

describe("foldDetail", () => {
  it("names the fold's three largest members by their short names, then how many more", () => {
    expect(foldDetail(["Equity Real Estate Investment Trusts (REITs)", "Energy", "Health Care Equipment & Services", "Software & Services", "Media & Entertainment"])).toBe(
      "REITs, Energy, Health care +2",
    );
    expect(foldDetail(["Energy", "Utilities"])).toBe("Energy, Utilities");
    expect(foldDetail([])).toBe("");
  });
});

describe("the compact pane fills its fixed height from lg (backlog B2)", () => {
  it("gives the drawing the pane's height from lg, centred in its box, with its viewBox kept", () => {
    const { container } = render(<OwnershipMapStatic initial={page()} variant="compact" />);
    const drawing = container.querySelector('svg[role="group"]');
    expect(drawing).toHaveClass("h-auto", "lg:h-full");
    expect(drawing).toHaveAttribute("preserveAspectRatio", "xMidYMid meet");
    expect(drawing).toHaveAttribute("viewBox", `0 0 ${MAP_WIDTH} ${MAP_HEIGHT}`);
    // The drawing's lg:h-full resolves only if every box between it and the view root fills the pane:
    // each one must be a flex column that grows and may shrink. A plain block anywhere in the chain
    // makes the height auto, and the drawing falls back to its aspect ratio.
    const chain: Element[] = [];
    let node: Element | null = drawing?.parentElement ?? null;
    while (node !== null && !node.classList.contains("space-y-4")) {
      chain.push(node);
      node = node.parentElement;
    }
    expect(node).not.toBeNull();
    expect(chain.length).toBeGreaterThan(0);
    for (const el of [...chain, node as Element]) {
      expect(el).toHaveClass("lg:flex-1", "lg:min-h-0");
    }
  });

  it("keeps the full map's drawing at its own aspect ratio", () => {
    const { container } = render(<OwnershipMapStatic initial={page()} variant="full" />);
    const drawing = container.querySelector('svg[role="group"]');
    expect(drawing).toHaveClass("h-auto");
    expect(drawing).not.toHaveClass("lg:h-full");
  });
});

describe("the Sort control and the change order (backlog C3)", () => {
  const MINUS = String.fromCharCode(0x2212);
  // Materials and Financials both state +0.50 pp; Other states -3.00 pp, the biggest magnitude.
  const MOVERS: MapStockRow[] = [
    stock({ code: "BHP", name: "BHP Group", marketCap: 300_000, flowPp: 0.5 }),
    stock({ code: "RIO", name: "Rio Tinto", marketCap: 200_000, flowPp: 0.5 }),
    stock({ code: "CBA", name: "Commonwealth Bank", marketCap: 150_000, industry: "Financials", flowPp: 0.5 }),
    stock({ code: "ZZZ", name: "Unclassified Co", marketCap: 1_000, industry: "Not Applic", flowPp: -3 }),
  ];

  function view(lens: "disclosed" | "flow" | "index_flow", props: { sort?: "largest" | "changed"; onSortChange?: (next: "largest" | "changed") => void } = {}) {
    return (
      <OwnershipMapView
        page={page({ stocks: MOVERS })}
        desk={{ ...DEFAULT_DESK_STATE, lens }}
        notice={DESK_DEFAULT_WINDOW_STATE}
        status="idle"
        slow={false}
        basePath="/ownership/map"
        {...props}
      />
    );
  }

  function sectorOrder(container: HTMLElement): string[] {
    return Array.from(container.querySelectorAll("g[data-sector]")).map((group) => group.getAttribute("data-sector") ?? "");
  }

  it("offers the Sort control in the one toolbar row under a diverging lens, and not under a level lens", () => {
    const flow = render(view("flow", { sort: "largest", onSortChange: () => undefined }));
    const row = flow.container.querySelectorAll("[data-toolbar]");
    expect(row).toHaveLength(1);
    expect(within(row[0] as HTMLElement).getByRole("combobox", { name: "Sort" })).toBeInTheDocument();
    flow.unmount();

    const indexFlow = render(view("index_flow", { sort: "largest", onSortChange: () => undefined }));
    expect(screen.getByRole("combobox", { name: "Sort" })).toBeInTheDocument();
    indexFlow.unmount();

    const level = render(view("disclosed", { sort: "changed", onSortChange: () => undefined }));
    expect(screen.queryByRole("combobox", { name: "Sort" })).toBeNull();
    expect(level.container.querySelectorAll("[data-toolbar]")).toHaveLength(1);
  });

  it("draws the Sort control disabled on the server's default view, and calls its handler with the chosen sort", () => {
    const onSortChange = jest.fn();
    const { unmount } = render(view("flow", { sort: "largest" }));
    expect(screen.getByRole("combobox", { name: "Sort" })).toBeDisabled();
    unmount();
    render(view("flow", { sort: "largest", onSortChange }));
    fireEvent.change(screen.getByRole("combobox", { name: "Sort" }), { target: { value: "changed" } });
    expect(onSortChange).toHaveBeenCalledWith("changed");
  });

  it("orders the drawn sectors by the magnitude of their net change under the changed sort", () => {
    const { container } = render(view("flow", { sort: "changed" }));
    expect(sectorOrder(container)).toEqual(["Other", "Materials", "Financials"]);
  });

  it("keeps the order by area under the largest sort, whatever the lens", () => {
    const { container } = render(view("flow", { sort: "largest" }));
    expect(sectorOrder(container)).toEqual(["Materials", "Financials", "Other"]);
  });

  it("states each sector's net change in its band's title under the changed sort, and no change under the largest", () => {
    const changed = render(view("flow", { sort: "changed" }));
    const titles = Array.from(changed.container.querySelectorAll("g[data-sector] > title")).map((t) => t.textContent);
    expect(titles).toEqual([
      `Other, 1 stock. Net change ${MINUS}3.00 pp`,
      "Materials, 2 stocks. Net change +0.50 pp",
      "Financials, 1 stock. Net change +0.50 pp",
    ]);
    changed.unmount();

    const largest = render(view("flow", { sort: "largest" }));
    const plain = Array.from(largest.container.querySelectorAll("g[data-sector] > title")).map((t) => t.textContent);
    expect(plain).toEqual(["Materials, 2 stocks", "Financials, 1 stock", "Other, 1 stock"]);
  });

  it("states n/a, never zero, in a sector's title when no stock of it states a change", () => {
    const { container } = render(
      <OwnershipMapView
        page={page({ stocks: [stock({ code: "BHP", flowPp: null }), stock({ code: "RIO", industry: "Energy", flowPp: 1 })] })}
        desk={{ ...DEFAULT_DESK_STATE, lens: "flow" }}
        notice={DESK_DEFAULT_WINDOW_STATE}
        status="idle"
        slow={false}
        basePath="/ownership/map"
        sort="changed"
      />,
    );
    const titles = Array.from(container.querySelectorAll("g[data-sector] > title")).map((t) => t.textContent);
    expect(titles).toContain("Materials, 1 stock. Net change n/a");
  });

  it("keeps the idle order while a read is in flight under the changed sort, and hatches the stale figures with n/a titles", () => {
    const idle = render(view("flow", { sort: "changed" }));
    const idleSectors = sectorOrder(idle.container);
    const idleCells = screen.getAllByRole("rowheader").map((header) => header.textContent);
    idle.unmount();

    const loading = render(
      <OwnershipMapView
        page={page({ stocks: MOVERS })}
        desk={{ ...DEFAULT_DESK_STATE, lens: "flow" }}
        notice={DESK_DEFAULT_WINDOW_STATE}
        status="loading"
        slow={false}
        basePath="/ownership/map"
        sort="changed"
      />,
    );
    // The stale map is tiled once from the last answer: the order is the idle order, not the area fallback.
    expect(sectorOrder(loading.container)).toEqual(idleSectors);
    expect(screen.getAllByRole("rowheader").map((header) => header.textContent)).toEqual(idleCells);
    const titles = Array.from(loading.container.querySelectorAll("g[data-sector] > title")).map((t) => t.textContent);
    expect(titles).toEqual([
      "Other, 1 stock. Net change n/a",
      "Materials, 2 stocks. Net change n/a",
      "Financials, 1 stock. Net change n/a",
    ]);
  });

  it("keeps the table of every cell in the drawing's order under each sort", () => {
    const changed = render(view("flow", { sort: "changed" }));
    expect(screen.getAllByRole("rowheader").map((header) => header.textContent)).toEqual([
      "ZZZ Unclassified Co",
      "BHP BHP Group",
      "RIO Rio Tinto",
      "CBA Commonwealth Bank",
    ]);
    changed.unmount();
    render(view("flow", { sort: "largest" }));
    expect(screen.getAllByRole("rowheader").map((header) => header.textContent)).toEqual([
      "BHP BHP Group",
      "RIO Rio Tinto",
      "CBA Commonwealth Bank",
      "ZZZ Unclassified Co",
    ]);
  });
});
