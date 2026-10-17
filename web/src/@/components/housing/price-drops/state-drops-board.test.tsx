import { render, screen, within } from "@testing-library/react";

import type { StatePriceDropSummary } from "~/gen/shorts/v1alpha1/housing_pb";
import { StateDropsBoard } from "./state-drops-board";

function row(
  stateCode: string,
  droppedShare: number,
  swept: number,
  catalog: number,
): StatePriceDropSummary {
  return {
    stateCode,
    droppedShare,
    droppedCount: 10,
    medianDropPct: 0.04,
    droppedValue: 1_000_000,
    medianAsking: 900_000,
    medianSold: 0,
    soldCount: 0,
    totalActiveListings: 1000,
    suburbsSwept14d: swept,
    catalogSuburbs: catalog,
  } as StatePriceDropSummary;
}

describe("StateDropsBoard", () => {
  // The API orders by dropped_count; a barely-swept state must not sit among
  // (or above) the ranked ones with a share that only measures crawl reach.
  it("ranks covered states first and annotates the rest with their coverage", () => {
    render(
      <StateDropsBoard
        states={[
          row("WA", 0.3, 3, 67),
          row("NSW", 0.037, 101, 135),
          row("SA", 0.2, 0, 66),
          row("VIC", 0.044, 100, 135),
        ]}
      />,
    );

    const bodyRows = screen.getAllByRole("row").slice(1);
    expect(bodyRows.map((r) => r.getAttribute("data-ranked"))).toEqual([
      "true",
      "true",
      "false",
      "false",
    ]);
    expect(
      within(bodyRows[0]!).getByText("New South Wales"),
    ).toBeInTheDocument();
    expect(
      within(bodyRows[2]!).getByText("Western Australia"),
    ).toBeInTheDocument();
    expect(
      within(bodyRows[2]!).getByText(
        "Not ranked — 3 of 67 suburbs swept in 14 days",
      ),
    ).toBeInTheDocument();
    expect(within(bodyRows[2]!).queryByText("30.0%")).not.toBeInTheDocument();
    expect(screen.getByText("3.7%")).toBeInTheDocument();
  });

  it("ranks every state when coverage is unknown (a pre-000124 response)", () => {
    render(
      <StateDropsBoard
        states={[row("NSW", 0.037, 0, 0), row("WA", 0.012, 0, 0)]}
      />,
    );
    const bodyRows = screen.getAllByRole("row").slice(1);
    expect(bodyRows.map((r) => r.getAttribute("data-ranked"))).toEqual([
      "true",
      "true",
    ]);
  });
});
