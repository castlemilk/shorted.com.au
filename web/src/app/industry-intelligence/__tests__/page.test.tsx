import "@testing-library/jest-dom";
import { render, screen, waitFor, within } from "@testing-library/react";
import Page from "../page";
import {
  getIndustryData,
  getIndustryStocks,
} from "~/app/actions/industry/getIndustryData";
import { getTopShortsData } from "~/app/actions/getTopShorts";

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

const mockedGetIndustryData = getIndustryData as jest.MockedFunction<
  typeof getIndustryData
>;
const mockedGetIndustryStocks = getIndustryStocks as jest.MockedFunction<
  typeof getIndustryStocks
>;
const mockedGetTopShortsData = getTopShortsData as jest.MockedFunction<
  typeof getTopShortsData
>;

describe("/industry-intelligence page", () => {
  beforeEach(() => {
    jest.clearAllMocks();
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

    const result = await Page({});
    render(result);

    await waitFor(() => {
      expect(
        screen.getByRole("heading", { name: "Industry Intelligence" }),
      ).toBeInTheDocument();
      expect(
        screen.getByRole("heading", { name: "Top Stocks In This Industry" }),
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
      expect(
        screen.queryByText("Policy Footprint"),
      ).not.toBeInTheDocument();
      expect(screen.queryByText("Primary-source live")).not.toBeInTheDocument();
      expect(screen.queryByText(/source-ready/i)).not.toBeInTheDocument();
    });
  });
});
