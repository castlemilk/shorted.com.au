import "@testing-library/jest-dom";
import { render, screen } from "@testing-library/react";
import { IndustrySignalPanel } from "../industry-signal-panel";
import type { IndustryIntelligenceStory } from "~/@/lib/industry-intelligence";

function makeStory(
  overrides: Partial<IndustryIntelligenceStory> = {},
): IndustryIntelligenceStory {
  return {
    industry: {
      name: "Materials",
      slug: "materials",
      stockCount: 3,
      avgShortPercent: 8.2,
      totalShortPercent: 24.6,
      topStock: {
        code: "MIN",
        name: "MIN",
        shortPercent: 12.4,
      },
    },
    topShortedStocks: [
      {
        rank: 1,
        code: "MIN",
        name: "Mineral Resources",
        detail: "Materials company",
        logoUrl:
          "https://storage.googleapis.com/shorted-company-logos/logos-normalized/MIN.png?v=test",
        shortPercent: 12.4,
        change: 1.3,
        status: "crowded",
        href: "/shorts/MIN",
      },
      {
        rank: 2,
        code: "LTR",
        name: "Liontown Resources",
        detail: "Materials company",
        logoUrl: null,
        shortPercent: 9.1,
        change: 0,
        status: "elevated",
        href: "/shorts/LTR",
      },
    ],
    shortSignals: {
      averageShortPercent: 8.2,
      highlyShortedCount: 1,
      risingCount: 1,
      source: { name: "ASIC", asAt: "2026-07-08", cadence: "Daily, T+4" },
    },
    alerts: {
      previewEnabled: true,
      cadences: ["Daily", "Weekly"],
    },
    evidenceSources: [],
    evidenceRecords: [],
    ...overrides,
  };
}

describe("IndustrySignalPanel", () => {
  it("renders top stocks with stock detail links and canonical CTAs", () => {
    render(<IndustrySignalPanel story={makeStory()} />);

    expect(
      screen.getByRole("heading", { name: "Top Shorts In This Industry" }),
    ).toBeInTheDocument();
    expect(screen.getByTestId("industry-short-status-mix")).toBeInTheDocument();
    expect(
      screen.getByRole("link", { name: /MIN.*Mineral Resources/ }),
    ).toHaveAttribute("href", "/shorts/MIN");
    expect(screen.getAllByText("Crowded").length).toBeGreaterThan(0);
    expect(
      screen.getByRole("link", { name: "View all top shorts" }),
    ).toHaveAttribute("href", "/top");
    expect(screen.getByRole("link", { name: "Find a stock" })).toHaveAttribute(
      "href",
      "/stocks",
    );
    expect(
      screen.getByRole("link", { name: "Open industry view" }),
    ).toHaveAttribute("href", "/industry/materials");
  });

  it("renders an empty state without stock links when the industry has no rows", () => {
    render(<IndustrySignalPanel story={makeStory({ topShortedStocks: [] })} />);

    expect(
      screen.getByText("No ranked stocks are available for this industry yet."),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("link", { name: /MIN.*Mineral Resources/ }),
    ).not.toBeInTheDocument();
  });
});
