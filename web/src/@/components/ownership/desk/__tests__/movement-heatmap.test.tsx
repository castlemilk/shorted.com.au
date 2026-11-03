/// <reference types="jest" />

/**
 * The movement heatmap (spec 13.4): the week arithmetic, the sector sums, the
 * figures a cell states, the brush's window and the sr-only table with its links.
 * A week whose notices state no figure is hatched and reads n/a, never zero.
 */

import { render, screen, within } from "@testing-library/react";
import { scaleLinear } from "@visx/scale";

import type { IndustryWeekRow, OwnershipActivityPage } from "~/app/actions/ownershipDesk";
import { brushCommit, brushWindow, weeksUnderBrush, MovementHeatmap } from "../movement-heatmap";
import {
  HEAT_FULL_CELL,
  HEAT_PHONE_WEEKS,
  MovementHeatmapStatic,
  cellTitle,
  heatFeedHref,
  heatReach,
  heatRows,
  mondayOf,
  selectedWeekRange,
  weekList,
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
    expect(screen.getByRole("group", { name: "Window of change" })).toBeInTheDocument();
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

  it("draws the window the link names, with its chip marked and the brush beside the grid", () => {
    mockSearchParams = new URLSearchParams("window=28");
    render(<MovementHeatmap initial={PAGE} basePath="/ownership" />);
    const group = screen.getByRole("group", { name: "Window of change" });
    expect(within(group).getByRole("link", { name: "28 days" })).toHaveAttribute("aria-current", "true");
    expect(screen.getByText("Drag the handles to set the window")).toBeInTheDocument();
    expect(mockReplace).not.toHaveBeenCalled();
  });

  it("draws the brushed window as no chip, and its table names the dates", () => {
    mockSearchParams = new URLSearchParams("since=2026-10-12&until=2026-10-31");
    render(<MovementHeatmap initial={PAGE} basePath="/ownership" />);
    const group = screen.getByRole("group", { name: "Window of change" });
    for (const chip of within(group).getAllByRole("link")) {
      expect(chip).not.toHaveAttribute("aria-current");
    }
    expect(screen.getByRole("table", { name: "Movement by sector and week" })).toBeInTheDocument();
  });
});
