import "@testing-library/jest-dom";
import { render, screen, waitFor, within } from "@testing-library/react";
import Page from "../page";
import {
  getIndustryData,
  getIndustryStocks,
} from "~/app/actions/industry/getIndustryData";

jest.mock("~/@/components/layouts/dashboard-layout", () => ({
  DashboardLayout: ({ children }: { children: React.ReactNode }) => (
    <div data-testid="dashboard-layout">{children}</div>
  ),
}));

jest.mock("~/app/actions/industry/getIndustryData", () => ({
  getIndustryData: jest.fn(),
  getIndustryStocks: jest.fn(),
}));

const mockedGetIndustryData = getIndustryData as jest.MockedFunction<
  typeof getIndustryData
>;
const mockedGetIndustryStocks = getIndustryStocks as jest.MockedFunction<
  typeof getIndustryStocks
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
            name: /MIN.*Mineral Resources/,
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
        screen.getAllByText("Policy Footprint").length,
      ).toBeGreaterThanOrEqual(1);
      expect(screen.getByText("Primary-source live")).toBeInTheDocument();
    });
  });
});
