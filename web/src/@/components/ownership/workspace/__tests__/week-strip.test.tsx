/// <reference types="jest" />

import { render, screen, within } from "@testing-library/react";
import { countScale, lensFill } from "~/@/components/ownership/desk/desk-scales";
import type { WeekBar } from "../inspector-types";
import { countPhrase, weekStrip, weekTitle } from "../week-strip";
import { WeekStrip } from "../week-strip-view";

/** Twenty-six weeks from the Monday 4 May 2026, oldest first, with the counts given (the rest are 0). */
function weeksWith(counts: Record<number, number>): WeekBar[] {
  return weekStrip([], "2026-10-31", (start, end) => `/ownership/notices?since=${start}&until=${end}`).map(
    (week, index) => ({ ...week, count: counts[index] ?? 0 }),
  );
}

function bars(container: HTMLElement) {
  return Array.from(container.querySelectorAll("svg a"));
}

function rects(container: HTMLElement) {
  return Array.from(container.querySelectorAll("svg rect"));
}

describe("WeekStrip (backlog C6)", () => {
  it("draws 26 bars, each a link to its week's feed, with the week's title on hover", () => {
    const weeks = weeksWith({ 25: 3, 24: 1 });
    const { container } = render(<WeekStrip weeks={weeks} label="Notices by week" />);
    const links = bars(container);
    expect(links).toHaveLength(26);
    expect(links[25]?.getAttribute("href")).toBe("/ownership/notices?since=2026-10-26&until=2026-11-01");
    expect(links[25]?.querySelector("title")?.textContent).toBe("Week of 26 Oct: 3 notices");
    expect(links[24]?.querySelector("title")?.textContent).toBe("Week of 19 Oct: 1 notice");
    expect(links[0]?.querySelector("title")?.textContent).toBe("Week of 4 May: no notices");
  });

  it("takes the bars out of the tab order, because the list beside them is the keyboard's", () => {
    const { container } = render(<WeekStrip weeks={weeksWith({})} label="Notices by week" />);
    for (const link of bars(container)) expect(link.getAttribute("tabindex")).toBe("-1");
  });

  it("lists every week beside the strip, with its count and its link, for a screen reader", () => {
    const { container } = render(<WeekStrip weeks={weeksWith({ 25: 3 })} label="Notices by week" />);
    const list = container.querySelector("ol");
    expect(list).not.toBeNull();
    const items = within(list as HTMLElement).getAllByRole("link");
    expect(items).toHaveLength(26);
    expect(items[25]).toHaveTextContent("Week of 26 Oct: 3 notices");
    expect(items[25]).toHaveAttribute("href", "/ownership/notices?since=2026-10-26&until=2026-11-01");
    expect(items[0]).toHaveTextContent("Week of 4 May: no notices");
  });

  it("hides each week's link until it takes the focus, so the list adds no height to the rail", () => {
    const { container } = render(<WeekStrip weeks={weeksWith({ 25: 3 })} label="Notices by week" />);
    const list = container.querySelector("ol");
    expect(list?.className).not.toContain("sr-only");
    const items = within(list as HTMLElement).getAllByRole("link");
    for (const item of items) {
      expect(item.className).toContain("sr-only");
      expect(item.className).toContain("focus:not-sr-only");
      expect(item.className).toContain("font-mono");
    }
  });

  it("draws a bar's height as its count over the largest week, the largest filling the plot", () => {
    const { container } = render(<WeekStrip weeks={weeksWith({ 25: 4, 24: 2 })} label="Notices by week" />);
    const drawn = rects(container);
    expect(drawn[25]?.getAttribute("height")).toBe("40");
    expect(drawn[24]?.getAttribute("height")).toBe("20");
    expect(drawn[25]?.getAttribute("y")).toBe("0");
    expect(drawn[24]?.getAttribute("y")).toBe("20");
  });

  it("lays the bars 8 wide with a 2 unit gap in a 260 by 40 box", () => {
    const { container } = render(<WeekStrip weeks={weeksWith({ 0: 1 })} label="Notices by week" />);
    const drawn = rects(container);
    expect(drawn[0]?.getAttribute("x")).toBe("0");
    expect(drawn[1]?.getAttribute("x")).toBe("10");
    expect(drawn[25]?.getAttribute("x")).toBe("250");
    expect(drawn[25]?.getAttribute("width")).toBe("8");
    expect(container.querySelector("svg")?.getAttribute("viewBox")).toBe("0 0 260 40");
  });

  it("draws a quiet week as an empty slot: a 1 unit hairline on the paper, not a missing bar", () => {
    const weeks = weeksWith({ 25: 2 });
    const { container } = render(<WeekStrip weeks={weeks} label="Notices by week" />);
    const quiet = rects(container)[0];
    expect(quiet?.getAttribute("height")).toBe("1");
    expect(quiet?.getAttribute("stroke")).toBe("currentColor");
    expect(quiet?.getAttribute("fill")).toBe(lensFill(0, countScale(2)));
  });

  it("fills each bar from the heatmap's count bins, scaled to the strip's largest week", () => {
    const weeks = weeksWith({ 25: 5, 24: 1, 23: 3 });
    const scale = countScale(5);
    const { container } = render(<WeekStrip weeks={weeks} label="Notices by week" />);
    const drawn = rects(container);
    expect(drawn[25]?.getAttribute("fill")).toBe(lensFill(5, scale));
    expect(drawn[25]?.getAttribute("fill")).toBe("hsl(var(--desk-bin-4))");
    expect(drawn[24]?.getAttribute("fill")).toBe(lensFill(1, scale));
    expect(drawn[23]?.getAttribute("fill")).toBe(lensFill(3, scale));
    expect(drawn[23]?.getAttribute("fill")).not.toBe(drawn[25]?.getAttribute("fill"));
  });

  it("labels the first and the last week under the strip, in short date form", () => {
    const { container } = render(<WeekStrip weeks={weeksWith({})} label="Notices by week" />);
    const labels = Array.from(container.querySelectorAll("div.flex span")).map((span) => span.textContent);
    expect(labels).toEqual(["4 May", "26 Oct"]);
  });

  it("is a named group, so the section has a name for a screen reader", () => {
    render(<WeekStrip weeks={weeksWith({})} label="Notices by week" />);
    expect(screen.getByRole("group", { name: "Notices by week" })).toBeInTheDocument();
  });

  it("draws nothing for a strip of no weeks", () => {
    const { container } = render(<WeekStrip weeks={[]} label="Notices by week" />);
    expect(container).toBeEmptyDOMElement();
  });

  it("draws a strip of only quiet weeks with every bar a slot", () => {
    const { container } = render(<WeekStrip weeks={weeksWith({})} label="Notices by week" />);
    expect(rects(container)).toHaveLength(26);
    expect(rects(container).every((rect) => rect.getAttribute("height") === "1")).toBe(true);
  });

  it("writes no em dash in its copy", () => {
    const { container } = render(<WeekStrip weeks={weeksWith({ 25: 1 })} label="Notices by week" />);
    expect(container.textContent).not.toContain(String.fromCharCode(0x2014));
  });
});

describe("the week strip's wording", () => {
  it("counts in words, with the singular and the real zero", () => {
    expect(countPhrase(0)).toBe("no notices");
    expect(countPhrase(1)).toBe("1 notice");
    expect(countPhrase(12)).toBe("12 notices");
  });

  it("titles a week with its heading and its count", () => {
    expect(weekTitle({ weekStart: "2026-10-26", count: 3, href: "" })).toBe("Week of 26 Oct: 3 notices");
  });
});
