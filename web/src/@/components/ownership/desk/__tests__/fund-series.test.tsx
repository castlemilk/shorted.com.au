/// <reference types="jest" />

/**
 * One stock's weight in each tracked fund (spec 13.5): the shared layout's rules,
 * and what the drawing and its table carry. A date a fund states no weight for is
 * a gap in its line and an n/a in its table, never a point at zero.
 */

import { render, screen, within } from "@testing-library/react";

import type { FundSeriesRow } from "~/app/actions/ownershipDesk";
import { FundSeries, seriesLayout } from "../fund-series";

const FUNDS: FundSeriesRow[] = [
  {
    institutionSlug: "vanguard",
    institutionName: "Vanguard",
    fundName: "Australian Shares Index",
    sourceKind: "etf",
    points: [
      { asAt: "2026-08-31", weightPct: 4, valueAud: 400 },
      { asAt: "2026-09-30", weightPct: 4.5, valueAud: 450 },
      { asAt: "2026-10-31", weightPct: 5, valueAud: 500 },
    ],
  },
  {
    institutionSlug: "aware",
    institutionName: "Aware Super",
    fundName: "Balanced",
    sourceKind: "super_phd",
    points: [
      { asAt: "2026-08-31", weightPct: 2, valueAud: 200 },
      { asAt: "2026-10-31", weightPct: 2.5, valueAud: 250 },
    ],
  },
];

describe("seriesLayout", () => {
  it("takes the snapshot dates every fund has, oldest first, and one scale for all of them", () => {
    const layout = seriesLayout(FUNDS);
    expect(layout.dates).toEqual(["2026-08-31", "2026-09-30", "2026-10-31"]);
    expect(layout.max).toBe(5);
    expect(layout.panels).toHaveLength(2);
  });

  it("joins a fund's weights into one line, and breaks it at a date with no weight: a move starts each run", () => {
    const layout = seriesLayout(FUNDS);
    const vanguard = layout.panels.find((p) => p.fundName === "Australian Shares Index")!;
    expect(vanguard.path.match(/M/g)).toHaveLength(1);
    expect(vanguard.path.match(/L/g)).toHaveLength(2);

    // The middle date is a file with no weight for this fund: two runs, so two moves, and no point at zero.
    const gap = seriesLayout([
      {
        ...FUNDS[1]!,
        points: [
          { asAt: "2026-08-31", weightPct: 2, valueAud: 200 },
          { asAt: "2026-09-30", weightPct: null, valueAud: null },
          { asAt: "2026-10-31", weightPct: 2.5, valueAud: 250 },
        ],
      },
    ]).panels[0]!;
    expect(gap.points.find((p) => p.asAt === "2026-09-30")!.y).toBeNull();
    expect(gap.path.match(/M/g)).toHaveLength(2);
    expect(gap.path.match(/L/g) ?? []).toHaveLength(0);

    // A file date the fund has no point for at all (a fund that skipped a file) breaks the line the same way.
    // A second fund holds the middle date, so it is on the shared axis and the first fund has none for it.
    const skipped = seriesLayout([
      {
        ...FUNDS[1]!,
        points: [
          { asAt: "2026-08-31", weightPct: 2, valueAud: 200 },
          { asAt: "2026-10-31", weightPct: 2.5, valueAud: 250 },
        ],
      },
      FUNDS[0]!,
    ]).panels[0]!;
    expect(skipped.path.match(/M/g)).toHaveLength(2);
    expect(skipped.path.match(/L/g) ?? []).toHaveLength(0);
  });

  it("places a file's point on the snapshot's column, so every panel shares the axis", () => {
    const layout = seriesLayout(FUNDS);
    const vanguard = layout.panels.find((p) => p.fundName === "Australian Shares Index")!;
    const aware = layout.panels.find((p) => p.fundName === "Balanced")!;
    expect(aware.points.find((p) => p.asAt === "2026-10-31")!.x).toBe(
      vanguard.points.find((p) => p.asAt === "2026-10-31")!.x,
    );
  });
});

describe("FundSeries", () => {
  it("draws one panel per fund with a dot for each file it has a weight in", () => {
    const { container } = render(<FundSeries funds={FUNDS} />);
    const panels = screen.getAllByRole("listitem");
    expect(panels).toHaveLength(2);
    const dots = container.querySelectorAll("circle");
    expect(dots).toHaveLength(5);
    expect(container.querySelectorAll('circle[data-date="2026-09-30"]')).toHaveLength(1);
  });

  it("names each fund with its institution and its file date range", () => {
    render(<FundSeries funds={FUNDS} />);
    expect(screen.getByText("Vanguard")).toBeInTheDocument();
    expect(screen.getByText("Australian Shares Index")).toBeInTheDocument();
    // Both funds hold files from the first date to the last.
    expect(screen.getAllByText("as at 2026-08-31 to 2026-10-31")).toHaveLength(2);
  });

  it("prints the shared scale in its caption and the weights, n/a where a fund states none, in its table", () => {
    render(<FundSeries funds={FUNDS} />);
    expect(screen.getByText(/one scale for all: 0% to 5\.00%/)).toBeInTheDocument();
    const table = screen.getByRole("table", { name: "Weight in each tracked fund, by file date" });
    const balanced = within(table).getByRole("row", { name: /Balanced/ });
    expect(within(balanced).getByText("n/a")).toBeInTheDocument();
    expect(within(balanced).getByText("2.00%")).toBeInTheDocument();
  });
});

describe("FundSeries with no stated weight", () => {
  it("names the file dates without a scale when no fund states a weight, never 0% to n/a", () => {
    const none: FundSeriesRow[] = [
      {
        institutionSlug: "aware",
        institutionName: "Aware Super",
        fundName: "Balanced",
        sourceKind: "super_phd",
        points: [{ asAt: "2026-10-31", weightPct: null, valueAud: null }],
      },
    ];
    const { container } = render(<FundSeries funds={none} />);
    const caption = container.querySelector("figcaption")!;
    expect(caption.textContent).toBe("Weight in each fund. File dates 2026-10-31 to 2026-10-31.");
    expect(caption.textContent).not.toContain("n/a");
  });
});
