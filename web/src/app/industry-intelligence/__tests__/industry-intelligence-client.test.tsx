import "@testing-library/jest-dom";
import { fireEvent, render, screen } from "@testing-library/react";
import { IndustryIntelligenceClient } from "../industry-intelligence-client";
import type { IndustryIntelligenceStory } from "~/@/lib/industry-intelligence";

function story(slug: string, name: string, code: string): IndustryIntelligenceStory {
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
    tradeExposure: {
      label: "Trade Exposure",
      status: "source-ready",
      value: null,
      source: { name: "ABS, DFAT, UN Comtrade", asAt: null, cadence: "Planned import" },
    },
    publicMoney: {
      label: "Public Money",
      status: "source-ready",
      value: null,
      source: { name: "AusTender, GrantConnect", asAt: null, cadence: "Planned import" },
    },
    taxEnvironment: {
      label: "Tax Environment",
      status: "source-ready",
      value: null,
      source: { name: "ATO, NGER, NPI", asAt: null, cadence: "Planned import" },
    },
    policyFootprint: {
      label: "Policy Footprint",
      status: "source-ready",
      value: null,
      source: { name: "AEC, AGD, FITS, APH", asAt: null, cadence: "Planned import" },
    },
    entitlement: {
      free: true,
      premiumRequiredForEvidencePack: true,
      apiRequiredForBulkFeeds: true,
    },
    alerts: {
      previewEnabled: true,
      premiumCadences: ["Daily", "Weekly"],
    },
  };
}

describe("IndustryIntelligenceClient", () => {
  it("keeps users moving when industry data is unavailable", () => {
    render(<IndustryIntelligenceClient stories={[]} />);

    expect(screen.getByRole("heading", { name: "Industry Intelligence" })).toBeInTheDocument();
    expect(screen.getByText(/The next ASIC-backed industry sync will populate this page/i)).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "View top shorts" })).toHaveAttribute("href", "/top");
    expect(screen.getByRole("link", { name: "Browse industries" })).toHaveAttribute("href", "/industry");
    expect(screen.getByRole("link", { name: "Find a stock" })).toHaveAttribute("href", "/stocks");
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

    expect(screen.getByRole("link", { name: /MIN MIN Limited/ })).toHaveAttribute("href", "/shorts/MIN");

    fireEvent.click(screen.getByRole("button", { name: /Health Care/ }));

    expect(screen.getByRole("link", { name: /CSL CSL Limited/ })).toHaveAttribute("href", "/shorts/CSL");
    expect(screen.queryByRole("link", { name: /MIN MIN Limited/ })).not.toBeInTheDocument();
  });
});
