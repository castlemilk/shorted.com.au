import "@testing-library/jest-dom";
import { fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { IndustryIntelligenceClient } from "../industry-intelligence-client";
import {
  buildEvidenceChannels,
  type IndustryIntelligenceStory,
} from "~/@/lib/industry-intelligence";

// The charts module wraps everything in next/dynamic(ssr:false); resolve the
// real components synchronously so tests can assert dashboard content.
jest.mock("~/@/components/industry/industry-charts", () => {
  const charts = jest.requireActual(
    "~/@/components/industry/charts/industry-crowding-chart",
  ) as { IndustryCrowdingChart: unknown };
  const dashboards = jest.requireActual(
    "~/@/components/industry/industry-channel-dashboards",
  ) as { ChannelDetail: unknown; EvidenceExportButton: unknown };
  return {
    IndustryCrowdingChart: charts.IndustryCrowdingChart,
    ChannelDetail: dashboards.ChannelDetail,
    EvidenceExportButton: dashboards.EvidenceExportButton,
  };
});

jest.mock(
  "~/@/components/industry/industry-economy-context-loader",
  () => ({
    IndustryEconomyContext: ({ industryName }: { industryName: string }) => (
      <div data-testid="industry-economy-context">{industryName} economy context</div>
    ),
  }),
  { virtual: true },
);

jest.mock("~/@/components/housing/when-visible", () => ({
  WhenVisible: ({ children }: { children: React.ReactNode }) => children,
}));

jest.mock("~/@/hooks/use-subscription", () => ({
  useSubscription: () => ({
    isPremium: false,
    isLoading: false,
    tier: "free",
    subscription: null,
  }),
}));

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
    channels: [],
    crowding: null,
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

  it("switches industries from the sidenav", () => {
    render(
      <IndustryIntelligenceClient
        stories={[
          story("materials", "Materials", "MIN"),
          story("health-care", "Health Care", "CSL"),
        ]}
      />,
    );

    const sidenav = within(screen.getByTestId("industry-sidenav"));
    expect(sidenav.getByRole("button", { name: /Materials/ })).toHaveAttribute(
      "aria-pressed",
      "true",
    );

    expect(
      within(screen.getByTestId("industry-top-stocks-panel")).getByRole(
        "link",
        { name: /MIN.*MIN Limited/ },
      ),
    ).toHaveAttribute("href", "/shorts/MIN");

    fireEvent.click(sidenav.getByRole("button", { name: /Health Care/ }));

    expect(
      sidenav.getByRole("button", { name: /Health Care/ }),
    ).toHaveAttribute("aria-pressed", "true");
    const panel = within(screen.getByTestId("industry-top-stocks-panel"));
    expect(
      panel.getByRole("link", { name: /CSL.*CSL Limited/ }),
    ).toHaveAttribute("href", "/shorts/CSL");
    expect(
      panel.queryByRole("link", { name: /MIN.*MIN Limited/ }),
    ).not.toBeInTheDocument();
  });

  it("keeps the economy context synced to the selected industry", () => {
    render(
      <IndustryIntelligenceClient
        stories={[
          story("materials", "Materials", "MIN"),
          story("health-care", "Health Care", "CSL"),
        ]}
      />,
    );

    expect(screen.getByTestId("industry-economy-context")).toHaveTextContent(
      "Materials economy context",
    );

    fireEvent.click(
      within(screen.getByTestId("industry-sidenav")).getByRole("button", {
        name: /Health Care/,
      }),
    );

    expect(screen.getByTestId("industry-economy-context")).toHaveTextContent(
      "Health Care economy context",
    );
  });

  it("renders the overview workspace without placeholder channels", () => {
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
      screen.getByRole("heading", { name: "Top Shorts In This Industry" }),
    ).toBeInTheDocument();

    // Tabs: only Overview and Sources without imported evidence.
    const tabs = screen.getAllByRole("tab");
    expect(tabs.map((tab) => tab.textContent)).toEqual([
      "Overview",
      "Sources",
    ]);
    expect(
      screen.queryByRole("tab", { name: "Policy Footprint" }),
    ).not.toBeInTheDocument();
    expect(screen.queryByText(/source-ready/i)).not.toBeInTheDocument();
    // No export CTA when there is nothing to export.
    expect(screen.queryByTestId("evidence-export-upgrade")).toBeNull();
  });

  it("renders an evidence channel tab with cited dashboard content", async () => {
    const user = userEvent.setup();
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
        metricKey: "total_income",
        metricLabel: "Total income",
        metricValue: 1_250_000_000,
        unit: "AUD",
        asOf: "2024-06-30",
        sourceUrl: "https://data.gov.au/data/dataset/corporate-transparency",
      },
    ];
    const timeBuckets = [
      {
        signalKind: "tax_environment",
        sourceKey: "ato-corporate-tax-transparency",
        metricKey: "tax_payable",
        metricLabel: "Tax payable",
        unit: "AUD",
        bucketLabel: "2022-23",
        bucketStart: "2022-07-01",
        totalValue: 800_000_000,
        recordCount: 9,
        entityCount: 9,
        zeroValueCount: 0,
      },
      {
        signalKind: "tax_environment",
        sourceKey: "ato-corporate-tax-transparency",
        metricKey: "tax_payable",
        metricLabel: "Tax payable",
        unit: "AUD",
        bucketLabel: "2023-24",
        bucketStart: "2023-07-01",
        totalValue: 1_200_000_000,
        recordCount: 12,
        entityCount: 10,
        zeroValueCount: 0,
      },
      {
        signalKind: "tax_environment",
        sourceKey: "ato-corporate-tax-transparency",
        metricKey: "total_income",
        metricLabel: "Total income",
        unit: "AUD",
        bucketLabel: "2023-24",
        bucketStart: "2023-07-01",
        totalValue: 42_000_000_000,
        recordCount: 14,
        entityCount: 14,
        zeroValueCount: 0,
      },
    ];
    const entityTotals = [
      {
        signalKind: "tax_environment",
        sourceKey: "ato-corporate-tax-transparency",
        metricKey: "tax_payable",
        stockCode: "MIN",
        entityLabel: "Mineral Resources",
        unit: "AUD",
        totalValue: 900_000_000,
        recordCount: 8,
        latestAsOf: "2024-06-30",
      },
    ];
    materials.channels = buildEvidenceChannels({
      sources: materials.evidenceSources,
      records: materials.evidenceRecords,
      timeBuckets,
      entityTotals,
    });

    render(<IndustryIntelligenceClient stories={[materials]} />);

    // Export CTA is in the command bar; non-premium users get the upgrade path.
    expect(screen.getByTestId("evidence-export-upgrade")).toHaveAttribute(
      "href",
      "/pricing",
    );

    await user.click(screen.getByRole("tab", { name: "Tax Environment" }));

    const channel = within(screen.getByTestId("channel-tax_environment"));
    expect(
      channel.getByRole("heading", { name: "Tax Environment" }),
    ).toBeInTheDocument();
    expect(channel.getByText(/as at 2024-06-30/)).toBeInTheDocument();
    expect(
      channel.getByText(/ATO Corporate Tax Transparency — CC-BY-3.0-AU/),
    ).toBeInTheDocument();
    // Tax caveat must accompany the figures.
    expect(channel.getByText(/lawful provisions/)).toBeInTheDocument();
    // "No tax payable" derivation: 14 income entities - 10 tax-payable entities.
    expect(channel.getByText("No tax payable")).toBeInTheDocument();
    expect(channel.getByText("4")).toBeInTheDocument();
    // Top entity links back to the stock page.
    expect(channel.getByRole("link", { name: /MIN/ })).toHaveAttribute(
      "href",
      "/shorts/MIN",
    );
    // Editorial: every channel carries a report-an-error path.
    expect(
      channel.getByRole("link", { name: /Report an error/i }),
    ).toBeInTheDocument();

    // Methodology lives behind the Sources tab.
    await user.click(screen.getByRole("tab", { name: "Sources" }));
    expect(
      screen.getByRole("heading", { name: "Where these figures come from" }),
    ).toBeInTheDocument();
    expect(screen.queryByText(/planned/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/source-ready/i)).not.toBeInTheDocument();
  });
});
