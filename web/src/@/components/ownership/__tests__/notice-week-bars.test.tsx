import { render, screen, within } from "@testing-library/react";

import { NoticeWeekBars, type NoticeWeekBar } from "../notice-week-bars";

const WEEKS: NoticeWeekBar[] = [
  { weekStart: "2026-09-28", count: 4 },
  { weekStart: "2026-10-05", count: 0 },
  { weekStart: "2026-10-12", count: 2 },
];

/** Consecutive weeks from a Monday, for the phone cap. */
function manyWeeks(n: number): NoticeWeekBar[] {
  return Array.from({ length: n }, (_, index) => {
    const date = new Date(Date.UTC(2026, 0, 5 + index * 7));
    return { weekStart: date.toISOString().slice(0, 10), count: 1 };
  });
}

/** The two drawings: the phone one (below sm) comes first, the full one second. */
function drawings(container: HTMLElement): [SVGSVGElement, SVGSVGElement] {
  const [phone, full] = Array.from(container.querySelectorAll("svg"));
  if (!phone || !full) throw new Error("expected a phone and a full drawing");
  return [phone, full];
}

describe("NoticeWeekBars", () => {
  it("names the image and the table for the window and its scope, and counts the notices in the caption line", () => {
    const { container } = render(
      <NoticeWeekBars weeks={WEEKS} windowLabel="the last 30 days" scopeNote="under the filters set above" />,
    );
    // weeks.label (section 7): the name is the window and its scope, and the totals are printed beside the bars.
    expect(
      screen.getByRole("img", { name: "Notices by week over the last 30 days, under the filters set above" }),
    ).toBeInTheDocument();
    expect(screen.getByRole("table", { name: "Notices by week over the last 30 days, under the filters set above" })).toBeInTheDocument();
    expect(container.querySelector("figcaption")).toHaveTextContent("6 notices");
  });

  it("draws one bar per week with notices, scaled to the largest week, and none for an empty week", () => {
    const { container } = render(<NoticeWeekBars weeks={WEEKS} windowLabel="the last 30 days" />);
    const [, full] = drawings(container);
    const bars = Array.from(full.querySelectorAll("rect"));
    expect(bars).toHaveLength(2);
    // The plot is 52 units tall (baseline 58, top 6): the largest week fills it, half of it is half.
    expect(bars[0]).toHaveAttribute("x", "3");
    expect(bars[0]).toHaveAttribute("y", "6");
    expect(bars[0]).toHaveAttribute("height", "52");
    expect(bars[0]).toHaveAttribute("width", "8");
    expect(bars[1]).toHaveAttribute("x", "31");
    expect(bars[1]).toHaveAttribute("y", "32");
    expect(bars[1]).toHaveAttribute("height", "26");
    expect(full.querySelector('g[data-week="2026-10-05"] rect')).toBeNull();
  });

  it("draws the newest 26 weeks below sm and every week from sm up", () => {
    const { container } = render(<NoticeWeekBars weeks={manyWeeks(30)} windowLabel="the last 365 days" />);
    const [phone, full] = drawings(container);
    expect(phone.querySelectorAll("g[data-week]")).toHaveLength(26);
    expect(full.querySelectorAll("g[data-week]")).toHaveLength(30);
    // The phone drawing is the newest 26: its first week is the thirty-first week back.
    expect(phone.querySelector("g[data-week]")).toHaveAttribute("data-week", manyWeeks(30)[4]!.weekStart);
  });

  it("keeps the baseline a one-pixel stroke under the stretched drawing, and draws no text in it", () => {
    const { container } = render(<NoticeWeekBars weeks={WEEKS} windowLabel="the last 30 days" />);
    for (const svg of drawings(container)) {
      expect(svg.querySelector("line")).toHaveAttribute("vector-effect", "non-scaling-stroke");
      expect(svg.querySelectorAll("text")).toHaveLength(0);
    }
  });

  it("carries every week in its table, the empty ones included, each date in a time element", () => {
    render(<NoticeWeekBars weeks={WEEKS} windowLabel="the last 30 days" />);
    const table = screen.getByRole("table", { name: "Notices by week over the last 30 days" });
    const rows = within(table).getAllByRole("row");
    expect(rows).toHaveLength(4);
    const empty = within(table).getByRole("rowheader", { name: "2026-10-05" });
    expect(empty.parentElement).toHaveTextContent("0");
    expect(empty.querySelector("time")).toHaveAttribute("datetime", "2026-10-05");
  });

  it("prints the first and last weeks as the API sends them, each in a time element, with their year", () => {
    const { container } = render(<NoticeWeekBars weeks={WEEKS} windowLabel="the last 30 days" />);
    const caption = container.querySelector("figcaption");
    // The range is written "to", in tabular figures, never with a dash.
    expect(caption).toHaveTextContent("2026-09-28 to 2026-10-12");
    expect(caption).not.toHaveTextContent("–");
    expect(caption!.querySelector("time")!.parentElement).toHaveClass("tabular-nums");
    expect(Array.from(caption!.querySelectorAll("time"), (time) => time.getAttribute("datetime"))).toEqual([
      "2026-09-28",
      "2026-10-12",
    ]);
  });

  it("prints one date, not a range, when the window holds one week", () => {
    const { container } = render(
      <NoticeWeekBars weeks={[{ weekStart: "2026-10-12", count: 3 }]} windowLabel="the last 7 days" />,
    );
    const caption = container.querySelector("figcaption")!;
    expect(caption).toHaveTextContent("3 notices");
    expect(Array.from(caption.querySelectorAll("time"), (time) => time.getAttribute("datetime"))).toEqual([
      "2026-10-12",
    ]);
    expect(caption.textContent).not.toMatch(/\bto\b/);
  });

  it("names the window with no weeks and draws no bars, and prints n/a where the count would be", () => {
    const { container } = render(<NoticeWeekBars weeks={[]} windowLabel="the last 30 days" />);
    expect(screen.getByRole("img", { name: "Notices by week over the last 30 days" })).toBeInTheDocument();
    // No weeks is no count: the figcaption says n/a, never 0, and names no range.
    expect(container.querySelector("figcaption")).toHaveTextContent(/^n\/a$/);
    expect(container.querySelector("figcaption time")).toBeNull();
    for (const svg of drawings(container)) {
      expect(svg.querySelectorAll("rect")).toHaveLength(0);
    }
    const row = screen.getByRole("rowheader", { name: "No weeks in this window" }).parentElement;
    // No weeks is no figure: the cell says n/a, never 0.
    expect(row?.querySelector("td")).toHaveTextContent(/^n\/a$/);
  });

  it("is never drawn in red or green", () => {
    const { container } = render(<NoticeWeekBars weeks={WEEKS} windowLabel="the last 30 days" />);
    expect(container.innerHTML).not.toMatch(/\b(?:text|bg|fill|stroke|border)-(?:red|green)|#EF4444|#22C55E/i);
  });
});
