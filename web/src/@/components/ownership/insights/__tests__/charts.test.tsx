import { join } from "node:path";

import { fireEvent, render, screen, within } from "@testing-library/react";

jest.mock("d3-hierarchy", () =>
  jest.requireActual(join(__dirname, "..", "..", "..", "..", "..", "..", "node_modules", "d3-hierarchy", "dist", "d3-hierarchy.js")),
);

// The charts size themselves from their box. jsdom lays nothing out, so the box
// is given a size here.
jest.mock("../use-element-size", () => ({
  useElementSize: () => [{ current: null }, { width: 900, height: 500 }],
}));

import { MarketMap } from "../market-map";
import { MoneyFlow } from "../money-flow";
import { PositionHeatmap, cellText } from "../position-heatmap";
import { TimeWindow, stepWindow } from "../time-window";
import { FLOW, HEATMAP, REMAINDERS, SECTORS, STOCKS } from "~/@/lib/ownership/insights/__tests__/fixtures";

const MARKET_COLOURS = /\b(?:text|bg|border|fill|stroke|ring)-(?:red|green|emerald|rose)-?\d*|#(?:ef4444|22c55e|f87171|4ade80)/i;

describe("MarketMap", () => {
  function renderMap(overrides: Partial<React.ComponentProps<typeof MarketMap>> = {}) {
    const onFocusSector = jest.fn();
    const onSelectStock = jest.fn();
    const utils = render(
      <MarketMap
        sectors={SECTORS}
        stocks={STOCKS}
        remainders={REMAINDERS}
        measure="funds"
        focus={null}
        selected=""
        onFocusSector={onFocusSector}
        onSelectStock={onSelectStock}
        {...overrides}
      />,
    );
    return { ...utils, onFocusSector, onSelectStock };
  }

  it("draws a named button per tile, and one tab stop for the whole map", () => {
    renderMap();
    const map = screen.getByRole("group", { name: /^Market map: every sector/ });
    const tiles = within(map).getAllByRole("button").filter((t) => t.tagName.toLowerCase() === "g");
    const named = tiles.map((t) => t.getAttribute("aria-label") ?? "");
    expect(named.some((n) => n.startsWith("BHP, BHP Group, Materials: index funds hold $5.12B, change in shares +10.0%"))).toBe(true);
    expect(named.some((n) => n.startsWith("CBA") && n.includes("change n/a: no fund compared"))).toBe(true);
    expect(named.some((n) => n.startsWith("12 more Materials stocks"))).toBe(true);
    const stops = tiles.filter((t) => t.getAttribute("tabindex") === "0");
    expect(stops).toHaveLength(1);
  });

  it("opens a stock on a press, zooms a sector from its header and its remainder tile", () => {
    const { onSelectStock, onFocusSector } = renderMap();
    fireEvent.click(screen.getByRole("button", { name: /^BHP, BHP Group/ }));
    expect(onSelectStock).toHaveBeenCalledWith("BHP");
    fireEvent.click(screen.getByRole("button", { name: /^12 more Materials stocks/ }));
    expect(onFocusSector).toHaveBeenCalledWith("Materials");
    fireEvent.click(screen.getByTitle("Open Materials"));
    expect(onFocusSector).toHaveBeenLastCalledWith("Materials");
  });

  it("walks the tiles with the arrow keys and opens one with Enter", () => {
    const { onSelectStock } = renderMap();
    const first = screen.getAllByRole("button", { name: /:/ }).find((t) => t.getAttribute("tabindex") === "0")!;
    first.focus();
    fireEvent.keyDown(first, { key: "ArrowRight" });
    const second = document.activeElement as HTMLElement;
    expect(second).not.toBe(first);
    expect(second.getAttribute("tabindex")).toBe("0");
    fireEvent.keyDown(second, { key: "Enter" });
    expect(onSelectStock).toHaveBeenCalledTimes(1);
  });

  it("names the level in breadcrumbs, goes back up from a sector, and leaves with Escape", () => {
    const { onFocusSector } = renderMap({ focus: "Materials" });
    const crumbs = screen.getByRole("navigation", { name: "Market map level" });
    expect(within(crumbs).getByText("Materials")).toHaveAttribute("aria-current", "page");
    fireEvent.click(within(crumbs).getByRole("button", { name: "All sectors" }));
    expect(onFocusSector).toHaveBeenCalledWith(null);
    const tile = screen.getAllByRole("button", { name: /:/ }).find((t) => t.getAttribute("tabindex") === "0")!;
    fireEvent.keyDown(tile, { key: "Escape" });
    expect(onFocusSector).toHaveBeenCalledTimes(2);
  });

  it("keys every colour step and the hatched n/a, and never draws a market colour", () => {
    const { container } = renderMap();
    expect(screen.getByText("n/a: no fund compared")).toBeInTheDocument();
    expect(screen.getByText("no change")).toBeInTheDocument();
    expect(container.innerHTML).not.toMatch(MARKET_COLOURS);
  });

  it("keys only n/a when no tile in view states a change", () => {
    renderMap({ stocks: STOCKS.map((s) => ({ ...s, fundChangePct: null })), remainders: [] });
    expect(screen.getByText("n/a: no fund compared")).toBeInTheDocument();
    expect(screen.queryByText("no change")).toBeNull();
  });

  it("says when nothing in the view has a size", () => {
    renderMap({ stocks: [], remainders: [] });
    expect(screen.getByText(/No index fund file on record holds a stock in this view/)).toBeInTheDocument();
  });
});

describe("MoneyFlow", () => {
  it("draws every node as a named button, and a sector node focuses that sector", () => {
    const onFocusSector = jest.fn();
    const { container } = render(<MoneyFlow flow={FLOW} focusSector={null} onFocusSector={onFocusSector} />);
    expect(screen.getByRole("button", { name: /^Index managers: \$6\.00B, 75\.0% of the flow/ })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /^Materials: .*focus this sector/ }));
    expect(onFocusSector).toHaveBeenCalledWith("Materials");
    expect(container.innerHTML).not.toMatch(MARKET_COLOURS);
  });

  it("lights a node's paths on hover and reads its share out", () => {
    render(<MoneyFlow flow={FLOW} focusSector={null} onFocusSector={jest.fn()} />);
    fireEvent.pointerEnter(screen.getByRole("button", { name: /^Vanguard:/ }));
    expect(screen.getByText(/Vanguard, 62\.5% of the flow/)).toBeInTheDocument();
  });

  it("holds an institution lit when pressed, with a link to its holdings", () => {
    render(<MoneyFlow flow={FLOW} focusSector={null} onFocusSector={jest.fn()} />);
    const vanguard = screen.getByRole("button", { name: /^Vanguard:/ });
    fireEvent.click(vanguard);
    expect(vanguard).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("link", { name: "Vanguard's holdings" })).toHaveAttribute("href", "/ownership/vanguard");
  });
});

describe("PositionHeatmap", () => {
  it("is a table of named cells: a figure, a hatched n/a and its own drill", () => {
    const onSelect = jest.fn();
    render(<PositionHeatmap heatmap={HEATMAP} measure="funds" bucket="week" focusSector={null} selected={null} onSelect={onSelect} />);
    const cells = screen.getAllByRole("button");
    expect(cells[0]).toHaveAccessibleName("Materials, 2026-09-28 to 2026-10-04: +$220.0M in shares held, 1 funds compared");
    expect(cells[1]).toHaveAccessibleName("Materials, 2026-10-05 to 2026-10-11: n/a: no fund filed a newer file");
    fireEvent.click(cells[0]!);
    expect(onSelect).toHaveBeenCalledWith({ bucket: 0, sector: "Materials" });
  });

  it("states the notices behind a cell under disclosed stakes, and a quiet bucket as no notice", () => {
    const cell = HEATMAP.rows[0]!.cells[0]!;
    expect(cellText(cell, "disclosed")).toBe("+0.10 pp net, 2 notices, 1 rises, 1 falls");
    expect(cellText(HEATMAP.rows[0]!.cells[1]!, "disclosed")).toBe("no notice");
  });

  it("says what an empty window holds", () => {
    render(<PositionHeatmap heatmap={{ buckets: [], rows: [] }} measure="funds" bucket="" focusSector={null} selected={null} onSelect={jest.fn()} />);
    expect(screen.getByText(/no index fund filed two files inside it/)).toBeInTheDocument();
  });
});

describe("TimeWindow", () => {
  const base = {
    timelineFrom: "2025-01-15",
    timelineTo: "2026-10-31",
    from: "2026-08-03",
    to: "2026-10-31",
    snapshotDates: ["2026-08-31", "2026-09-30", "2026-10-31"],
    timeline: [{ month: "2026-10", notices: 24, files: 2 }],
    bucket: "week" as const,
    playing: false,
  };

  it("gives each handle a slider with the date as its value", () => {
    render(<TimeWindow {...base} onChange={jest.fn()} onPlay={jest.fn()} />);
    expect(screen.getByRole("slider", { name: "Window start" })).toHaveAttribute("aria-valuetext", "2026-08-03");
    expect(screen.getByRole("slider", { name: "Window end" })).toHaveAttribute("aria-valuetext", "2026-10-31");
  });

  it("asks for a preset once the handles settle, and steps back a week", () => {
    jest.useFakeTimers();
    try {
      const onChange = jest.fn();
      render(<TimeWindow {...base} onChange={onChange} onPlay={jest.fn()} />);
      fireEvent.click(screen.getByRole("button", { name: "30 days" }));
      expect(onChange).not.toHaveBeenCalled();
      jest.advanceTimersByTime(400);
      expect(onChange).toHaveBeenCalledWith("2026-10-02", "2026-10-31");
      fireEvent.click(screen.getByRole("button", { name: "Step back a week" }));
      jest.advanceTimersByTime(400);
      expect(onChange).toHaveBeenLastCalledWith("2026-07-27", "2026-10-24");
    } finally {
      jest.useRealTimers();
    }
  });

  it("offers a replay at the end, and nothing to move without a timeline", () => {
    const onPlay = jest.fn();
    const { rerender } = render(<TimeWindow {...base} onChange={jest.fn()} onPlay={onPlay} />);
    fireEvent.click(screen.getByRole("button", { name: "Replay" }));
    expect(onPlay).toHaveBeenCalled();
    rerender(<TimeWindow {...base} timelineFrom="" timelineTo="" from="" to="" onChange={jest.fn()} onPlay={onPlay} />);
    expect(screen.getByRole("slider", { name: "Window start" })).toBeDisabled();
  });

  it("steps a window along keeping its length, held to the timeline", () => {
    expect(stepWindow("2026-08-03", "2026-10-31", -1, "week", "2025-01-15", "2026-10-31")).toEqual({ from: "2026-07-27", to: "2026-10-24" });
    expect(stepWindow("2026-08-03", "2026-10-24", 1, "week", "2025-01-15", "2026-10-31")).toEqual({ from: "2026-08-10", to: "2026-10-31" });
    expect(stepWindow("2025-01-15", "2025-06-30", -1, "month", "2025-01-15", "2026-10-31")).toEqual({ from: "2025-01-15", to: "2025-06-30" });
    expect(stepWindow("2025-01-15", "2025-06-30", 1, "month", "2025-01-15", "2026-10-31")).toEqual({ from: "2025-02-14", to: "2025-07-30" });
  });
});
