import { render, screen, within } from "@testing-library/react";
import "@testing-library/jest-dom";

import { ExplorerView, type ExplorerControls } from "../explorer-view";
import { DEFAULT_FILTERS, DEFAULT_WINDOW_ID, EXPLORER_COPY, buildExplorerModel, type ExplorerModel } from "~/@/lib/strategies/explorer";
import { DEFS, EVIDENCE } from "~/@/lib/strategies/__tests__/backtest-fixtures";

const NOW = new Date(Date.UTC(2026, 10, 7));
const MODEL: ExplorerModel = buildExplorerModel({
  strategies: DEFS,
  evidence: EVIDENCE,
  now: NOW,
  today: { "crowded-short-breakout": { counts: { triggered: 5, setup: 66, watch: 1500, unknown: 4 }, asOf: "2026-11-03" } },
});

function controlsSpy(): ExplorerControls {
  return { onFilters: jest.fn(), onWindow: jest.fn(), onSelect: jest.fn(), onToggle: jest.fn() };
}

function view(overrides: Partial<Parameters<typeof ExplorerView>[0]> = {}) {
  return render(
    <ExplorerView
      model={MODEL}
      header={<h1>Explore trading strategies</h1>}
      filters={DEFAULT_FILTERS}
      windowId={DEFAULT_WINDOW_ID}
      selectedId="crowded-short-breakout"
      picked={[]}
      compareEnabled
      {...overrides}
    />,
  );
}

/** A row's cells: the checkbox cell first when compare is on. */
function cellsOf(name: string): HTMLElement[] {
  const row = screen.getByRole("rowheader", { name: new RegExp(name) }).closest("tr") as HTMLElement;
  return within(row).getAllByRole("cell") as HTMLElement[];
}

describe("the explorer's heatmap, row by row", () => {
  it("draws a published row's years as figures, with the coverage line and the window's figures", () => {
    view();
    const cells = cellsOf("Crowded-Short Breakout");
    // The checkbox leads; then 8 year cells; then CAGR, Max DD and Live.
    expect(cells).toHaveLength(12);
    expect(cells[1]).toHaveTextContent("+15.9%");
    expect(cells[1]).toHaveTextContent("cov 64%");
    expect(cells[1]!.querySelector("[data-coverage-hatched]")).not.toBeNull();
    expect(cells[1]!.querySelector("[title]")).toHaveAttribute("title", EXPLORER_COPY.lowCoverage(64));
    expect(cells[8]).toHaveTextContent("+9.1%");
    expect(cells[8]!.querySelector("[data-coverage-hatched]")).toBeNull();
    expect(cells[9]).toHaveTextContent("+15.6%");
    expect(cells[10]).toHaveTextContent("−18.6%");
    expect(cells[11]).toHaveTextContent("Tracking since 23 Nov 2026");
  });

  it("marks Minervini's unmeasurable years with a ? titled with the measurement copy, and no ? on a measurable year", () => {
    view();
    const cells = cellsOf("Minervini Trend Template");
    expect(cells[1]).toHaveTextContent("+16.3%");
    expect(cells[1]).toHaveTextContent("?");
    expect(cells[1]!.querySelector("[title]")).toHaveAttribute("title", EXPLORER_COPY.measuredOnAsic);
    expect(cells[1]).not.toHaveTextContent("cov ");
    // 2025 is measurable on the all-reported measure: no mark.
    expect(cells[7]).toHaveTextContent("+13.5%");
    expect(cells[7]).not.toHaveTextContent("?");
    expect(cells[7]).toHaveTextContent("cov 97%");
  });

  it("splits a fundamentals row at computable_from: one merged span, then one approximate span", () => {
    view();
    const cells = cellsOf("Zanger Breakout");
    expect(cells[1]).toHaveAttribute("colspan", "5");
    expect(cells[1]).toHaveTextContent("Not computable before FY2024");
    expect(cells[1]).toHaveClass("hatch-empty");
    expect(cells[2]).toHaveAttribute("colspan", "3");
    expect(cells[2]).toHaveTextContent("Approximate run not published");
  });

  it("draws a row with no label as one hatched cell with the share copy", () => {
    view();
    const cells = cellsOf("Quality compounders");
    expect(cells[1]).toHaveAttribute("colspan", "8");
    expect(cells[1]).toHaveTextContent("fundamentals for 42% of the universe");
  });

  it("names the year columns, the first from 1 May and the current one YTD", () => {
    view();
    const head = screen.getByRole("table").querySelector("thead")!;
    expect(head).toHaveTextContent("2019");
    expect(head).toHaveTextContent("from 1 May");
    expect(head).toHaveTextContent("2026 YTD");
  });

  it("states the cov and ? legend under the table, and the costs and the range", () => {
    view();
    expect(screen.getByText(/share of the names this strategy could have held that have prices/)).toBeInTheDocument();
    expect(screen.getAllByText(/Measured on ASIC-reported names only; delisted companies/).length).toBeGreaterThan(0);
    expect(screen.getByText(/^1 May 2019 to 6 Nov 2026 · universe per strategy/)).toBeInTheDocument();
    expect(screen.getByText("Colour scale: annual return, total return after costs")).toBeInTheDocument();
  });

  it("shows the freeze chip on the table header, with a solid outline", () => {
    view();
    const chip = screen.getByText("Backtests · in-sample to 23 Nov 2026");
    expect(chip.className).toContain("border-solid");
    expect(chip.className).not.toContain("border-dashed");
  });

  it("frames the selected row", () => {
    view();
    expect(cellsOf("Crowded-Short Breakout")[0]!.closest("tr")).toHaveAttribute("data-selected");
    expect(cellsOf("CAN SLIM")[0]!.closest("tr")).not.toHaveAttribute("data-selected");
  });

  it("gives every name a short profile line", () => {
    view();
    expect(screen.getByText("Short crowding · days-weeks")).toBeInTheDocument();
    expect(screen.getByText("Trend · weeks-months")).toBeInTheDocument();
  });

  it("keeps the table in a relative scroll wrapper, so a marker's label cannot widen the page", () => {
    view();
    const wrapper = document.querySelector("[data-heatmap-scroll]") as HTMLElement;
    expect(wrapper).toHaveClass("relative");
    expect(wrapper).toHaveClass("overflow-x-auto");
    expect(wrapper.querySelectorAll(".sr-only").length).toBeGreaterThan(0);
  });
});

describe("the toolbar and the window", () => {
  it("labels each control inside it, with the label as its accessible name", () => {
    view();
    for (const name of ["Style", "Horizon", "Evidence", "Window"]) {
      expect(screen.getByRole("combobox", { name })).toBeInTheDocument();
    }
    expect(screen.getByRole("searchbox", { name: "Find a strategy" })).toBeInTheDocument();
    // The visible label is short; the accessible name carries the full meaning.
    const universe = screen.getByRole("combobox", { name: "Universe: ASX ordinary shares" });
    expect(within(universe).getAllByRole("option").map((o) => o.textContent)).toEqual([
      "Universe: ASX",
      "Universe: ASIC-reported",
    ]);
    expect(within(universe).getAllByRole("option")[1]).toHaveAttribute("title", "ASIC-reported names");
    expect(within(universe).getAllByRole("option")[0]).toHaveAttribute("title", "ASX ordinary shares");
  });

  it("offers the four windows, and the Window select is inert without controls", () => {
    view();
    const select = screen.getByRole("combobox", { name: "Window" });
    expect(select).toBeDisabled();
    expect(within(select).getAllByRole("option").map((o) => o.textContent)).toEqual([
      "Window: Since May 2019",
      "Window: Since 2023",
      "Window: Last 12 months",
      "Window: Live since freeze",
    ]);
  });

  it("reads the live window's column as Return, and the other windows' as CAGR", () => {
    const { unmount } = view({ windowId: "live" });
    expect(screen.getByRole("columnheader", { name: "Return" })).toBeInTheDocument();
    expect(cellsOf("Crowded-Short Breakout")[9]).toHaveTextContent("total return, not annualised");
    unmount();
    view();
    expect(screen.getByRole("columnheader", { name: "CAGR" })).toBeInTheDocument();
  });

  it("filters the rows by the evidence filter", () => {
    view({ filters: { ...DEFAULT_FILTERS, evidence: "backtested" } });
    expect(screen.queryByRole("rowheader", { name: /Zanger/ })).toBeNull();
    expect(screen.getByRole("rowheader", { name: /Minervini/ })).toBeInTheDocument();
  });

  it("names the universe filter: ASIC-reported names narrows the table", () => {
    view({ filters: { ...DEFAULT_FILTERS, universe: "asic" } });
    expect(screen.getByRole("rowheader", { name: /Crowded-Short/ })).toBeInTheDocument();
    expect(screen.queryByRole("rowheader", { name: /Zanger/ })).toBeNull();
  });

  it("says when no strategy matches", () => {
    view({ filters: { ...DEFAULT_FILTERS, query: "no such strategy" } });
    expect(screen.getByText("No strategy matches these filters.")).toBeInTheDocument();
  });
});

describe("the compare gate and tray", () => {
  it("draws no checkboxes and no tray while the compare capability is off", () => {
    view({ compareEnabled: false, picked: ["canslim", "zanger-breakout"], signedIn: true });
    expect(screen.queryByRole("checkbox")).toBeNull();
    expect(screen.queryByRole("region", { name: "Strategies to compare" })).toBeNull();
  });

  it("holds nothing when no strategy is picked", () => {
    view();
    expect(screen.queryByRole("region", { name: "Strategies to compare" })).toBeNull();
  });

  it("names two picked strategies with a right-aligned primary comparison button, for a signed-in reader", () => {
    view({ picked: ["canslim", "zanger-breakout"], signedIn: true });
    const tray = screen.getByRole("region", { name: "Strategies to compare" });
    expect(within(tray).getByText("2 strategies selected")).toBeInTheDocument();
    const cta = within(tray).getByRole("link", { name: "Compare strategies →" });
    expect(cta).toHaveAttribute("href", "/strategies/compare?ids=canslim,zanger-breakout");
    // The button's own look comes from buttonVariants, which the test setup mocks; the
    // placement is the wrapper's, asserted here.
    expect(cta.parentElement!.className).toContain("ml-auto");
  });

  it("offers an anonymous reader the sign-in prompt, returning to the same comparison", () => {
    view({ picked: ["canslim", "zanger-breakout"], signedIn: false });
    const link = screen.getByRole("link", { name: "Sign in to compare" });
    expect(link).toHaveAttribute("href", `/signin?callbackUrl=${encodeURIComponent("/strategies/compare?ids=canslim,zanger-breakout")}`);
    expect(screen.queryByRole("link", { name: "Compare strategies →" })).toBeNull();
  });

  it("draws a neutral, inert comparison button while the session loads", () => {
    view({ picked: ["canslim", "zanger-breakout"], signedIn: undefined });
    expect(screen.queryByRole("link", { name: /Sign in to compare|Compare strategies/ })).toBeNull();
    expect(screen.getByText("Compare strategies →")).toHaveAttribute("aria-disabled", "true");
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
    box.click();
    expect(controls.onToggle).toHaveBeenCalledWith("canslim");
  });
});

describe("the rail (StrategyInspector)", () => {
  function rail(): HTMLElement {
    return document.querySelector('[data-inspector="crowded-short-breakout"]') as HTMLElement;
  }

  it("draws the name once, the author, chips, tagline and the figures", () => {
    view();
    const inspector = rail();
    expect(within(inspector).getByRole("heading", { level: 2, name: "Crowded-Short Breakout" })).toBeInTheDocument();
    expect(within(inspector).getByText("By Shorted")).toBeInTheDocument();
    expect(within(inspector).getByText("Long entries")).toBeInTheDocument();
    expect(within(inspector).getByText("Daily evaluation")).toBeInTheDocument();
    expect(within(inspector).getByText("Days to weeks")).toBeInTheDocument();
    expect(within(inspector).getByText("3 Nov 2026")).toBeInTheDocument();
    expect(within(inspector).getByText("5 triggered · 66 setups")).toBeInTheDocument();
    expect(within(inspector).getByRole("link", { name: "Explore strategy →" })).toHaveAttribute("href", "/strategies/crowded-short-breakout");
    expect(within(inspector).getByRole("link", { name: "Rules and assumptions" })).toHaveAttribute("href", "/strategies/crowded-short-breakout/rules");
    expect(within(inspector).queryByRole("button", { name: /create alert/i })).toBeNull();
  });

  it("shows the growth line's caption as visible text, and the hypothetical line under the chart", () => {
    view();
    const inspector = rail();
    expect(within(inspector).getByText("Backtest, in-sample to 23 Nov 2026, then recorded", { selector: "figcaption" })).toBeInTheDocument();
    expect(within(inspector).getByText(EXPLORER_COPY.hypothetical)).toBeInTheDocument();
  });

  it("prints the survivorship statement and the too-short line", () => {
    view();
    const inspector = rail();
    expect(within(inspector).getByText(/Flatters results/)).toBeInTheDocument();
    expect(within(inspector).getByText("Recorded since 23 Nov 2026: 10 sessions, 2 trades, too short to judge")).toBeInTheDocument();
  });

  it("uses the state's own copy where there is no curve, not 'No backtest yet'", () => {
    view({ selectedId: "zanger-breakout" });
    const inspector = document.querySelector('[data-inspector="zanger-breakout"]') as HTMLElement;
    expect(within(inspector).getByRole("img", { name: /Backtest, in-sample/ })).toHaveTextContent("Not computable");
    expect(within(inspector).getByText(/Not computable before FY2024/, { selector: "p" })).toBeInTheDocument();
  });

  it("asks for a selection when none is named", () => {
    view({ selectedId: null });
    expect(screen.getByText("Select a strategy to see its evidence.")).toBeInTheDocument();
  });
});

describe("the evidence read failed", () => {
  it("says so above the table and keeps every strategy named, one span per row with no text", () => {
    const degraded = buildExplorerModel({ strategies: DEFS, evidence: null, now: NOW });
    render(
      <ExplorerView
        model={degraded}
        header={null}
        filters={DEFAULT_FILTERS}
        windowId={DEFAULT_WINDOW_ID}
        selectedId={null}
        picked={[]}
        compareEnabled={false}
      />,
    );
    expect(screen.getByText(/Backtest evidence is temporarily unavailable/)).toBeInTheDocument();
    expect(screen.getByRole("rowheader", { name: /Zanger/ })).toBeInTheDocument();
    const cells = cellsOf("Zanger");
    expect(cells).toHaveLength(4); // the name is a row header; one merged cell; CAGR, Max DD, Live
    expect(cells[0]).toHaveAttribute("colspan", "8");
    expect(cells[0]).toHaveTextContent("");
  });
});
