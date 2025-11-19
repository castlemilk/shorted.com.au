/// <reference types="jest" />
import "@testing-library/jest-dom";
import React from "react";
import { render } from "@testing-library/react";

// Mock Connect RPC before any imports
jest.mock("@connectrpc/connect", () => ({
  createClient: jest.fn(() => ({
    getStockDetails: jest.fn(),
  })),
}));

jest.mock("@connectrpc/connect-web", () => ({
  createConnectTransport: jest.fn(() => ({})),
}));

import Page from "../page";

// Mock all child components
jest.mock("~/@/components/ui/chart", () => ({
  __esModule: true,
  default: ({ stockCode }: any) => <div data-testid="chart">{stockCode}</div>,
}));

jest.mock("~/@/components/ui/market-chart", () => ({
  __esModule: true,
  default: ({ stockCode }: any) => (
    <div data-testid="market-chart">{stockCode}</div>
  ),
}));

jest.mock("~/@/components/ui/companyProfile", () => ({
  __esModule: true,
  default: ({ stockCode }: any) => (
    <div data-testid="company-profile">{stockCode}</div>
  ),
  CompanyProfilePlaceholder: () => (
    <div data-testid="company-profile-placeholder" />
  ),
}));

jest.mock("~/@/components/ui/companyStats", () => ({
  __esModule: true,
  default: ({ stockCode }: any) => (
    <div data-testid="company-stats">{stockCode}</div>
  ),
  CompanyStatsPlaceholder: () => (
    <div data-testid="company-stats-placeholder" />
  ),
}));

jest.mock("~/@/components/ui/companyInfo", () => ({
  __esModule: true,
  default: ({ stockCode }: any) => (
    <div data-testid="company-info">{stockCode}</div>
  ),
  CompanyInfoPlaceholder: () => <div data-testid="company-info-placeholder" />,
}));

jest.mock("~/@/components/seo/structured-data", () => ({
  StockStructuredData: ({ stockCode }: any) => (
    <script data-testid="structured-data" data-stock={stockCode} />
  ),
}));

jest.mock("~/@/components/seo/breadcrumbs", () => ({
  Breadcrumbs: ({ items }: any) => (
    <nav data-testid="breadcrumbs">
      {items.map((item: any) => item.label).join(" > ")}
    </nav>
  ),
  BreadcrumbStructuredData: () => (
    <script data-testid="breadcrumb-structured" />
  ),
}));

// Mock DashboardLayout
jest.mock("@/components/layouts/dashboard-layout", () => ({
  DashboardLayout: ({ children }: any) => (
    <div data-testid="dashboard-layout">{children}</div>
  ),
}));

// Mock Card components
jest.mock("~/@/components/ui/card", () => ({
  Card: ({ children }: any) => <div data-testid="card">{children}</div>,
  CardContent: ({ children }: any) => <div>{children}</div>,
  CardDescription: ({ children }: any) => <div>{children}</div>,
  CardHeader: ({ children }: any) => <div>{children}</div>,
  CardTitle: ({ children }: any) => <div>{children}</div>,
}));

// Mock lucide icons
jest.mock("lucide-react", () => ({
  TrendingDown: () => <div data-testid="trending-down-icon" />,
  CandlestickChart: () => <div data-testid="candlestick-icon" />,
}));

// Mock LLMMeta component
jest.mock("~/@/components/seo/llm-meta", () => ({
  LLMMeta: () => <script data-testid="llm-meta" />,
}));

// Note: No auth mocking needed - this page is public!

describe("/shorts/[stockCode] Page (Client-Side - Public)", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe("Client-Side Rendering", () => {
    it("should render public stock page with uppercase stock code", () => {
      const { getByTestId } = render(<Page params={{ stockCode: "cba" }} />);

      expect(getByTestId("chart")).toHaveTextContent("cba");
      expect(getByTestId("market-chart")).toHaveTextContent("cba");
      expect(getByTestId("company-profile")).toHaveTextContent("cba");
      expect(getByTestId("company-stats")).toHaveTextContent("cba");
      expect(getByTestId("company-info")).toHaveTextContent("cba");
    });

    it("should include structured data for SEO", () => {
      const { getByTestId } = render(<Page params={{ stockCode: "BHP" }} />);

      const structuredData = getByTestId("structured-data");
      expect(structuredData).toBeInTheDocument();
      expect(structuredData).toHaveAttribute("data-stock", "BHP");
    });

    it("should render breadcrumbs navigation", () => {
      const { getByTestId } = render(<Page params={{ stockCode: "CSL" }} />);

      const breadcrumbs = getByTestId("breadcrumbs");
      expect(breadcrumbs).toHaveTextContent("Stocks > CSL");
    });
  });
});
