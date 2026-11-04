import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";

import type { OwnershipMapPage } from "~/app/actions/ownershipDesk";
import type { MapStockRow } from "../map-layout";
import type { StockPanelPage } from "../stock-panel";
import { OwnershipMap } from "../ownership-map";
import { HATCH_ID } from "../ownership-map-static";

/** The full treemap (from sm). Below sm the phone map draws a zoomed sector's stocks again under the same names. */
function fullMap(): HTMLElement {
  return screen.getByRole("group", { name: /^Sectors and stocks, coloured by/ });
}

// The link the reader arrives with. The island reads it through useSearchParams; a
// test that moves the link by hand (back or forward) changes this and re-renders.
let mockSearchParams = new URLSearchParams("");
// The combobox reads the popover API on mount, which jsdom does not have: the Find control is a stub here.
jest.mock("~/@/components/gamma/SearchCombobox", () => ({
  SearchCombobox: () => null,
}));
jest.mock("next/navigation", () => ({
  useSearchParams: () => mockSearchParams,
  useRouter: () => ({ push: jest.fn(), replace: jest.fn(), prefetch: jest.fn() }),
}));

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
  stock({ code: "BHP", name: "BHP Group", marketCap: 300_000, disclosedPct: 41.2, shortPct: 3.42 }),
  stock({ code: "RIO", name: "Rio Tinto", marketCap: 200_000, disclosedPct: 12.5, shortPct: 1.1 }),
  stock({ code: "CBA", name: "Commonwealth Bank", marketCap: 150_000, disclosedPct: 9.5, industry: "Financials", shortPct: null }),
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

/** The panel answers for the code it is asked for, so a test can tell which stock the panel opened. */
function panel(code: string): StockPanelPage {
  return {
    ok: true,
    code,
    companyName: `${code} Group`,
    disclosed: [{ kind: "super_fund", pct: 30.1, holders: 3 }],
    disclosedPct: 30.1,
    largest: [
      {
        name: "Super Fund A",
        slug: "super-a",
        holderKey: "name:super-a",
        kind: "super_fund",
        votingPowerPct: 7.5,
        asAt: "2026-09-30",
      },
    ],
    index: { pct: 5.2, asAt: "2026-09-30" },
    notices: [{ announcedOn: "2026-10-16", form: "604", ceased: false, holderName: "Super Fund A" }],
  };
}

const CELL_BHP = /^BHP,/;

beforeEach(() => {
  mockSearchParams = new URLSearchParams("");
  window.history.replaceState(null, "", "/ownership");
});

/** The Colour control of the workspace toolbar: a labelled select, one of the lenses by its key. */
function pickLens(lens: string): void {
  fireEvent.change(screen.getByRole("combobox", { name: "Colour" }), { target: { value: lens } });
}

describe("OwnershipMap island", () => {
  it("draws the default view without asking the server for it", () => {
    const loadMap = jest.fn();
    render(<OwnershipMap initial={page()} loadMap={loadMap} loadPanel={jest.fn()} />);
    expect(screen.getByRole("button", { name: CELL_BHP })).toBeInTheDocument();
    expect(loadMap).not.toHaveBeenCalled();
  });

  it("opens the stock panel for a cell, and closes it back to the cell", async () => {
    const loadPanel = jest.fn().mockResolvedValue(panel("BHP"));
    render(<OwnershipMap initial={page()} loadMap={jest.fn()} loadPanel={loadPanel} />);
    fireEvent.click(screen.getByRole("button", { name: CELL_BHP }));
    expect(loadPanel).toHaveBeenCalledWith("BHP");
    expect(await screen.findByRole("heading", { name: "BHP Group" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: CELL_BHP })).toHaveAttribute("aria-pressed", "true");

    fireEvent.click(screen.getByRole("button", { name: "Close BHP" }));
    expect(screen.queryByRole("heading", { name: "BHP Group" })).toBeNull();
    expect(document.activeElement).toBe(screen.getByRole("button", { name: CELL_BHP }));
  });

  it("zooms to a sector from its label, writes the link, and zooms out on Escape", () => {
    render(<OwnershipMap initial={page()} loadMap={jest.fn()} loadPanel={jest.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: "Zoom to Materials" }));
    expect(window.location.search).toBe("?sector=Materials");
    const location = screen.getByRole("navigation", { name: "Map location" });
    expect(within(location).getByText("Materials").closest("li")).toHaveAttribute("aria-current", "location");
    expect(within(fullMap()).getByRole("button", { name: CELL_BHP })).toBeInTheDocument();
    // The sector's stocks only: CBA is a financial and is not on the zoomed map.
    expect(screen.queryByRole("button", { name: /^CBA,/ })).toBeNull();

    fireEvent.keyDown(within(fullMap()).getByRole("button", { name: CELL_BHP }), { key: "Escape" });
    expect(window.location.search).toBe("");
    expect(screen.getByRole("button", { name: /^CBA,/ })).toBeInTheDocument();
  });

  it("closes the panel on Escape from inside it, and keeps the zoom behind it", async () => {
    const loadPanel = jest.fn().mockResolvedValue(panel("BHP"));
    render(<OwnershipMap initial={page()} loadMap={jest.fn()} loadPanel={loadPanel} />);
    fireEvent.click(screen.getByRole("button", { name: "Zoom to Materials" }));
    expect(window.location.search).toBe("?sector=Materials");
    fireEvent.click(within(fullMap()).getByRole("button", { name: CELL_BHP }));
    expect(await screen.findByRole("heading", { name: "BHP Group" })).toBeInTheDocument();
    fireEvent.keyDown(screen.getByRole("button", { name: "Close BHP" }), { key: "Escape" });
    expect(screen.queryByRole("heading", { name: "BHP Group" })).toBeNull();
    expect(window.location.search).toBe("?sector=Materials");
  });

  it("zooms to a stock's sector on z, from the whole market", () => {
    render(<OwnershipMap initial={page()} loadMap={jest.fn()} loadPanel={jest.fn()} />);
    fireEvent.keyDown(screen.getByRole("button", { name: CELL_BHP }), { key: "z" });
    expect(window.location.search).toBe("?sector=Materials");
    expect(screen.getByRole("navigation", { name: "Map location" })).toHaveTextContent("Materials");
  });

  it("asks the server once for a new window of change when the link moves to it", async () => {
    const loadMap = jest.fn().mockResolvedValue(page({ asOf: "2026-10-01" }));
    const { rerender } = render(<OwnershipMap initial={page()} loadMap={loadMap} loadPanel={jest.fn()} />);
    expect(screen.getByRole("combobox", { name: "Window" })).toHaveValue("91");
    // The Window select writes the link in place, and the island reads it back.
    mockSearchParams = new URLSearchParams("window=28");
    rerender(<OwnershipMap initial={page()} loadMap={loadMap} loadPanel={jest.fn()} />);
    expect(loadMap).toHaveBeenCalledTimes(1);
    expect(loadMap).toHaveBeenCalledWith({ window: 28 });
    await waitFor(() => expect(screen.getByText("2026-10-01").closest("time")).not.toBeNull());
    expect(screen.getByRole("combobox", { name: "Window" })).toHaveValue("28");
  });

  it("recolours by a lens with no server request, and hatches a stock with no figure for it", () => {
    const loadMap = jest.fn();
    const { container } = render(<OwnershipMap initial={page()} loadMap={loadMap} loadPanel={jest.fn()} />);
    pickLens("short");
    expect(loadMap).not.toHaveBeenCalled();
    expect(window.location.search).toBe("?lens=short");
    expect(screen.getByRole("img", { name: /^Short interest, five steps/ })).toBeInTheDocument();
    expect(container.querySelector('g[data-code="CBA"] rect')?.getAttribute("fill")).toBe(`url(#${HATCH_ID})`);
  });

  it("says the map could not be read when a window's read fails, and keeps the last good drawing beneath it", async () => {
    const loadMap = jest.fn().mockResolvedValue(page({ ok: false, stocks: [] }));
    const { rerender } = render(<OwnershipMap initial={page()} loadMap={loadMap} loadPanel={jest.fn()} />);
    mockSearchParams = new URLSearchParams("window=364");
    rerender(<OwnershipMap initial={page()} loadMap={loadMap} loadPanel={jest.fn()} />);
    expect(await screen.findByText(/The map could not be read just now/)).toBeInTheDocument();
    // The disclosed lens does not depend on the window, so its drawing stays; the flow is hatched.
    expect(screen.getByRole("button", { name: CELL_BHP })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: CELL_BHP }).querySelector("rect")?.getAttribute("fill")).not.toContain(HATCH_ID);
  });

  it("hatches the flow and the notice counts while a window is not on the screen, and says so", async () => {
    const loadMap = jest.fn().mockResolvedValue(page({ ok: false, stocks: [] }));
    const { rerender, container } = render(<OwnershipMap initial={page()} loadMap={loadMap} loadPanel={jest.fn()} />);
    pickLens("flow");
    expect(window.location.search).toBe("?lens=flow");
    mockSearchParams = new URLSearchParams("lens=flow&window=28");
    rerender(<OwnershipMap initial={page()} loadMap={loadMap} loadPanel={jest.fn()} />);
    await screen.findByText(/The map could not be read just now/);
    expect(container.querySelector(`g[data-code="BHP"] rect`)?.getAttribute("fill")).toBe(`url(#${HATCH_ID})`);
    const table = screen.getByRole("table", { name: /Sectors and stocks, by Net change/ });
    expect(within(table).getAllByText("n/a").length).toBeGreaterThan(0);
  });

  it("asks for a brushed window by its dates, once, and names it in the caption with no chip active", async () => {
    const loadMap = jest.fn().mockResolvedValue(page({ asOf: "2026-11-01" }));
    mockSearchParams = new URLSearchParams("since=2026-08-01&until=2026-10-31");
    render(<OwnershipMap initial={page()} loadMap={loadMap} loadPanel={jest.fn()} />);
    await waitFor(() => expect(loadMap).toHaveBeenCalledTimes(1));
    expect(loadMap).toHaveBeenCalledWith({ since: "2026-08-01", until: "2026-10-31" });
    await waitFor(() => expect(screen.getByText("2026-11-01").closest("time")).not.toBeNull());
    expect(screen.getByRole("combobox", { name: "Window" })).toHaveValue("brushed");
    expect(document.body.textContent).toContain("from 2026-08-01 to 2026-10-31");
  });

  it("keeps the brushed window when a lens is taken, so the lens does not drop the heatmap's brush", async () => {
    mockSearchParams = new URLSearchParams("since=2026-08-01&until=2026-10-31");
    window.history.replaceState(null, "", "/ownership?since=2026-08-01&until=2026-10-31");
    const loadMap = jest.fn().mockResolvedValue(page({ asOf: "2026-11-01" }));
    render(<OwnershipMap initial={page()} loadMap={loadMap} loadPanel={jest.fn()} />);
    await waitFor(() => expect(screen.getByText("2026-11-01").closest("time")).not.toBeNull());
    pickLens("short");
    expect(window.location.search).toBe("?since=2026-08-01&until=2026-10-31&lens=short");
  });

  it("names the sector that holds no stock on the map, and keeps the crumb's way out", () => {
    mockSearchParams = new URLSearchParams("sector=Nonsense");
    render(<OwnershipMap initial={page()} loadMap={jest.fn()} loadPanel={jest.fn()} />);
    expect(screen.getByText("No stock on the map is in Nonsense.")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Market" })).toBeInTheDocument();
    expect(screen.queryByRole("table")).toBeNull();
  });

  it("keeps exactly one cell in the tab order after a zoom to a sector the focused cell is not in", async () => {
    const loadPanel = jest.fn().mockImplementation((code: string) => Promise.resolve(panel(code)));
    const { container } = render(<OwnershipMap initial={page()} loadMap={jest.fn()} loadPanel={loadPanel} />);
    // CBA is a financial: it takes the roving stop, then the zoom to Materials leaves it out.
    fireEvent.click(screen.getByRole("button", { name: /^CBA,/ }));
    expect(await screen.findByRole("heading", { name: "CBA Group" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Zoom to Materials" }));
    const stops = container.querySelectorAll('g[data-code][tabindex="0"]');
    expect(stops).toHaveLength(1);
    expect(["BHP", "RIO"]).toContain(stops[0]?.getAttribute("data-code"));
  });

  it("moves the focus to the nearest cell on an arrow key, and selects that cell's stock on Enter", async () => {
    const loadPanel = jest.fn().mockImplementation((code: string) => Promise.resolve(panel(code)));
    render(<OwnershipMap initial={page()} loadMap={jest.fn()} loadPanel={loadPanel} />);
    const bhp = screen.getByRole("button", { name: CELL_BHP });
    act(() => bhp.focus());
    fireEvent.keyDown(bhp, { key: "ArrowRight" });
    const moved = document.activeElement as SVGElement;
    expect(moved.getAttribute("data-code")).not.toBe("BHP");
    const code = moved.getAttribute("data-code") ?? "";
    expect(code).toMatch(/^(RIO|CBA)$/);

    fireEvent.keyDown(moved, { key: "Enter" });
    expect(loadPanel).toHaveBeenCalledWith(code);
    expect(await screen.findByRole("heading", { name: `${code} Group` })).toBeInTheDocument();
    expect(document.querySelector(`g[data-code="${code}"]`)).toHaveAttribute("aria-pressed", "true");
    expect(screen.queryByRole("heading", { name: "BHP Group" })).toBeNull();
  });

  it("shows the figure on hover in a tooltip beside the table's row", () => {
    render(<OwnershipMap initial={page()} loadMap={jest.fn()} loadPanel={jest.fn()} />);
    fireEvent.pointerEnter(screen.getByRole("button", { name: CELL_BHP }));
    expect(screen.getByText("Disclosed by notices: 41.20%")).toBeInTheDocument();
    fireEvent.pointerLeave(screen.getByRole("button", { name: CELL_BHP }));
    expect(screen.queryByText("Disclosed by notices: 41.20%")).toBeNull();
  });

  it("lists every cell in the sr-only table, with its figure", () => {
    render(<OwnershipMap initial={page()} loadMap={jest.fn()} loadPanel={jest.fn()} />);
    const table = screen.getByRole("table", { name: "Sectors and stocks, by Disclosed by notices" });
    const bhp = within(table).getByRole("rowheader", { name: "BHP BHP Group" }).closest("tr");
    expect(bhp).not.toBeNull();
    expect(within(bhp as HTMLElement).getByText("41.20%")).toBeInTheDocument();
  });

  it("states the read-to date, the window and the fund comparison in one coverage line, with the Coverage link", () => {
    const fundPage = page({
      fundsCompared: 2,
      startFilesFrom: "2026-09-01",
      startFilesTo: "2026-09-01",
      endFilesFrom: "2026-10-30",
      endFilesTo: "2026-10-30",
    });
    render(<OwnershipMap initial={fundPage} loadMap={jest.fn()} loadPanel={jest.fn()} />);
    const line = screen.getByText("the last 91 days").closest("p") as HTMLElement;
    expect(line).toHaveTextContent(
      "Notices read to 2026-10-12 · the last 91 days · 2 funds compared, files 2026-09-01 against 2026-10-30 · Coverage",
    );
    expect(within(line).getByRole("link", { name: "Coverage" })).toHaveAttribute("href", "/ownership#coverage");
    // The caption under the drawing no longer repeats the window, and the legend holds no second copy of the files.
    expect(screen.queryByText(/The net change and the notice counts cover/)).toBeNull();
    expect(screen.getAllByText(/2 funds compared, files 2026-09-01 against 2026-10-30/)).toHaveLength(1);
  });

  it("follows a link moved by hand, without asking again for a window it already holds", () => {
    const loadMap = jest.fn().mockResolvedValue(page());
    const { rerender } = render(<OwnershipMap initial={page()} loadMap={loadMap} loadPanel={jest.fn()} />);
    mockSearchParams = new URLSearchParams("lens=hedge");
    rerender(<OwnershipMap initial={page()} loadMap={loadMap} loadPanel={jest.fn()} />);
    expect(screen.getByRole("combobox", { name: "Colour" })).toHaveValue("hedge");
    expect(loadMap).not.toHaveBeenCalled();
  });
});

describe("the map's sort (backlog C3)", () => {
  // Under the flow lens Financials moves most (-4.00 pp) and Materials least (+0.50 pp); by area Materials is first.
  const MOVERS: MapStockRow[] = [
    stock({ code: "BHP", name: "BHP Group", marketCap: 300_000, flowPp: 0.5 }),
    stock({ code: "RIO", name: "Rio Tinto", marketCap: 200_000, flowPp: 0.5 }),
    stock({ code: "CBA", name: "Commonwealth Bank", marketCap: 150_000, industry: "Financials", flowPp: -4 }),
  ];

  function sectorOrder(container: HTMLElement): string[] {
    return Array.from(container.querySelectorAll("g[data-sector]")).map((group) => group.getAttribute("data-sector") ?? "");
  }

  it("orders the compact pane by change when the link names no sort, and by area when it names largest", () => {
    mockSearchParams = new URLSearchParams("lens=flow");
    const changed = render(
      <OwnershipMap initial={page({ stocks: MOVERS })} loadMap={jest.fn()} loadPanel={jest.fn()} variant="compact" sort="changed" />,
    );
    expect(sectorOrder(changed.container)).toEqual(["Financials", "Materials"]);
    changed.unmount();

    mockSearchParams = new URLSearchParams("lens=flow&sort=largest");
    const largest = render(
      <OwnershipMap initial={page({ stocks: MOVERS })} loadMap={jest.fn()} loadPanel={jest.fn()} variant="compact" sort="changed" />,
    );
    expect(sectorOrder(largest.container)).toEqual(["Materials", "Financials"]);
  });

  it("orders the full map by area when the link names no sort, and offers the Sort control in its one toolbar row under the flow lens", () => {
    mockSearchParams = new URLSearchParams("lens=flow");
    const { container } = render(<OwnershipMap initial={page({ stocks: MOVERS })} loadMap={jest.fn()} loadPanel={jest.fn()} variant="full" />);
    expect(sectorOrder(container)).toEqual(["Materials", "Financials"]);
    const toolbar = container.querySelectorAll("[data-toolbar]");
    expect(toolbar).toHaveLength(1);
    expect(within(toolbar[0] as HTMLElement).getByRole("combobox", { name: "Sort" })).toHaveValue("largest");
  });

  it("writes the sort into the link when the Sort control changes, and redraws the sectors in that order", () => {
    window.history.replaceState(null, "", "/ownership/map?lens=flow");
    mockSearchParams = new URLSearchParams("lens=flow");
    const { container, rerender } = render(
      <OwnershipMap initial={page({ stocks: MOVERS })} loadMap={jest.fn()} loadPanel={jest.fn()} variant="full" />,
    );
    fireEvent.change(screen.getByRole("combobox", { name: "Sort" }), { target: { value: "changed" } });
    expect(new URLSearchParams(window.location.search).get("sort")).toBe("changed");
    expect(new URLSearchParams(window.location.search).get("lens")).toBe("flow");
    // The router hands the island the link it now has.
    mockSearchParams = new URLSearchParams(window.location.search);
    rerender(<OwnershipMap initial={page({ stocks: MOVERS })} loadMap={jest.fn()} loadPanel={jest.fn()} variant="full" />);
    expect(sectorOrder(container)).toEqual(["Financials", "Materials"]);
    expect(within(container.querySelector("[data-toolbar]") as HTMLElement).getByRole("combobox", { name: "Sort" })).toHaveValue("changed");
    window.history.replaceState(null, "", "/ownership");
  });
});
