import { render, screen, within } from "@testing-library/react";
import "@testing-library/jest-dom";

import { ExplorerView, type ExplorerControls } from "../explorer-view";
import {
  DEFAULT_FILTERS,
  DEFAULT_WINDOW_ID,
  buildExplorerModel,
  type ExplorerModel,
} from "~/@/lib/strategies/explorer";
import { DEFS, EVIDENCE } from "~/@/lib/strategies/__tests__/backtest-fixtures";

const NOW = new Date(Date.UTC(2026, 10, 7));
const MODEL: ExplorerModel = buildExplorerModel({ strategies: DEFS, evidence: EVIDENCE, now: NOW });

function controlsSpy(): ExplorerControls & Record<string, jest.Mock> {
  return {
    onFilters: jest.fn(),
    onWindow: jest.fn(),
    onSelect: jest.fn(),
    onToggle: jest.fn(),
  } as unknown as ExplorerControls & Record<string, jest.Mock>;
}

function view(overrides: Partial<Parameters<typeof ExplorerView>[0]> = {}) {
  return render(
    <ExplorerView
      model={MODEL}
      header={<h1>Strategies</h1>}
      filters={DEFAULT_FILTERS}
      windowId={DEFAULT_WINDOW_ID}
      selectedId="crowded-short-breakout"
      picked={[]}
      {...overrides}
    />,
  );
}

/** A row's cells, the checkbox cell first. */
function cellsOf(row: HTMLElement): HTMLElement[] {
  return within(row).getAllByRole("cell") as HTMLElement[];
}

function rowOf(name: string): HTMLElement {
  return screen.getByRole("rowheader", { name: new RegExp(name) }).closest("tr") as HTMLElement;
}

describe("the explorer's heatmap, row by row", () => {
  it("draws a computed row's years as figures, with the coverage line and the window's CAGR", () => {
    view();
    const cells = cellsOf(rowOf("Crowded-Short Breakout"));
    // The checkbox cell leads; then 8 year cells, then CAGR, Max DD and Live.
    expect(cells).toHaveLength(12);
    expect(cells[1]).toHaveTextContent("+15.9%");
    expect(cells[1]).toHaveTextContent("cov 64%");
    expect(cells[1]!.querySelector("[data-coverage-hatched]")).not.toBeNull();
    expect(cells[8]).toHaveTextContent("+9.1%");
    expect(cells[8]!.querySelector("[data-coverage-hatched]")).toBeNull();
    expect(cells[9]).toHaveTextContent("+15.6%");
    expect(cells[10]).toHaveTextContent("−18.6%");
    expect(cells[11]).toHaveTextContent("Tracking since 23 Nov 2026");
  });

  it("marks Minervini's years with a ? and names what the mark means", () => {
    view();
    const row = rowOf("Minervini Trend Template");
    const first = cellsOf(row)[1]!;
    expect(first).toHaveTextContent("+16.3%");
    expect(first).toHaveTextContent("?");
    expect(first).toHaveTextContent("Measured on ASIC-reported names only");
    expect(first).not.toHaveTextContent("cov ");
  });

  it("merges a fundamentals row's years before the fiscal label into one hatched cell, and names the rest", () => {
    view();
    const row = rowOf("Zanger Breakout");
    const cells = cellsOf(row);
    const merged = cells[1]!;
    expect(merged).toHaveAttribute("colspan", "5");
    expect(merged).toHaveTextContent("Not computable before FY2024");
    expect(merged).toHaveClass("hatch-empty");
    expect(cells[2]).toHaveTextContent("Approximate run not published");
    expect(cells[4]).toHaveTextContent("Approximate run not published");
  });

  it("draws a row with no fiscal label as one hatched cell with the no-label copy", () => {
    view();
    const cells = cellsOf(rowOf("Quality compounders"));
    expect(cells[1]).toHaveAttribute("colspan", "8");
    expect(cells[1]).toHaveTextContent("Not computable: needs point-in-time fundamentals");
  });

  it("names the year columns, the first from 1 May and the current one YTD", () => {
    view();
    const head = screen.getByRole("table").querySelector("thead")!;
    expect(head).toHaveTextContent("2019");
    expect(head).toHaveTextContent("from 1 May");
    expect(head).toHaveTextContent("2026 YTD");
  });

  it("carries the legend and the footer copy from the API", () => {
    view();
    expect(screen.getByText("Annual return, total return after costs")).toBeInTheDocument();
    expect(screen.getByText(/^1 May 2019 to 6 Nov 2026 · universe per strategy/)).toBeInTheDocument();
    expect(screen.getByText("Screening rules require an execution recipe before a portfolio can be backtested.")).toBeInTheDocument();
  });

  it("shows the freeze chip on the table header", () => {
    view();
    expect(screen.getByText("Backtests · in-sample to 23 Nov 2026")).toBeInTheDocument();
  });
});

describe("filters", () => {
  it("shows only the rows the filters keep", () => {
    view({ filters: { ...DEFAULT_FILTERS, evidence: "backtested" } });
    expect(screen.queryByRole("rowheader", { name: /Zanger/ })).toBeNull();
    expect(screen.getByRole("rowheader", { name: /Minervini/ })).toBeInTheDocument();
    expect(screen.getByRole("rowheader", { name: /Crowded-Short/ })).toBeInTheDocument();
  });

  it("says when no strategy matches", () => {
    view({ filters: { ...DEFAULT_FILTERS, query: "no such strategy" } });
    expect(screen.getByText("No strategy matches these filters.")).toBeInTheDocument();
  });

  it("names the Window select and offers its four windows", () => {
    view();
    const select = screen.getByRole("combobox", { name: "Window" });
    expect(select).toBeDisabled();
    expect(within(select).getAllByRole("option").map((o) => o.textContent)).toEqual([
      "Since May 2019",
      "Since 2023",
      "Last 12 months",
      "Live since freeze",
    ]);
  });

  it("swaps the CAGR column for the total return marked not annualised when the window is under a year", () => {
    view({ windowId: "live" });
    const cells = cellsOf(rowOf("Crowded-Short Breakout"));
    expect(cells[9]).toHaveTextContent("+1.8%");
    expect(cells[9]).toHaveTextContent("total return, not annualised");
  });
});

describe("the compare tray", () => {
  it("holds nothing when no strategy is picked", () => {
    view();
    expect(screen.queryByRole("region", { name: "Strategies to compare" })).toBeNull();
  });

  it("names two picked strategies and links to the comparison, for a signed-in reader", () => {
    view({ picked: ["canslim", "zanger-breakout"], signedIn: true });
    const tray = screen.getByRole("region", { name: "Strategies to compare" });
    expect(within(tray).getByText("2 strategies selected")).toBeInTheDocument();
    expect(within(tray).getByRole("link", { name: "Compare strategies →" })).toHaveAttribute(
      "href",
      "/strategies/compare?ids=canslim,zanger-breakout",
    );
  });

  it("offers an anonymous reader the sign-in prompt, returning to the same comparison", () => {
    view({ picked: ["canslim", "zanger-breakout"], signedIn: false });
    const link = screen.getByRole("link", { name: "Sign in to compare" });
    expect(link).toHaveAttribute(
      "href",
      `/signin?callbackUrl=${encodeURIComponent("/strategies/compare?ids=canslim,zanger-breakout")}`,
    );
    expect(screen.queryByRole("link", { name: "Compare strategies →" })).toBeNull();
  });

  it("asks for one more strategy when only one is picked", () => {
    view({ picked: ["canslim"], signedIn: true });
    expect(screen.getByText("Select one more to compare")).toBeInTheDocument();
  });

  it("holds no more than three: a fourth checkbox is disabled while three are picked", () => {
    view({ picked: ["canslim", "zanger-breakout", "minervini-trend-template"], signedIn: true, controls: controlsSpy() });
    expect(screen.getByRole("checkbox", { name: "Compare Quality compounders" })).toBeDisabled();
    expect(screen.getByRole("checkbox", { name: "Compare CAN SLIM" })).toBeEnabled();
  });

  it("draws the checkboxes inert in the static render, and reports a tick through the controls when live", () => {
    const { unmount } = view();
    expect(screen.getByRole("checkbox", { name: "Compare CAN SLIM" })).toBeDisabled();
    unmount();

    const controls = controlsSpy();
    view({ controls });
    const box = screen.getByRole("checkbox", { name: "Compare CAN SLIM" });
    expect(box).toBeEnabled();
    box.click();
    expect(controls.onToggle).toHaveBeenCalledWith("canslim");
  });
});

describe("the rail (StrategyInspector)", () => {
  it("draws the selected strategy's name, author, chips, tagline and figures", () => {
    view({ selectedId: "crowded-short-breakout" });
    const rail = screen.getByRole("region", { name: /Selected strategy|Crowded-Short Breakout/ }) ?? null;
    expect(rail).not.toBeNull();
    const inspector = document.querySelector('[data-inspector="crowded-short-breakout"]') as HTMLElement;
    expect(within(inspector).getByRole("heading", { level: 2, name: "Crowded-Short Breakout" })).toBeInTheDocument();
    expect(within(inspector).getByText("By Shorted")).toBeInTheDocument();
    expect(within(inspector).getByText("Long entries")).toBeInTheDocument();
    expect(within(inspector).getByText("Daily evaluation")).toBeInTheDocument();
    expect(within(inspector).getByRole("img", { name: "Backtest, in-sample to 23 Nov 2026, then recorded" })).toBeInTheDocument();
    expect(within(inspector).getByText("Days to weeks")).toBeInTheDocument();
    expect(within(inspector).getByText("3 Nov 2026")).toBeInTheDocument();
    expect(within(inspector).getByText("5 triggered · 66 setups")).toBeInTheDocument();
    expect(within(inspector).getByRole("link", { name: "Explore strategy →" })).toHaveAttribute("href", "/strategies/crowded-short-breakout");
    expect(within(inspector).getByRole("link", { name: "Rules and assumptions" })).toHaveAttribute("href", "/strategies/crowded-short-breakout/rules");
    expect(within(inspector).queryByRole("button", { name: /create alert/i })).toBeNull();
  });

  it("says too short to judge for a track that has not yet earned a figure", () => {
    view({ selectedId: "crowded-short-breakout" });
    expect(
      screen.getByText("Recorded since 23 Nov 2026: 10 sessions, 2 trades, too short to judge"),
    ).toBeInTheDocument();
  });

  it("asks for a selection when none is named", () => {
    view({ selectedId: null });
    expect(screen.getByText("Select a strategy to see its evidence.")).toBeInTheDocument();
  });
});

describe("the evidence read failed", () => {
  it("says so above the table and keeps every strategy named", () => {
    const degraded = buildExplorerModel({ strategies: DEFS, evidence: null, now: NOW });
    render(
      <ExplorerView
        model={degraded}
        header={null}
        filters={DEFAULT_FILTERS}
        windowId={DEFAULT_WINDOW_ID}
        selectedId={null}
        picked={[]}
      />,
    );
    expect(screen.getByText(/Backtest evidence is temporarily unavailable/)).toBeInTheDocument();
    expect(screen.getByRole("rowheader", { name: /Zanger/ })).toBeInTheDocument();
    expect(screen.getAllByText("Evidence unavailable right now")).toHaveLength(5 * 8);
  });
});
