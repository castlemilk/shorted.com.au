/// <reference types="jest" />

/**
 * The movement heatmap (spec 13.4): the week arithmetic, the sector sums, the
 * figures a cell states, the brush's window and the sr-only table with its links.
 * A week whose notices state no figure is hatched and reads n/a, never zero.
 */

import { fireEvent, render, screen, within } from "@testing-library/react";
import { scaleLinear } from "@visx/scale";

import type { IndustryWeekRow, OwnershipActivityPage } from "~/app/actions/ownershipDesk";
import { brushCommit, brushWindow, weeksUnderBrush, MovementHeatmap } from "../movement-heatmap";
import {
  HEAT_FULL_CELL,
  HEAT_PHONE_WEEKS,
  MovementHeatmapStatic,
  MovementHeatmapView,
  HEAT_FOLDED_ROW,
  HEAT_PANE_SECTORS,
  cellFigure,
  foldHeatRows,
  type HeatCell,
  type HeatRow,
  cellTitle,
  heatFeedHref,
  heatReach,
  heatRows,
  mondayOf,
  rowGlyph,
  rowNetTitle,
  selectedWeekRange,
  weekList,
  windowNetPp,
} from "../movement-heatmap-static";
import { DESK_DEFAULT_WINDOW_STATE, type NoticeWindow } from "../window-chips";

let mockSearchParams = new URLSearchParams("");
const mockReplace = jest.fn();
jest.mock("next/navigation", () => ({
  useSearchParams: () => mockSearchParams,
  useRouter: () => ({ replace: mockReplace, push: jest.fn(), prefetch: jest.fn() }),
}));

const WEEKS = weekList("2026-09-14", "2026-11-02");

function row(partial: Partial<IndustryWeekRow> & Pick<IndustryWeekRow, "industry" | "weekStart">): IndustryWeekRow {
  return {
    became: 0,
    increased: 0,
    decreased: 0,
    changed: 0,
    ceased: 0,
    nz: 0,
    netPp: null,
    ...partial,
  };
}

const ROWS: IndustryWeekRow[] = [
  row({ industry: "Materials", weekStart: "2026-11-02", became: 1, increased: 2, netPp: 1.2 }),
  row({ industry: "Materials", weekStart: "2026-10-26", increased: 1, netPp: -0.5 }),
  row({ industry: "Financials", weekStart: "2026-11-02", ceased: 1, netPp: null }),
  row({ industry: "", weekStart: "2026-09-14", increased: 1, netPp: 0.3 }),
  // Not a week of the window: dropped, never summed into a neighbour.
  row({ industry: "Materials", weekStart: "2026-08-31", increased: 9, netPp: 9 }),
];

const PAGE: OwnershipActivityPage = {
  ok: true,
  error: "",
  fromWeek: "2026-09-14",
  toWeek: "2026-11-02",
  asOf: "2026-11-03",
  rows: ROWS,
};

const DEFAULT: NoticeWindow = DESK_DEFAULT_WINDOW_STATE;

beforeEach(() => {
  mockSearchParams = new URLSearchParams("");
  mockReplace.mockClear();
});

describe("week arithmetic", () => {
  it("lists every Monday from the first week to the last, with none for a span that is not one", () => {
    expect(WEEKS).toEqual([
      "2026-09-14",
      "2026-09-21",
      "2026-09-28",
      "2026-10-05",
      "2026-10-12",
      "2026-10-19",
      "2026-10-26",
      "2026-11-02",
    ]);
    expect(weekList("2026-11-02", "2026-09-14")).toEqual([]);
    expect(weekList("bad", "2026-09-14")).toEqual([]);
  });

  it("starts a week on the Monday a date falls in", () => {
    expect(mondayOf("2026-11-03")).toBe("2026-11-02");
    expect(mondayOf("2026-11-02")).toBe("2026-11-02");
    expect(mondayOf("2026-11-08")).toBe("2026-11-02");
  });

  it("covers the weeks a chip names, counted back from the newest notice", () => {
    // 28 days back from 3 November starts on 7 October, inside the week of 5 October.
    expect(selectedWeekRange({ window: 28, since: "", until: "" }, "2026-11-03", WEEKS)).toEqual({
      first: 3,
      last: 7,
    });
  });

  it("covers the weeks of a brushed pair, and none when it has no week", () => {
    expect(
      selectedWeekRange({ window: 91, since: "2026-10-12", until: "2026-10-31" }, "2026-11-03", WEEKS),
    ).toEqual({ first: 4, last: 6 });
    expect(
      selectedWeekRange({ window: 91, since: "2026-12-01", until: "2026-12-05" }, "2026-11-03", WEEKS),
    ).toBeNull();
  });
});

describe("heatRows", () => {
  const rows = heatRows(ROWS, WEEKS, null);

  it("sums a sector's industries by week and drops a week outside the list", () => {
    const materials = rows.find((r) => r.sector === "Materials");
    expect(materials?.cells[7]).toMatchObject({ notices: 3, netPp: 1.2 });
    expect(materials?.cells[6]).toMatchObject({ notices: 1, netPp: -0.5 });
    expect(materials?.cells.reduce((sum, cell) => sum + cell.notices, 0)).toBe(4);
  });

  it("groups a placeholder industry under Other", () => {
    expect(rows.map((r) => r.sector)).toContain("Other");
  });

  it("states no net where a notice carries no figure, and never as zero", () => {
    const financials = rows.find((r) => r.sector === "Financials");
    expect(financials?.cells[7]).toMatchObject({ notices: 1, netPp: null });
    const other = rows.find((r) => r.sector === "Other");
    expect(other?.cells[0]).toMatchObject({ notices: 1, netPp: 0.3 });
  });

  it("states no net for a week whose notices are only partly figured", () => {
    const partial = heatRows(
      [
        row({ industry: "Energy", weekStart: "2026-11-02", became: 1, netPp: 2 }),
        // The same sector under a name with a stray space: one sector, two industries.
        row({ industry: " Energy ", weekStart: "2026-11-02", became: 1, netPp: null }),
      ],
      WEEKS,
      null,
    );
    expect(partial[0]?.cells[7]).toMatchObject({ notices: 2, netPp: null });
  });

  it("ranks sectors by the notices in the window, and every week counts when there is none", () => {
    expect(rows.map((r) => r.sector)).toEqual(["Materials", "Financials", "Other"]);
    const early = heatRows(ROWS, WEEKS, { first: 0, last: 0 });
    expect(early.map((r) => r.sector)).toEqual(["Other", "Financials", "Materials"].slice(0, early.length));
    expect(early[0]?.sector).toBe("Other");
  });

  it("reads the largest net as the scale of the colours", () => {
    expect(heatReach(rows)).toBeCloseTo(1.2);
  });
});

describe("what a cell says", () => {
  const rows = heatRows(ROWS, WEEKS, null);

  it("states its counts by event and its net in percentage points, with a true minus", () => {
    const materials = rows.find((r) => r.sector === "Materials")!;
    expect(cellTitle("Materials", materials.cells[7]!)).toBe(
      "Materials, week of 2026-11-02: 3 notices (1 became substantial, 2 increased); net change in disclosed voting power +1.20 pp",
    );
    expect(cellTitle("Materials", materials.cells[6]!)).toContain("−0.50 pp");
  });

  it("says n/a for a net no notice states, and no notices for an empty week", () => {
    const financials = rows.find((r) => r.sector === "Financials")!;
    expect(cellTitle("Financials", financials.cells[7]!)).toContain("net change in disclosed voting power n/a");
    expect(cellTitle("Financials", financials.cells[0]!)).toBe(
      "Financials, week of 2026-09-14: no notices read",
    );
  });

  it("links to the feed for one sector and one week, and leaves the sector out for the placeholder group", () => {
    expect(heatFeedHref("Materials", "2026-11-02")).toBe(
      "/ownership/notices?industry=Materials&since=2026-11-02&until=2026-11-08",
    );
    expect(heatFeedHref("Other", "2026-09-14")).toBe("/ownership/notices?since=2026-09-14&until=2026-09-20");
  });
});

/**
 * The bounds visx reports for a pointer extent in pixels: the brush widens its extent
 * by 2 px on each side (SAFE_PIXEL) and inverts it through its own xScale, which maps
 * the weeks to pixels. Built the same way, so the units the brush reports are pinned.
 */
function brushBounds(startPx: number, endPx: number, count: number) {
  const xScale = scaleLinear<number>({ domain: [0, count], range: [0, count * HEAT_FULL_CELL] });
  return { x0: xScale.invert(startPx - 2), x1: xScale.invert(endPx + 2) };
}

describe("brushWindow and weeksUnderBrush", () => {
  it("turns a span of weeks into a brushed window, ending on the newest notice at the last week", () => {
    expect(brushWindow(6, 7, WEEKS, "2026-11-03", 91)).toEqual({
      window: 91,
      since: "2026-10-26",
      until: "2026-11-03",
    });
    expect(brushWindow(2, 4, WEEKS, "2026-11-03", 91)).toEqual({
      window: 91,
      since: "2026-09-28",
      until: "2026-10-18",
    });
  });

  it("reads the bounds visx reports in weeks: a span of whole weeks comes back as those weeks", () => {
    // Weeks 4 to 6 inclusive are the pixels [4 * 12, 7 * 12]; visx reports them as weeks [4, 7].
    expect(weeksUnderBrush(brushBounds(4 * HEAT_FULL_CELL, 7 * HEAT_FULL_CELL, 8), 8)).toEqual({ first: 4, last: 6 });
    expect(weeksUnderBrush(brushBounds(0, 8 * HEAT_FULL_CELL, 8), 8)).toEqual({ first: 0, last: 7 });
  });

  it("reads every week a pointer touches, not the week it starts on alone", () => {
    // A drag from inside week 4 to inside week 6 touches 4, 5 and 6.
    const drag = brushBounds(4.4 * HEAT_FULL_CELL, 6.6 * HEAT_FULL_CELL, 8);
    expect(weeksUnderBrush(drag, 8)).toEqual({ first: 4, last: 6 });
  });

  it("reads a brush of one week, and clamps a brush that runs past the grid", () => {
    expect(weeksUnderBrush(brushBounds(12, 24, 8), 8)).toEqual({ first: 1, last: 1 });
    expect(weeksUnderBrush({ x0: 6.5, x1: 40 }, 8)).toEqual({ first: 6, last: 7 });
  });
});

describe("brushCommit", () => {
  const CHIP_91 = { window: 91 as const, since: "", until: "" };
  const ASOF = "2026-11-03";

  it("writes nothing when the release is the span already committed, so a chip survives a touch", () => {
    // The 91-day chip reaches back past the first week shown, so it spans every week to the newest.
    const span = selectedWeekRange(CHIP_91, ASOF, WEEKS);
    expect(span).not.toBeNull();
    expect(brushCommit(span!.first, span!.last, CHIP_91, WEEKS, ASOF, 91)).toBeNull();
  });

  it("writes the moved span as a brushed pair", () => {
    expect(brushCommit(2, 4, CHIP_91, WEEKS, ASOF, 91)).toEqual({
      window: 91,
      since: "2026-09-28",
      until: "2026-10-18",
    });
  });
});

describe("MovementHeatmapStatic", () => {
  it("draws the chips, the caption, the cells' figures and an sr-only table of the weeks with notices", () => {
    const { container } = render(
      <MovementHeatmapStatic page={PAGE} state={DEFAULT} basePath="/ownership" />,
    );
    // The window is one labelled select, drawn disabled on the server (spec 14.9).
    expect(screen.getByRole("combobox", { name: "Window" })).toBeDisabled();
    const table = screen.getByRole("table", { name: "Movement by sector and week" });
    const rows = within(table).getAllByRole("row");
    // The header row and one row per sector and week with notices: Materials twice, Financials and Other once.
    expect(rows).toHaveLength(5);
    expect(within(table).getByRole("link", { name: "3 notices" })).toHaveAttribute(
      "href",
      "/ownership/notices?industry=Materials&since=2026-11-02&until=2026-11-08",
    );
    expect(within(table).getAllByRole("cell", { name: "n/a" }).length).toBeGreaterThan(0);
    const titles = Array.from(container.querySelectorAll("title")).map((t) => t.textContent);
    expect(titles).toContain(
      "Materials, week of 2026-11-02: 3 notices (1 became substantial, 2 increased); net change in disclosed voting power +1.20 pp",
    );
    // The stated-figure cells are painted; the cell with no figure is hatched.
    expect(container.querySelector('rect[fill^="url(#movement-full-hatch)"]')).not.toBeNull();
  });

  it("draws the newest 26 weeks for a phone, as its own grid", () => {
    const many = weekList("2025-11-10", "2026-11-02");
    expect(many.length).toBeGreaterThan(HEAT_PHONE_WEEKS);
    const { container } = render(
      <MovementHeatmapStatic
        page={{ ...PAGE, fromWeek: "2025-11-10", rows: [row({ industry: "Materials", weekStart: "2025-11-10", increased: 1, netPp: 0.1 })] }}
        state={DEFAULT}
        basePath="/ownership"
      />,
    );
    // The phone drawing is the first grid and has one row; the cell of the first week is outside its 26 weeks.
    const [phone] = Array.from(container.querySelectorAll("svg[preserveAspectRatio='none']"));
    expect(phone?.querySelectorAll("g > g")).toHaveLength(0);
  });

  it("marks the window as one hairline under its columns on the phone grid, and none when it covers every shown week", () => {
    const windowed = render(
      <MovementHeatmapStatic page={PAGE} state={{ window: 28, since: "", until: "" }} basePath="/ownership" />,
    );
    const [phone] = Array.from(windowed.container.querySelectorAll("svg[preserveAspectRatio='none']"));
    // The pattern's hatch is a line too, so the window's rule is the one outside a pattern.
    const rules = Array.from(phone!.querySelectorAll("line")).filter((line) => line.closest("pattern") === null);
    expect(rules).toHaveLength(1);
    // 28 days back from 3 November starts in the week of 5 October, the fourth of the eight weeks: columns 3 to 7 at the phone's 10px cell.
    expect(rules[0]).toHaveAttribute("x1", "30");
    expect(rules[0]).toHaveAttribute("x2", "80");
    windowed.unmount();
    const wide = render(<MovementHeatmapStatic page={PAGE} state={DEFAULT} basePath="/ownership" />);
    const [widePhone] = Array.from(wide.container.querySelectorAll("svg[preserveAspectRatio='none']"));
    expect(Array.from(widePhone!.querySelectorAll("line")).filter((line) => line.closest("pattern") === null)).toHaveLength(0);
  });

  it("says the movement could not be read, and links nothing, when the read failed", () => {
    render(
      <MovementHeatmapStatic
        page={{ ok: false, error: "", fromWeek: "", toWeek: "", asOf: "", rows: [] }}
        state={DEFAULT}
        basePath="/ownership"
      />,
    );
    expect(screen.getByRole("status")).toHaveTextContent("The movement could not be read just now.");
    expect(screen.queryByRole("table")).toBeNull();
  });
});

describe("MovementHeatmap island", () => {
  it("asks the loader again when the link moves the window, and draws the page it returns", async () => {
    const LATER: OwnershipActivityPage = {
      ...PAGE,
      rows: [row({ industry: "Mining", weekStart: "2026-11-02", increased: 4, netPp: 2 })],
    };
    const loadActivity = jest.fn(async () => LATER);
    const { rerender } = render(<MovementHeatmap initial={PAGE} basePath="/ownership" loadActivity={loadActivity} />);
    expect(loadActivity).not.toHaveBeenCalled();
    mockSearchParams = new URLSearchParams("window=28");
    rerender(<MovementHeatmap initial={PAGE} basePath="/ownership" loadActivity={loadActivity} />);
    expect(loadActivity).toHaveBeenCalledWith({});
    expect(await screen.findByRole("rowheader", { name: "Mining" })).toBeInTheDocument();
  });

  it("keeps the page on screen when the loader cannot read the activity", async () => {
    const loadActivity = jest.fn(async () => ({ ...PAGE, ok: false, rows: [] }));
    const { rerender } = render(<MovementHeatmap initial={PAGE} basePath="/ownership" loadActivity={loadActivity} />);
    mockSearchParams = new URLSearchParams("window=28");
    rerender(<MovementHeatmap initial={PAGE} basePath="/ownership" loadActivity={loadActivity} />);
    await Promise.resolve();
    expect(screen.getAllByRole("rowheader", { name: "Materials" }).length).toBeGreaterThan(0);
    expect(screen.queryByText("could not be read just now")).toBeNull();
  });

  it("draws the window the link names as the selected option, and the brush beside the grid", () => {
    mockSearchParams = new URLSearchParams("window=28");
    render(<MovementHeatmap initial={PAGE} basePath="/ownership" variant="full" />);
    expect(screen.getByRole("combobox", { name: "Window" })).toHaveValue("28");
    expect(screen.getByText("Adjust the period")).toBeInTheDocument();
    expect(mockReplace).not.toHaveBeenCalled();
  });

  it("draws the brushed window as the brushed option, and its table names the dates", () => {
    mockSearchParams = new URLSearchParams("since=2026-10-12&until=2026-10-31");
    render(<MovementHeatmap initial={PAGE} basePath="/ownership" variant="full" />);
    expect(screen.getByRole("combobox", { name: "Window" })).toHaveValue("brushed");
    expect(screen.getByRole("table", { name: "Movement by sector and week" })).toBeInTheDocument();
  });
});

const EN_DASH = String.fromCharCode(0x2013);
const TRUE_MINUS = String.fromCharCode(0x2212);

describe("the grid's figures and the compact pane (spec 14.3, 14.7)", () => {
  it("prints no figures and no window chips on the Overview's compact pane", () => {
    mockSearchParams = new URLSearchParams();
    render(<MovementHeatmap initial={PAGE} basePath="/ownership" />);
    expect(screen.queryByRole("combobox", { name: "Window" })).toBeNull();
    expect(document.querySelector("span.text-\\[9px\\]")).toBeNull();
  });

  it("prints the workspace's figures in the cells, as HTML text, over a short window", () => {
    const { container } = render(<MovementHeatmapStatic page={PAGE} state={DEFAULT} basePath="/ownership" />);
    const figures = Array.from(container.querySelectorAll("span.text-center.font-mono")).map((node) => node.textContent);
    expect(figures).toContain("+1.2");
    expect(figures).toContain(EN_DASH);
    expect(container.querySelector("svg text")).toBeNull();
  });

  it("prints a zero week as a dash and a net under a tenth as the dash, never +0.0", () => {
    expect(cellFigure({ weekStart: "2026-11-02", notices: 1, netPp: 0.03 } as never, "pp")).toBe(EN_DASH);
    expect(cellFigure({ weekStart: "2026-11-02", notices: 1, netPp: -0.04 } as never, "pp")).toBe(EN_DASH);
    expect(cellFigure({ weekStart: "2026-11-02", notices: 1, netPp: -0.3 } as never, "pp")).toBe(`${TRUE_MINUS}0.3`);
  });
});

describe("MovementHeatmap workspace (spec 14.7)", () => {
  it("asks for the holder type a cell link names, so the grid draws the kind the outline describes", async () => {
    mockSearchParams = new URLSearchParams("sel=cell:Materials@2026-10-26:hedge_fund");
    const loadActivity = jest.fn(async () => PAGE);
    render(<MovementHeatmap initial={PAGE} basePath="/ownership/activity" variant="full" loadActivity={loadActivity} />);
    expect(loadActivity).toHaveBeenCalledWith({ kind: "hedge_fund" });
    expect(screen.getByLabelText("Holder type")).toHaveValue("hedge_fund");
  });

  it("does not ask when the link names no holder type", () => {
    mockSearchParams = new URLSearchParams("sel=cell:Materials@2026-10-26");
    const loadActivity = jest.fn(async () => PAGE);
    render(<MovementHeatmap initial={PAGE} basePath="/ownership/activity" variant="full" loadActivity={loadActivity} />);
    expect(loadActivity).not.toHaveBeenCalled();
  });

  it("names the brush 'Adjust the period' and prints the window's week dates over the figures", () => {
    mockSearchParams = new URLSearchParams("");
    render(<MovementHeatmap initial={PAGE} basePath="/ownership/activity" variant="full" />);
    expect(screen.getByText("Adjust the period")).toBeInTheDocument();
    expect(screen.getAllByText("2 Nov").length).toBeGreaterThan(0);
  });
});

describe("the Overview's compact pane (backlog B2)", () => {
  const LETTERS = "ABCDEFGHIJKLM".split("");
  // Thirteen sectors with notices in the newest week: the eleven most active stay, the last two fold.
  const BUSY: OwnershipActivityPage = {
    ok: true,
    error: "",
    fromWeek: "2026-08-24",
    toWeek: "2026-11-02",
    asOf: "2026-11-03",
    rows: LETTERS.map((letter, index) => row({ industry: `Sector ${letter}`, weekStart: "2026-11-02", became: 13 - index, netPp: 1 })),
  };

  it("draws the eleven most active sectors and one 'Other sectors' row that names no feed and selects nothing", () => {
    const { container } = render(
      <MovementHeatmapView page={BUSY} state={DESK_DEFAULT_WINDOW_STATE} basePath="/ownership" params={new URLSearchParams()} compact />,
    );
    const labels = Array.from(container.querySelectorAll("ol > li")).map((item) => item.textContent);
    expect(labels).toContain("Other sectors");
    expect(labels).toContain("Sector A");
    expect(labels).not.toContain("Sector L");
    expect(labels).not.toContain("Sector M");
    const folded = screen.getAllByText("Other sectors").find((node) => node.tagName === "TH");
    expect(folded?.closest("tr")?.querySelector("a")).toBeNull();
    expect(folded?.closest("tr")).toHaveTextContent("3 notices");
    expect(container.querySelector("[role='button'][data-sector='Other sectors']")).toBeNull();
  });

  it("draws the newest ten weeks, with no brush, no figures and no key of the hatch", () => {
    const { container } = render(
      <MovementHeatmapView page={BUSY} state={DESK_DEFAULT_WINDOW_STATE} basePath="/ownership" params={new URLSearchParams()} compact />,
    );
    expect(container.querySelector('svg[viewBox^="0 0 120 "]')).not.toBeNull();
    expect(screen.queryByText("Adjust the period")).toBeNull();
    expect(screen.queryByText("Notices with no figure stated")).toBeNull();
    expect(container.querySelector("span.text-\\[11px\\]")).toBeNull();
    // The pane has no control row of its own: the period and the window are the hub's toolbar.
    expect(container.querySelector("[data-toolbar]")).toBeNull();
  });
});

const heatCell = (weekStart: string, notices: number, netPp: number | null): HeatCell => ({
  weekStart,
  notices,
  counts: { became: notices, increased: 0, decreased: 0, changed: 0, ceased: 0, nz: 0 },
  netPp,
});
const heatRow = (sector: string, cells: HeatCell[]): HeatRow => ({
  sector,
  total: cells.reduce((sum, cell) => sum + cell.notices, 0),
  cells,
});

describe("foldHeatRows (backlog B2)", () => {
  const WEEKS = ["2026-10-26", "2026-11-02"];
  const a = heatRow("A", [heatCell(WEEKS[0]!, 5, 1), heatCell(WEEKS[1]!, 2, 0.5)]);
  const b = heatRow("B", [heatCell(WEEKS[0]!, 3, 1), heatCell(WEEKS[1]!, 1, 0.5)]);
  const c = heatRow("C", [heatCell(WEEKS[0]!, 2, 2), heatCell(WEEKS[1]!, 1, null)]);
  const d = heatRow("D", [heatCell(WEEKS[0]!, 0, null), heatCell(WEEKS[1]!, 1, 0.25)]);

  it("keeps the rows as they are when there are no more than the rows to keep", () => {
    expect(foldHeatRows([a, b], 2)).toEqual([a, b]);
  });

  it("sums the rest into one row, and states a week's net only where every folded notice states one", () => {
    const folded = foldHeatRows([a, b, c, d], 2);
    expect(folded.map((row) => row.sector)).toEqual(["A", "B", HEAT_FOLDED_ROW]);
    const rest = folded[2]!;
    expect(rest.total).toBe(c.total + d.total);
    // The first week: C's two notices state +2 and D has none that week, so the sum is stated.
    expect(rest.cells[0]).toMatchObject({ notices: 2, netPp: 2 });
    // The second week: C's notice states no figure, so the folded week reads n/a, never a partial sum.
    expect(rest.cells[1]).toMatchObject({ notices: 2, netPp: null });
  });

  it("keeps the compact pane's eleven sectors as its default", () => {
    expect(HEAT_PANE_SECTORS).toBe(11);
  });
});

/** The grid's rows whose title is exactly `title`. An attribute selector is not used: jsdom's does not match a "+" in one. */
function titled(container: HTMLElement, title: string): HTMLElement[] {
  return Array.from(container.querySelectorAll("li")).filter((li) => li.getAttribute("title") === title) as HTMLElement[];
}

/*
 * The "changed" sort (backlog C3). Over the window, Mining nets +3.00 pp, Banks +0.40, Telco +0.001
 * (a figure that prints as zero), Energy -2.00, and Health Care states no figure. Rises first, a
 * row with no figure last.
 */
const UP = "\u25B2";
const DOWN = "\u25BC";
const DASH = "\u2013";
const MINUS = "\u2212";
const MOVERS: IndustryWeekRow[] = [
  row({ industry: "Energy", weekStart: "2026-11-02", decreased: 1, netPp: -2 }),
  row({ industry: "Mining", weekStart: "2026-11-02", increased: 2, netPp: 3 }),
  row({ industry: "Banks", weekStart: "2026-10-26", increased: 1, netPp: 0.4 }),
  row({ industry: "Health Care", weekStart: "2026-11-02", became: 1, netPp: null }),
  row({ industry: "Telco", weekStart: "2026-11-02", increased: 1, netPp: 0.001 }),
];
const MOVERS_PAGE: OwnershipActivityPage = { ...PAGE, rows: MOVERS };

describe("the changed sort (backlog C3)", () => {
  it("orders the sectors by the window's net change, rises first and a row with no figure last", () => {
    expect(heatRows(MOVERS, WEEKS, null, "changed").map((r) => r.sector)).toEqual([
      "Mining",
      "Banks",
      "Telco",
      "Energy",
      "Health Care",
    ]);
  });

  it("sums only the window's weeks, so a sector's net is the one the window shows", () => {
    // Only the newest week is in range: Banks has nothing there, Health Care states no figure there.
    expect(heatRows(MOVERS, WEEKS, { first: 7, last: 7 }, "changed").map((r) => r.sector)).toEqual([
      "Mining",
      "Telco",
      "Energy",
      "Health Care",
      "Banks",
    ]);
  });

  it("keeps the order by notices under the largest sort, as before", () => {
    // Mining has the most notices; the rest have one each and fall to their name.
    expect(heatRows(MOVERS, WEEKS, null, "largest").map((r) => r.sector)).toEqual([
      "Mining",
      "Banks",
      "Energy",
      "Health Care",
      "Telco",
    ]);
  });

  it("sums the stated net of the weeks in the window, and states none when no week states one", () => {
    const energy = heatRows(MOVERS, WEEKS, null).find((r) => r.sector === "Energy")!;
    expect(windowNetPp(energy, null)).toBe(-2);
    const health = heatRows(MOVERS, WEEKS, null).find((r) => r.sector === "Health Care")!;
    expect(windowNetPp(health, null)).toBeNull();
    expect(windowNetPp(energy, { first: 0, last: 3 })).toBeNull();
  });

  it("gives each row a direction glyph, drawn as a rise, a fall, or an en dash for no stated change", () => {
    expect(rowGlyph(3)).toBe(UP);
    expect(rowGlyph(-2)).toBe(DOWN);
    expect(rowGlyph(0.001)).toBe(DASH);
    expect(rowGlyph(null)).toBe(DASH);
  });

  it("states the net in a row's title, with a true minus, and n/a words for no figure", () => {
    expect(rowNetTitle("Mining", 3)).toBe("Mining, +3.00 pp over the window");
    expect(rowNetTitle("Energy", -2)).toBe(`Energy, ${MINUS}2.00 pp over the window`);
    expect(rowNetTitle("Health Care", null)).toBe("Health Care, no net change stated over the window");
  });

  it("states no window net when a week with notices in the window states no figure, so a partial sum is never a change", () => {
    const mixed = heatRows(
      [
        row({ industry: "Mining", weekStart: "2026-10-26", increased: 1, netPp: 3 }),
        row({ industry: "Mining", weekStart: "2026-11-02", became: 1, netPp: null }),
      ],
      WEEKS,
      null,
      "changed",
    )[0]!;
    expect(windowNetPp(mixed, null)).toBeNull();
    // The week that states a figure is the whole window when the range is that week alone.
    expect(windowNetPp(mixed, { first: 6, last: 6 })).toBe(3);
    expect(rowNetTitle("Mining", windowNetPp(mixed, null))).toBe("Mining, no net change stated over the window");
  });

  it("says each row's window net in the sr-only table's row header under the changed sort, and not under the largest", () => {
    const { container, unmount } = render(
      <MovementHeatmapView page={MOVERS_PAGE} state={DEFAULT} basePath="/ownership" params={new URLSearchParams()} workspace sort="changed" />,
    );
    const changedHeaders = Array.from(container.querySelectorAll("tbody th[scope=row]")).map((header) => header.textContent);
    expect(changedHeaders).toContain("Mining, +3.00 pp over the window");
    expect(changedHeaders).toContain(`Energy, ${MINUS}2.00 pp over the window`);
    expect(changedHeaders).toContain("Health Care, no net change stated over the window");
    unmount();
    const { container: plain } = render(
      <MovementHeatmapView page={MOVERS_PAGE} state={DEFAULT} basePath="/ownership" params={new URLSearchParams()} workspace />,
    );
    for (const header of Array.from(plain.querySelectorAll("tbody th[scope=row]")).map((item) => item.textContent)) {
      expect(header).not.toContain("over the window");
    }
  });

  it("draws the glyph before each label on both grids, in the foreground, and the net in the title", () => {
    const { container } = render(
      <MovementHeatmapView page={MOVERS_PAGE} state={DEFAULT} basePath="/ownership" params={new URLSearchParams()} workspace sort="changed" />,
    );
    // The grid labels Mining as Materials (the short sector name); its title keeps the sector.
    const mining = titled(container, "Mining, +3.00 pp over the window");
    expect(mining.length).toBeGreaterThan(0);
    for (const item of mining) {
      expect(item.textContent).toBe(`${UP}Materials`);
      expect(item.querySelector("span")).toHaveClass("text-foreground");
    }
    // Each row is drawn once per grid, the phone's and the full one's, so every match is checked.
    for (const item of titled(container, `Energy, ${MINUS}2.00 pp over the window`)) expect(item.textContent).toBe(`${DOWN}Energy`);
    for (const item of titled(container, "Health Care, no net change stated over the window")) {
      expect(item.textContent).toBe(`${DASH}Health Care`);
    }
  });

  it("draws no glyph under the largest sort, and the sector's name as the row's title", () => {
    const { container } = render(
      <MovementHeatmapView page={MOVERS_PAGE} state={DEFAULT} basePath="/ownership" params={new URLSearchParams()} workspace />,
    );
    const mining = titled(container, "Mining");
    expect(mining.length).toBeGreaterThan(0);
    for (const item of mining) expect(item.textContent).toBe("Materials");
  });

  it("says in the workspace's caption how the sectors are ordered under each sort", () => {
    const { unmount } = render(
      <MovementHeatmapView page={MOVERS_PAGE} state={DEFAULT} basePath="/ownership" params={new URLSearchParams()} workspace sort="changed" />,
    );
    expect(screen.getByText(/Sectors are sorted by their net change over the window, rises first\./)).toBeInTheDocument();
    unmount();
    render(<MovementHeatmapView page={MOVERS_PAGE} state={DEFAULT} basePath="/ownership" params={new URLSearchParams()} workspace />);
    expect(screen.getByText(/Sectors are sorted by the notices released/)).toBeInTheDocument();
  });

  it("keeps the 'Other sectors' row last under the changed sort, on the compact pane too", () => {
    const LETTERS13 = "ABCDEFGHIJKLM".split("");
    const busy: OwnershipActivityPage = {
      ...PAGE,
      rows: LETTERS13.map((letter, index) =>
        row({ industry: `Sector ${letter}`, weekStart: "2026-11-02", became: 13 - index, netPp: index === 12 ? -4 : 1 }),
      ),
    };
    const { container } = render(
      <MovementHeatmapView page={busy} state={DESK_DEFAULT_WINDOW_STATE} basePath="/ownership" params={new URLSearchParams()} compact sort="changed" />,
    );
    const labels = Array.from(container.querySelectorAll("ol > li")).map((item) => item.textContent);
    // Sector M (-4.00) moved most by magnitude, so the pane keeps it first; the folded row nets the two
    // smallest rises (+1.00 each, the sectors K and L), a rise, and is drawn last.
    expect(labels[0]).toBe(`${DOWN}Sector M`);
    expect(labels[labels.length - 1]).toBe(`${UP}Other sectors`);
  });

  it("keeps the two fallers on the compact pane under the changed sort when they are among the eleven largest by magnitude", () => {
    // Twelve risers (+0.50 to +1.60) and two fallers (-5.00 and -4.00): the rises-first order would keep
    // the first eleven rises and fold both fallers away.
    const LETTERS14 = "ABCDEFGHIJKLMN".split("");
    const moved: OwnershipActivityPage = {
      ...PAGE,
      rows: LETTERS14.map((letter, index) =>
        row({
          industry: `Sector ${letter}`,
          weekStart: "2026-11-02",
          became: 1,
          netPp: index === 12 ? -5 : index === 13 ? -4 : 0.5 + index * 0.1,
        }),
      ),
    };
    const { container } = render(
      <MovementHeatmapView page={moved} state={DESK_DEFAULT_WINDOW_STATE} basePath="/ownership" params={new URLSearchParams()} compact sort="changed" />,
    );
    const labels = Array.from(container.querySelectorAll("ol > li")).map((item) => item.textContent);
    expect(labels).toContain(`${DOWN}Sector M`);
    expect(labels).toContain(`${DOWN}Sector N`);
    // The three smallest risers fold into the last row; the kept rows run by magnitude, the largest first.
    expect(labels).not.toContain(`${UP}Sector A`);
    expect(labels).not.toContain(`${UP}Sector C`);
    expect(labels[0]).toBe(`${DOWN}Sector M`);
    expect(labels[1]).toBe(`${DOWN}Sector N`);
    expect(labels[labels.length - 1]).toBe(`${UP}Other sectors`);
  });

  it("names the changed sort on the Activity page's control row, drawn checked and inside its one toolbar row", () => {
    mockSearchParams = new URLSearchParams("sort=changed");
    const { container } = render(<MovementHeatmap initial={MOVERS_PAGE} basePath="/ownership/activity" variant="full" />);
    expect(container.querySelectorAll("[data-toolbar]")).toHaveLength(1);
    const toolbar = container.querySelector("[data-toolbar]") as HTMLElement;
    expect(within(toolbar).getByRole("combobox", { name: "Sort" })).toHaveValue("changed");
    expect(within(toolbar).getByRole("combobox", { name: "Sort" })).toBeEnabled();
    expect(within(toolbar).getByRole("combobox", { name: "Holder type" })).toBeInTheDocument();
  });

  it("writes the sort into the link in place when the Activity page's control changes, and the default leaves it out", () => {
    window.history.replaceState(null, "", "/ownership/activity?window=28");
    mockSearchParams = new URLSearchParams("window=28");
    const { rerender } = render(<MovementHeatmap initial={MOVERS_PAGE} basePath="/ownership/activity" variant="full" />);
    fireEvent.change(screen.getByRole("combobox", { name: "Sort" }), { target: { value: "changed" } });
    expect(new URLSearchParams(window.location.search).get("sort")).toBe("changed");
    expect(new URLSearchParams(window.location.search).get("window")).toBe("28");
    // The router would hand the island the link it now has; the mock stands in for it.
    mockSearchParams = new URLSearchParams(window.location.search);
    rerender(<MovementHeatmap initial={MOVERS_PAGE} basePath="/ownership/activity" variant="full" />);
    fireEvent.change(screen.getByRole("combobox", { name: "Sort" }), { target: { value: "largest" } });
    expect(new URLSearchParams(window.location.search).get("sort")).toBeNull();
    window.history.replaceState(null, "", "/");
  });

  it("draws the Overview's compact pane by change when the link names no sort, and by notices when it names largest", () => {
    mockSearchParams = new URLSearchParams("");
    const { container, unmount } = render(<MovementHeatmap initial={MOVERS_PAGE} basePath="/ownership" variant="compact" sort="changed" />);
    expect(titled(container, "Mining, +3.00 pp over the window").length).toBeGreaterThan(0);
    unmount();
    mockSearchParams = new URLSearchParams("sort=largest");
    const largest = render(<MovementHeatmap initial={MOVERS_PAGE} basePath="/ownership" variant="compact" sort="changed" />);
    expect(titled(largest.container, "Mining").length).toBeGreaterThan(0);
    expect(titled(largest.container, "Mining, +3.00 pp over the window")).toHaveLength(0);
  });
});
