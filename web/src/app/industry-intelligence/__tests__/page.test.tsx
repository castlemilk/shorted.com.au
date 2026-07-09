import "@testing-library/jest-dom";
import { render, screen, waitFor, within } from "@testing-library/react";
import Page from "../page";
import {
  getIndustryData,
  getIndustryStocks,
} from "~/app/actions/industry/getIndustryData";
import { getVerifiedCompanyLogoUrls } from "~/app/actions/company-logo-availability";
import { getIndustryIntelligence } from "~/app/actions/getIndustryIntelligence";
import { getTopShortsData } from "~/app/actions/getTopShorts";

jest.mock("~/@/components/industry/industry-charts", () => {
  const charts = jest.requireActual(
    "~/@/components/industry/charts/industry-crowding-chart",
  ) as { IndustryCrowdingChart: unknown };
  const dashboards = jest.requireActual(
    "~/@/components/industry/industry-channel-dashboards",
  ) as { IndustryChannelDashboards: unknown };
  return {
    IndustryCrowdingChart: charts.IndustryCrowdingChart,
    IndustryChannelDashboards: dashboards.IndustryChannelDashboards,
  };
});

jest.mock("~/@/hooks/use-subscription", () => ({
  useSubscription: () => ({
    isPremium: false,
    isLoading: false,
    tier: "free",
    subscription: null,
  }),
}));

jest.mock("~/@/components/layouts/dashboard-layout", () => ({
  DashboardLayout: ({ children }: { children: React.ReactNode }) => (
    <div data-testid="dashboard-layout">{children}</div>
  ),
}));

jest.mock("~/app/actions/industry/getIndustryData", () => ({
  getIndustryData: jest.fn(),
  getIndustryStocks: jest.fn(),
}));

jest.mock("~/app/actions/getTopShorts", () => ({
  getTopShortsData: jest.fn(),
}));

jest.mock("~/app/actions/company-logo-availability", () => ({
  getVerifiedCompanyLogoUrls: jest.fn(),
}));

jest.mock("~/app/actions/getIndustryIntelligence", () => ({
  getIndustryIntelligence: jest.fn(),
}));

const mockedGetIndustryData = getIndustryData as jest.MockedFunction<
  typeof getIndustryData
>;
const mockedGetIndustryStocks = getIndustryStocks as jest.MockedFunction<
  typeof getIndustryStocks
>;
const mockedGetTopShortsData = getTopShortsData as jest.MockedFunction<
  typeof getTopShortsData
>;
const mockedGetVerifiedCompanyLogoUrls =
  getVerifiedCompanyLogoUrls as jest.MockedFunction<
    typeof getVerifiedCompanyLogoUrls
  >;
const mockedGetIndustryIntelligence =
  getIndustryIntelligence as jest.MockedFunction<
    typeof getIndustryIntelligence
  >;

describe("/industry-intelligence page", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockedGetVerifiedCompanyLogoUrls.mockResolvedValue(new Map());
    mockedGetIndustryIntelligence.mockResolvedValue(undefined);
  });

  it("renders the story route with live industry data and stock-surface links", async () => {
    mockedGetIndustryData.mockResolvedValue([
      {
        name: "Materials",
        slug: "materials",
        stockCount: 2,
        avgShortPercent: 10.1,
        totalShortPercent: 20.2,
        topStock: { code: "MIN", name: "MIN", shortPercent: 12.4 },
      },
    ]);
    mockedGetIndustryStocks.mockResolvedValue({
      industry: {
        name: "Materials",
        slug: "materials",
        stockCount: 2,
        avgShortPercent: 10.1,
        totalShortPercent: 20.2,
        topStock: { code: "MIN", name: "MIN", shortPercent: 12.4 },
      },
      stocks: [
        {
          code: "MIN",
          name: "Mineral Resources",
          shortPercent: 12.4,
          change: 1.3,
        },
        {
          code: "LTR",
          name: "Liontown Resources",
          shortPercent: 7.8,
          change: -0.2,
        },
      ],
    });
    mockedGetTopShortsData.mockResolvedValue({
      timeSeries: [
        {
          productCode: "MIN",
          name: "Mineral Resources Ltd",
          latestShortPosition: 12.4,
          points: [],
          industry: "Materials",
        },
        {
          productCode: "LTR",
          name: "Liontown Resources Ltd",
          latestShortPosition: 7.8,
          points: [],
          industry: "Materials",
        },
      ],
      offset: 0,
    } as Awaited<ReturnType<typeof getTopShortsData>>);
    mockedGetIndustryIntelligence.mockResolvedValue({
      industry: "Materials",
      sources: [
        {
          sourceKey: "ato-corporate-tax-transparency",
          displayName: "ATO Corporate Tax Transparency",
          signalKind: "tax_environment",
          publisher: "Australian Taxation Office",
          sourceUrl: "https://data.gov.au/data/dataset/corporate-transparency",
          licence: "CC-BY-3.0-AU",
          cadence: "Annual",
        },
      ],
      records: [
        {
          sourceKey: "ato-corporate-tax-transparency",
          sourceRecordId: "ato-tax:49004028077:2024",
          signalKind: "tax_environment",
          industry: "Materials",
          stockCode: "MIN",
          entityAbn: "49004028077",
          metricKey: "total_income",
          metricLabel: "Total income",
          hasMetricValue: true,
          metricValue: 1_250_000_000,
          unit: "AUD",
          periodStart: "2023-07-01",
          periodEnd: "2024-06-30",
          asOf: "2024-06-30",
          title: "ATO tax transparency: Mineral Resources 2024",
          summary:
            "ATO reported total income for Mineral Resources in the 2023-24 income year.",
          sourceUrl: "https://data.gov.au/data/dataset/corporate-transparency",
          confidence: 1,
        },
      ],
      sourceAttribution: "ATO Corporate Tax Transparency",
      generatedAt: undefined,
      timeBuckets: [
        {
          signalKind: "tax_environment",
          sourceKey: "ato-corporate-tax-transparency",
          metricKey: "tax_payable",
          metricLabel: "Tax payable",
          unit: "AUD",
          bucketLabel: "2022-23",
          bucketStart: "2022-07-01",
          totalValue: 700_000_000,
          recordCount: 8,
          entityCount: 8,
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
          totalValue: 900_000_000,
          recordCount: 9,
          entityCount: 9,
          zeroValueCount: 0,
        },
      ],
      entityTotals: [
        {
          signalKind: "tax_environment",
          sourceKey: "ato-corporate-tax-transparency",
          metricKey: "tax_payable",
          stockCode: "MIN",
          entityLabel: "Mineral Resources",
          unit: "AUD",
          totalValue: 1_600_000_000,
          recordCount: 17,
          latestAsOf: "2024-06-30",
        },
      ],
    } as Awaited<ReturnType<typeof getIndustryIntelligence>>);

    const result = await Page({});
    render(result);

    await waitFor(() => {
      expect(
        screen.getByRole("heading", { name: "Industry Intelligence" }),
      ).toBeInTheDocument();
      expect(
        screen.getByRole("heading", { name: "Top Shorts In This Industry" }),
      ).toBeInTheDocument();
      expect(
        within(screen.getByTestId("industry-top-stocks-panel")).getByRole(
          "link",
          {
            name: /MIN.*Mineral Resources Ltd/,
          },
        ),
      ).toHaveAttribute("href", "/shorts/MIN");
      expect(
        screen.getByRole("link", { name: "View all top shorts" }),
      ).toHaveAttribute("href", "/top");
      expect(
        screen.getByRole("link", { name: "Find a stock" }),
      ).toHaveAttribute("href", "/stocks");
      expect(
        screen.getByRole("link", { name: "Open industry view" }),
      ).toHaveAttribute("href", "/industry/materials");
      // No policy_footprint data in this fixture, so the channel must not render.
      expect(screen.queryByText("Policy Footprint")).not.toBeInTheDocument();
      expect(screen.queryByText("Primary-source live")).not.toBeInTheDocument();
      expect(screen.queryByText(/source-ready/i)).not.toBeInTheDocument();
      expect(
        screen.getByRole("heading", {
          name: "Materials public-source signals",
        }),
      ).toBeInTheDocument();
      expect(
        screen.getByRole("heading", { name: "Tax Environment" }),
      ).toBeInTheDocument();
      expect(
        screen.getByText(/ATO Corporate Tax Transparency — CC-BY-3.0-AU/),
      ).toBeInTheDocument();
      expect(
        screen.getByRole("heading", {
          name: "Where these figures come from",
        }),
      ).toBeInTheDocument();
    });
  });
});
