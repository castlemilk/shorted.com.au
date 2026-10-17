import { render, screen } from "@testing-library/react";

// The summary module imports the daily-series action for its own reader; the
// component under test never calls it.
jest.mock("~/app/actions/getDailyShortSeries", () => ({
  getDailyShortSeries: jest.fn(),
  reportDate: jest.fn(),
}));

import {
  ShortInterestSummary,
  type ShortInterestDeltas,
} from "../short-interest-summary";

const deltas: ShortInterestDeltas = {
  change7d: 0.1,
  change30d: 0.42,
  change90d: -0.9,
  peakPct: 3.1,
  peakDate: new Date("2025-03-14T00:00:00Z"),
};

const props = {
  stockCode: "BHP",
  companyName: "BHP Group",
  industry: "Materials",
  shortPct: 1.58,
  shortPositions: 80_000_000,
  asOfClause: "as of 2 Oct 2026",
  deltas,
};

const section = () => screen.getByRole("region", { name: "BHP short interest summary" });

describe("ShortInterestSummary", () => {
  it("is a bordered card with its own bottom margin by default", () => {
    render(<ShortInterestSummary {...props} />);
    expect(section()).toHaveClass("mb-6", "rounded-lg", "border", "bg-card", "px-4", "py-3");
  });

  it("is the same card when asked for the card variant", () => {
    render(<ShortInterestSummary {...props} variant="card" />);
    expect(section()).toHaveClass("mb-6", "rounded-lg", "border", "bg-card", "px-4", "py-3");
  });

  // The Overview's About card is the card; the prose sits inside it, so a border,
  // a background, padding or a margin of its own would nest one card in another
  // and add space the parent already decides.
  it("is the bare variant with no border, background, padding or margin", () => {
    render(<ShortInterestSummary {...props} variant="bare" />);
    const classes = section().className;
    expect(classes).not.toMatch(/\b(border|bg-|rounded|px-|py-|p-|m[btlrxy]?-)/);
    // Still the one labelled region the card is, with its paragraph.
    expect(section().querySelector("p")).toHaveClass("text-sm", "leading-relaxed", "text-muted-foreground");
  });

  it("says the same thing in both variants", () => {
    const card = render(<ShortInterestSummary {...props} />);
    const cardText = card.container.textContent;
    card.unmount();
    const bare = render(<ShortInterestSummary {...props} variant="bare" />);
    expect(bare.container.textContent).toBe(cardText);
    expect(cardText).toContain(
      "BHP Group (ASX:BHP) has 1.58% of its shares on issue reported as short positions as of 2 Oct 2026, or about 80,000,000 shares.",
    );
    expect(cardText).toContain("Over the past 30 days that figure has risen 0.42 percentage points");
  });
});
