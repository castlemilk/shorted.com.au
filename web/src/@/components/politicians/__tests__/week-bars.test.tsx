/**
 * The weekly strip is a chart beside named people, so what it must NOT do is
 * most of what this file checks:
 *
 *   - it must carry its numbers in text, not only in ink: `role="img"` with a
 *     full aria-label plus an sr-only table, the house rule for every politician
 *     chart (there is no chart library on these surfaces)
 *   - a week with no events must render NO ink. A hairline placeholder makes an
 *     empty week look like a week with one event, which is a count we would be
 *     publishing without having it
 *   - both series are AMBER. A green/red pair would give a register event a
 *     polarity it does not have — a removal is not a transaction and neither
 *     count is the good one
 */

import { render, screen } from "@testing-library/react";

import { WeekBars } from "../explorer/week-bars";

const WEEKS = [
  { weekStart: "2026-06-29", addedCount: 4, removedCount: 1 },
  { weekStart: "2026-07-06", addedCount: 0, removedCount: 0 },
  { weekStart: "2026-07-13", addedCount: 2, removedCount: 3 },
];

describe("week bars", () => {
  it("describes itself in text, counts and all", () => {
    render(<WeekBars weeks={WEEKS} windowLabel="the last 90 days" />);

    const figure = screen.getByRole("img");
    expect(figure).toHaveAttribute(
      "aria-label",
      expect.stringContaining("6 entries added and 4 entries removed"),
    );
    expect(figure.getAttribute("aria-label")).toContain("the last 90 days");
    // The discipline every measure on this surface follows.
    expect(figure.getAttribute("aria-label")).toContain("Dated events only");
  });

  it("carries the caller's scope in both text labels", () => {
    // The buckets are narrowed by the feed's filters, so a screen-reader user
    // told only "over the last 90 days" hears the parliament's counts where a
    // sighted reader is told one member's — the misattribution the visible
    // caption exists to prevent.
    render(
      <WeekBars
        weeks={WEEKS}
        windowLabel="the last 90 days"
        scopeNote="under the filters set above"
      />,
    );

    expect(screen.getByRole("img").getAttribute("aria-label")).toContain(
      "the last 90 days, under the filters set above",
    );
    expect(
      screen.getByRole("table", {
        name: /the last 90 days, under the filters set above/,
      }),
    ).toBeInTheDocument();
  });

  it("carries an sr-only table with every week's two counts", () => {
    render(<WeekBars weeks={WEEKS} windowLabel="the last 90 days" />);

    const table = screen.getByRole("table", { name: /^Register events by week over / });
    expect(table).toHaveClass("sr-only");
    for (const week of WEEKS) {
      expect(screen.getByRole("rowheader", { name: week.weekStart })).toBeInTheDocument();
    }
    expect(screen.getByRole("columnheader", { name: "Entries added" })).toBeInTheDocument();
    expect(screen.getByRole("columnheader", { name: "Entries removed" })).toBeInTheDocument();
  });

  it("draws no ink for a week with no events", () => {
    const { container } = render(<WeekBars weeks={WEEKS} windowLabel="the last 90 days" />);

    const emptyWeek = container.querySelector('[data-week="2026-07-06"]');
    expect(emptyWeek).not.toBeNull();
    expect(emptyWeek?.querySelectorAll("rect")).toHaveLength(0);
    // …while a week that has events draws both of its bars.
    expect(
      container.querySelector('[data-week="2026-07-13"]')?.querySelectorAll("rect"),
    ).toHaveLength(2);
  });

  it("uses two steps of the one amber ramp, never a green/red pair", () => {
    const { container } = render(<WeekBars weeks={WEEKS} windowLabel="the last 90 days" />);

    const fills = [...container.querySelectorAll("rect")].map((rect) =>
      rect.getAttribute("fill"),
    );
    expect(fills.length).toBeGreaterThan(0);
    for (const fill of fills) {
      // The house ramp: #fdbb80 and #ce4603 are AMBER_STEPS[1] and [4].
      expect(["#fdbb80", "#ce4603"]).toContain(fill);
    }
  });

  it("says an empty window is empty rather than rendering nothing", () => {
    render(<WeekBars weeks={[]} windowLabel="the last 30 days" />);

    expect(screen.getByRole("img").getAttribute("aria-label")).toContain("no dated events");
    expect(screen.getByRole("rowheader", { name: /no dated events in this window/i })).toBeInTheDocument();
  });

  it("ignores a negative or non-finite count rather than plotting it", () => {
    const { container } = render(
      <WeekBars
        weeks={[{ weekStart: "2026-06-29", addedCount: -5, removedCount: Number.NaN }]}
        windowLabel="the last 30 days"
      />,
    );

    expect(container.querySelectorAll("rect")).toHaveLength(0);
    expect(screen.getByRole("img").getAttribute("aria-label")).toContain(
      "0 entries added and 0 entries removed",
    );
  });
});
