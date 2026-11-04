/// <reference types="jest" />

import { render, screen } from "@testing-library/react";
import { SERIES_HEIGHT, SERIES_WIDTH, WeightSeries, seriesGeometry } from "../weight-series";
import { SectorConcentration, sortedSectors } from "../sector-concentration";

describe("the weight series (spec 14.3)", () => {
  it("draws a dot for every file date that states a weight, and leaves a gap for one that does not", () => {
    const geometry = seriesGeometry([
      { asAt: "2026-06-30", weightPct: 8 },
      { asAt: "2026-09-30", weightPct: null },
      { asAt: "2026-10-31", weightPct: 9 },
    ]);
    expect(geometry.dots.map((dot) => dot.asAt)).toEqual(["2026-06-30", "2026-10-31"]);
    // The unstated file between the two stated ones breaks the line: two runs of one point each.
    expect(geometry.runs).toHaveLength(2);
    expect(geometry.runs.map((run) => run.split(" ").length)).toEqual([1, 1]);
  });

  it("draws a separate segment on each side of a file that states no weight, never a line across it", () => {
    const geometry = seriesGeometry([
      { asAt: "a", weightPct: 1 },
      { asAt: "b", weightPct: 2 },
      { asAt: "c", weightPct: null },
      { asAt: "d", weightPct: 3 },
    ]);
    expect(geometry.runs).toHaveLength(2);
    expect(geometry.runs[0]!.split(" ")).toHaveLength(2);
    expect(geometry.runs[1]!.split(" ")).toHaveLength(1);
  });

  it("places the lowest weight at the foot and the highest at the top, and a flat series mid-height", () => {
    const rising = seriesGeometry([
      { asAt: "a", weightPct: 1 },
      { asAt: "b", weightPct: 3 },
    ]);
    expect(rising.dots[0]!.y).toBeGreaterThan(rising.dots[1]!.y);
    const flat = seriesGeometry([
      { asAt: "a", weightPct: 2 },
      { asAt: "b", weightPct: 2 },
    ]);
    expect(flat.dots[0]!.y).toBe(SERIES_HEIGHT / 2);
  });

  it("is empty for no stated weight, never a line through zero", () => {
    expect(seriesGeometry([{ asAt: "a", weightPct: null }])).toEqual({ runs: [], dots: [] });
  });

  it("names the series for a reader who cannot see it, and prints its first and last figures", () => {
    render(
      <WeightSeries
        label="BHP weight across its file dates"
        points={[
          { asAt: "2026-09-30", weightPct: 8.1 },
          { asAt: "2026-10-31", weightPct: 8.4 },
        ]}
      />,
    );
    expect(screen.getByRole("img", { name: "BHP weight across its file dates" })).toHaveAttribute(
      "viewBox",
      `0 0 ${SERIES_WIDTH} ${SERIES_HEIGHT}`,
    );
    expect(screen.getByText("2026-09-30 8.10%")).toBeInTheDocument();
  });
});

describe("the sector concentration (spec 14.3)", () => {
  it("orders the sectors largest first, with an unstated one last", () => {
    const sorted = sortedSectors([
      { industry: "Utilities", weightPct: null },
      { industry: "Banks", weightPct: 30 },
      { industry: "Materials", weightPct: 12 },
    ]);
    expect(sorted.map((sector) => sector.industry)).toEqual(["Banks", "Materials", "Utilities"]);
  });

  it("prints each sector's weight, n/a where none is stated", () => {
    render(
      <SectorConcentration
        sectors={[
          { industry: "Banks", weightPct: 30 },
          { industry: "Utilities", weightPct: null },
        ]}
      />,
    );
    expect(screen.getByText("30.0%")).toBeInTheDocument();
    expect(screen.getByText("n/a")).toBeInTheDocument();
  });
});
