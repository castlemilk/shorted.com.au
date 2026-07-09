import "@testing-library/jest-dom";
import { fireEvent, render, screen, within } from "@testing-library/react";
import { IndustryIntelligenceClient } from "../industry-intelligence-client";
import type { IndustryIntelligenceStory } from "~/@/lib/industry-intelligence";

function story(
  slug: string,
  name: string,
  code: string,
): IndustryIntelligenceStory {
  return {
    industry: {
      name,
      slug,
      stockCount: 1,
      avgShortPercent: 8.5,
      totalShortPercent: 8.5,
      topStock: { code, name: code, shortPercent: 8.5 },
    },
    topShortedStocks: [
      {
        rank: 1,
        code,
        name: `${code} Limited`,
        detail: `${name} company`,
        logoUrl: null,
        shortPercent: 8.5,
        change: 0.4,
        status: "elevated",
        href: `/shorts/${code}`,
      },
    ],
    shortSignals: {
      averageShortPercent: 8.5,
      highlyShortedCount: 0,
      risingCount: 1,
      source: { name: "ASIC", asAt: "2026-07-08", cadence: "Daily, T+4" },
    },
    alerts: {
      previewEnabled: true,
      cadences: ["Daily", "Weekly"],
    },
    evidenceSources: [],
    evidenceRecords: [],
  };
}

describe("IndustryIntelligenceClient", () => {
  it("keeps users moving when industry data is unavailable", () => {
    render(<IndustryIntelligenceClient stories={[]} />);

    expect(
      screen.getByRole("heading", { name: "Industry Intelligence" }),
    ).toBeInTheDocument();
    expect(screen.getByText(/Industry data is syncing/i)).toBeInTheDocument();
    expect(
      screen.getByRole("link", { name: "View top shorts" }),
    ).toHaveAttribute("href", "/top");
    expect(
      screen.getByRole("link", { name: "Browse industries" }),
    ).toHaveAttribute("href", "/industry");
    expect(screen.getByRole("link", { name: "Find a stock" })).toHaveAttribute(
      "href",
      "/stocks",
    );
  });

  it("updates the top-stocks panel when a different industry is selected", () => {
    render(
      <IndustryIntelligenceClient
        stories={[
          story("materials", "Materials", "MIN"),
          story("health-care", "Health Care", "CSL"),
        ]}
      />,
    );

    expect(
      within(screen.getByTestId("industry-top-stocks-panel")).getByRole(
        "link",
        {
          name: /MIN.*MIN Limited/,
        },
      ),
    ).toHaveAttribute("href", "/shorts/MIN");

    fireEvent.click(screen.getByRole("button", { name: /Health Care/ }));

    const panel = within(screen.getByTestId("industry-top-stocks-panel"));
    expect(
      panel.getByRole("link", { name: /CSL.*CSL Limited/ }),
    ).toHaveAttribute("href", "/shorts/CSL");
    expect(
      panel.queryByRole("link", { name: /MIN.*MIN Limited/ }),
    ).not.toBeInTheDocument();
  });

  it("renders one detailed stock ranking table for the selected industry", () => {
    render(
      <IndustryIntelligenceClient
        stories={[
          story("materials", "Materials", "MIN"),
          story("health-care", "Health Care", "CSL"),
        ]}
      />,
    );

    expect(screen.getAllByTestId("industry-top-stocks-panel")).toHaveLength(1);
    expect(screen.getByTestId("industry-short-status-mix")).toBeInTheDocument();
    expect(
      screen.queryByTestId("industry-crowding-summary"),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByTestId("industry-crowding-chart"),
    ).not.toBeInTheDocument();
    expect(
      screen.getByRole("heading", { name: "Top Shorts In This Industry" }),
    ).toBeInTheDocument();
    expect(screen.getByText("Rank")).toBeInTheDocument();
    expect(screen.getByText("Company")).toBeInTheDocument();
    expect(screen.getByText("Change")).toBeInTheDocument();
    expect(screen.queryByText(/source-ready/i)).not.toBeInTheDocument();
  });

  it("renders imported industry context when records exist", () => {
    const materials = story("materials", "Materials", "MIN");
    materials.evidenceSources = [
      {
        sourceKey: "ato-corporate-tax-transparency",
        displayName: "ATO Corporate Tax Transparency",
        publisher: "Australian Taxation Office",
        sourceUrl: "https://data.gov.au/data/dataset/corporate-transparency",
        licence: "CC-BY-3.0-AU",
      },
    ];
    materials.evidenceRecords = [
      {
        sourceKey: "ato-corporate-tax-transparency",
        signalKind: "tax_environment",
        stockCode: "MIN",
        title: "ATO tax transparency: MIN Limited 2024",
        summary:
          "ATO reported total income for MIN Limited in the 2023-24 income year.",
        metricLabel: "Total income",
        metricValue: 1_250_000_000,
        unit: "AUD",
        asOf: "2024-06-30",
        sourceUrl: "https://data.gov.au/data/dataset/corporate-transparency",
      },
    ];

    render(<IndustryIntelligenceClient stories={[materials]} />);

    expect(
      screen.getByRole("heading", { name: "Materials signals" }),
    ).toBeInTheDocument();
    expect(
      screen.getByText("ATO Corporate Tax Transparency"),
    ).toBeInTheDocument();
    expect(screen.getByText(/\$1\.3B|A\$1\.3B/)).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "MIN" })).toHaveAttribute(
      "href",
      "/shorts/MIN",
    );
    expect(screen.queryByText(/planned/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/source-ready/i)).not.toBeInTheDocument();
  });
});
