import { render, screen } from "@testing-library/react";
import type { StatePriceDropSummary } from "~/gen/shorts/v1alpha1/housing_pb";
import { NationalPulse } from "./national-pulse";

jest.mock("@/components/housing/housing-icon", () => ({
  HousingIcon: () => null,
}));

const national = (over: Partial<StatePriceDropSummary>) =>
  ({
    stateCode: "AU",
    droppedCount: 1331,
    avgDropPct: 0.06,
    medianDropPct: 0.05,
    maxDropPct: 0.39,
    droppedValue: 90_000_000,
    totalActiveListings: 13_433,
    droppedShare: 0.099,
    suburbsTracked: 184,
    suburbsSwept14d: 496,
    catalogSuburbs: 500,
    ...over,
  }) as StatePriceDropSummary;

function shareTile(): HTMLElement {
  return screen.getByText("Share of listings cut").parentElement!;
}

// States below 60% of their catalog swept are not ranked, because their share
// measures crawl reach. The national share is held to the same rule: at 184 of
// 500 swept (prod, 2026-09-23) it was mostly a VIC number.
test("withholds the national share when the crawl reached too few suburbs", () => {
  render(<NationalPulse national={national({ suburbsSwept14d: 184 })} />);
  expect(shareTile()).toHaveTextContent("—");
  expect(shareTile()).toHaveTextContent(
    "Withheld — only 184 of 500 tracked suburbs swept in 14 days",
  );
  expect(shareTile()).not.toHaveTextContent("9.9%");
  // The counts are still true of what was seen.
  expect(screen.getByText("1,331")).toBeInTheDocument();
});

test("shows the national share when coverage clears the threshold", () => {
  render(<NationalPulse national={national({})} />);
  expect(shareTile()).toHaveTextContent("9.9%");
  expect(shareTile()).toHaveTextContent(
    "496 of 500 tracked suburbs swept in 14 days",
  );
});

test("keeps the share when coverage is unknown (a pre-000124 response)", () => {
  render(
    <NationalPulse
      national={national({ suburbsSwept14d: 0, catalogSuburbs: 0 })}
    />,
  );
  expect(shareTile()).toHaveTextContent("9.9%");
});
