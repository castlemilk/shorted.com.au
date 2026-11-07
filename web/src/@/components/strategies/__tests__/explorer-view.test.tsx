import { render, screen, within } from "@testing-library/react";
import "@testing-library/jest-dom";

import { ExplorerView, type ExplorerControls } from "../explorer-view";
import {
  DEFAULT_FILTERS,
  DEFAULT_UNIVERSE,
  DEFAULT_WINDOW_ID,
  EXPLORER_COPY,
  buildExplorerModel,
  type ExplorerModel,
} from "~/@/lib/strategies/explorer";
import { DEFS, EVIDENCE, EVIDENCE_RAW, GOLDEN_IDS, GOLDEN_START_YEAR, rowIdIn } from "~/@/lib/strategies/__tests__/golden-explorer";
import { formatSigned } from "~/@/lib/strategies/format";

// Every figure and copy line below is derived from the golden (./golden) through the model.
const NOW = new Date(`${EVIDENCE.pricesThrough}T12:00:00Z`);
const MODEL: ExplorerModel = buildExplorerModel({
  strategies: DEFS,
  evidence: EVIDENCE,
  now: NOW,
  today: {},
});
const PUBLISHED = rowIdIn("published");
const RUN_REQUIRED = rowIdIn("run_required");
const NOT_COMPUTABLE = GOLDEN_IDS.find((id) => EVIDENCE.strategies.find((s) => s.strategyId === id)?.state === "not_computable") ?? null;
const NAME = (id: string) => DEFS.find((d) => d.id === id)!.name;
const shared = (id: string) => EVIDENCE.strategies.find((s) => s.strategyId === id)!;
const yearCells = (id: string) => shared(id).annual;

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
      selectedId={PUBLISHED}
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

/** The index of a year's cell in a row, counting the checkbox cell first. */
const yearIndex = (year: number) => 1 + (year - GOLDEN_START_YEAR);

describe("the explorer's heatmap, row by row (from the golden)", () => {
  it("draws a published row's years as figures, with its coverage line from the golden's percent", () => {
    view();
    const cells = cellsOf(NAME(PUBLISHED));
    const measured = yearCells(PUBLISHED).find((a) => a.coverageMeasurable && a.coveragePct !== null)!;
    const cell = cells[yearIndex(measured.year)]!;
    expect(cell).toHaveTextContent(formatSigned(measured.strategyPct!));
    expect(cell).toHaveTextContent(`cov ${Math.round(measured.coveragePct!)}%`);
    expect(cell.querySelector("[title]")).toHaveAttribute("title", EXPLORER_COPY.lowCoverage(Math.round(measured.coveragePct!)));
  });

  it("marks each not-measurable year '?' with the measurement copy, and gives a measurable year no mark", () => {
    view();
    const cells = cellsOf(NAME("minervini-trend-template"));
    for (const a of yearCells("minervini-trend-template")) {
      const cell = cells[yearIndex(a.year)]!;
      if (a.coverageMeasurable) {
        expect(cell).not.toHaveTextContent("?");
      } else {
        expect(cell).toHaveTextContent("?");
        expect(cell.querySelector("[title]")).toHaveAttribute("title", EXPLORER_COPY.measuredOnAsic);
      }
    }
    // The golden has at least one of each, so the rule above is exercised both ways.
    expect(yearCells("minervini-trend-template").some((a) => a.coverageMeasurable)).toBe(true);
    expect(yearCells("minervini-trend-template").some((a) => !a.coverageMeasurable)).toBe(true);
  });

  it("merges the golden's not-computable years at computable_from, and names the approximate years after it", () => {
    if (!NOT_COMPUTABLE) return;
    view();
    const cells = cellsOf(NAME(NOT_COMPUTABLE));
    expect(cells[1]).toHaveAttribute("colspan");
    expect(cells[1]).toHaveTextContent(`Not computable before ${shared(NOT_COMPUTABLE).fiscalLabel}`);
    expect(cells[1]).toHaveClass("hatch-empty");
  });

  it("draws a run-required row as one hatched word per year", () => {
    view();
    const cells = cellsOf(NAME(RUN_REQUIRED));
    expect(cells[yearIndex(GOLDEN_START_YEAR)]).toHaveTextContent("Run required");
  });

  it("names the year columns: the first from 1 May, the to-date year as YTD", () => {
    view();
    const head = screen.getByRole("table").querySelector("thead")!;
    expect(head).toHaveTextContent(String(GOLDEN_START_YEAR));
    expect(head).toHaveTextContent("from 1 May");
    expect(head).toHaveTextContent(EXPLORER_COPY.ytd);
  });

  it("states the cov and ? legend under the table, the costs and the range from the golden", () => {
    view();
    expect(screen.getByText(/share of the names this strategy could have held that have prices/)).toBeInTheDocument();
    expect(screen.getAllByText(/Measured on ASIC-reported names only; delisted companies/).length).toBeGreaterThan(0);
    expect(screen.getByText(new RegExp(`^${MODEL.rangeLine.split(" · ")[0]!.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`))).toBeInTheDocument();
    expect(screen.getByText("Colour scale: annual return, total return after costs")).toBeInTheDocument();
  });

  it("shows the freeze chip on the table header, with a solid outline", () => {
    view();
    const chip = screen.getByText(MODEL.chipLabel);
    expect(chip.className).toContain("border-solid");
    expect(chip.className).not.toContain("border-dashed");
  });

  it("frames the selected row", () => {
    view();
    expect(cellsOf(NAME(PUBLISHED))[0]!.closest("tr")).toHaveAttribute("data-selected");
    expect(cellsOf(NAME(RUN_REQUIRED))[0]!.closest("tr")).not.toHaveAttribute("data-selected");
  });

  it("gives every name its short profile line", () => {
    view();
    expect(screen.getByText(MODEL.rows.find((r) => r.id === PUBLISHED)!.sublabel)).toBeInTheDocument();
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
  it("labels each control inside it, with the full universe meaning as the accessible name", () => {
    view();
    for (const name of ["Style", "Horizon", "Evidence", "Window"]) {
      expect(screen.getByRole("combobox", { name })).toBeInTheDocument();
    }
    expect(screen.getByRole("searchbox", { name: "Find a strategy" })).toBeInTheDocument();
    const universe = screen.getByRole("combobox", { name: "Universe: ASX ordinary shares" });
    expect(within(universe).getAllByRole("option").map((o) => o.textContent)).toEqual(["Universe: ASX", "Universe: ASIC-reported"]);
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
    unmount();
    view();
    expect(screen.getByRole("columnheader", { name: "CAGR" })).toBeInTheDocument();
  });

  it("filters the rows by the evidence filter", () => {
    view({ filters: { ...DEFAULT_FILTERS, evidence: "backtested" } });
    expect(screen.queryByRole("rowheader", { name: new RegExp(NAME(RUN_REQUIRED)) })).toBeNull();
    expect(screen.getByRole("rowheader", { name: new RegExp(NAME(PUBLISHED)) })).toBeInTheDocument();
  });

  it("the ASIC-reported universe narrows the table to the golden's ASIC-reported strategy", () => {
    const asic = GOLDEN_IDS.filter((id) => shared(id).universeKind === "asic_reported");
    view({ filters: { ...DEFAULT_FILTERS, universe: "asic_reported" } });
    for (const id of asic) expect(screen.getByRole("rowheader", { name: new RegExp(NAME(id)) })).toBeInTheDocument();
    for (const id of GOLDEN_IDS.filter((x) => !asic.includes(x))) {
      expect(screen.queryByRole("rowheader", { name: new RegExp(NAME(id)) })).toBeNull();
    }
    expect(DEFAULT_UNIVERSE).toBe("asx_ordinary");
  });

  it("says when no strategy matches", () => {
    view({ filters: { ...DEFAULT_FILTERS, query: "no such strategy" } });
    expect(screen.getByText("No strategy matches these filters.")).toBeInTheDocument();
  });
});

describe("the compare gate and tray", () => {
  const [first, second] = GOLDEN_IDS;

  it("draws no checkboxes and no tray while the compare capability is off", () => {
    view({ compareEnabled: false, picked: [first!, second!], signedIn: true });
    expect(screen.queryByRole("checkbox")).toBeNull();
    expect(screen.queryByRole("region", { name: "Strategies to compare" })).toBeNull();
  });

  it("holds nothing when no strategy is picked", () => {
    view();
    expect(screen.queryByRole("region", { name: "Strategies to compare" })).toBeNull();
  });

  it("names two picked strategies with a right-aligned primary comparison button, for a signed-in reader", () => {
    view({ picked: [first!, second!], signedIn: true });
    const tray = screen.getByRole("region", { name: "Strategies to compare" });
    expect(within(tray).getByText("2 strategies selected")).toBeInTheDocument();
    const cta = within(tray).getByRole("link", { name: "Compare strategies →" });
    expect(cta).toHaveAttribute("href", `/strategies/compare?ids=${first},${second}`);
    expect(cta.parentElement!.className).toContain("ml-auto");
  });

  it("offers an anonymous reader the sign-in prompt, returning to the same comparison", () => {
    view({ picked: [first!, second!], signedIn: false });
    const link = screen.getByRole("link", { name: "Sign in to compare" });
    expect(link).toHaveAttribute("href", `/signin?callbackUrl=${encodeURIComponent(`/strategies/compare?ids=${first},${second}`)}`);
    expect(screen.queryByRole("link", { name: "Compare strategies →" })).toBeNull();
  });

  it("draws a neutral, inert comparison button while the session loads", () => {
    view({ picked: [first!, second!], signedIn: undefined });
    expect(screen.queryByRole("link", { name: /Sign in to compare|Compare strategies/ })).toBeNull();
    expect(screen.getByText("Compare strategies →")).toHaveAttribute("aria-disabled", "true");
  });

  it("asks for one more strategy when only one is picked", () => {
    view({ picked: [first!], signedIn: true });
    expect(screen.getByText("Select one more to compare")).toBeInTheDocument();
  });

  it("holds no more than three: a fourth checkbox is disabled while three are picked", () => {
    const [a, b, c, d] = GOLDEN_IDS;
    if (!d) return;
    view({ picked: [a!, b!, c!], signedIn: true, controls: controlsSpy() });
    expect(screen.getByRole("checkbox", { name: `Compare ${NAME(d)}` })).toBeDisabled();
    expect(screen.getByRole("checkbox", { name: `Compare ${NAME(a!)}` })).toBeEnabled();
  });

  it("draws the checkboxes inert in the static render, and reports a tick through the controls when live", () => {
    const { unmount } = view();
    expect(screen.getByRole("checkbox", { name: `Compare ${NAME(second!)}` })).toBeDisabled();
    unmount();
    const controls = controlsSpy();
    view({ controls });
    screen.getByRole("checkbox", { name: `Compare ${NAME(second!)}` }).click();
    expect(controls.onToggle).toHaveBeenCalledWith(second);
  });
});

describe("the rail (StrategyInspector), from the golden", () => {
  function rail(id: string): HTMLElement {
    return document.querySelector(`[data-inspector="${id}"]`) as HTMLElement;
  }

  it("draws the name once, the author, chips and the figures", () => {
    view();
    const inspector = rail(PUBLISHED);
    expect(within(inspector).getAllByText(NAME(PUBLISHED))).toHaveLength(1);
    expect(within(inspector).getByText("Long entries")).toBeInTheDocument();
    expect(within(inspector).getByRole("link", { name: "Explore strategy →" })).toHaveAttribute("href", `/strategies/${PUBLISHED}`);
    expect(within(inspector).getByRole("link", { name: "Rules and assumptions" })).toHaveAttribute("href", `/strategies/${PUBLISHED}/rules`);
    expect(within(inspector).queryByRole("button", { name: /create alert/i })).toBeNull();
  });

  it("shows the growth line's caption as visible text, and the hypothetical line under the chart", () => {
    view();
    expect(within(rail(PUBLISHED)).getByText(MODEL.rows.find((r) => r.id === PUBLISHED)!.inspector.sparkLabel, { selector: "figcaption" })).toBeInTheDocument();
    expect(within(rail(PUBLISHED)).getByText(EXPLORER_COPY.hypothetical)).toBeInTheDocument();
  });

  it("prints the golden's survivorship statement, and the track line when the track is too short", () => {
    view();
    const survivorship = shared(PUBLISHED).survivorship;
    if (survivorship) expect(within(rail(PUBLISHED)).getByText(survivorship, { exact: false })).toBeInTheDocument();
    const paper = shared(PUBLISHED).paper;
    if (paper?.tooShort && paper.since) {
      expect(within(rail(PUBLISHED)).getByText(new RegExp(`^Recorded since`))).toBeInTheDocument();
    }
  });

  it("uses the state's own copy where there is no curve, not 'No backtest yet'", () => {
    if (!NOT_COMPUTABLE) return;
    view({ selectedId: NOT_COMPUTABLE });
    const inspector = rail(NOT_COMPUTABLE);
    expect(inspector).not.toHaveTextContent("No backtest yet");
    expect(within(inspector).getByText(new RegExp(`Not computable before ${shared(NOT_COMPUTABLE).fiscalLabel}`), { selector: "p" })).toBeInTheDocument();
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
    const first = GOLDEN_IDS[0]!;
    expect(screen.getByRole("rowheader", { name: new RegExp(NAME(first)) })).toBeInTheDocument();
    const cells = cellsOf(NAME(first));
    expect(cells[0]).toHaveAttribute("colspan", String(degraded.columns.length));
    expect(cells[0]).toHaveTextContent("");
  });
});
