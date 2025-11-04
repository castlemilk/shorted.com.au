import { render } from "@testing-library/react";
import Page, { generateMetadata } from "../page";

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

// Mock auth
jest.mock("@/auth", () => ({
  auth: jest.fn().mockResolvedValue({ user: { id: "test-user" } }),
}));

describe("/shorts/[stockCode] Page (SSR)", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe("Server-Side Rendering", () => {
    it("should render with uppercase stock code", async () => {
      const jsx = await Page({ params: { stockCode: "cba" } });
      const { getByTestId } = render(jsx);

      expect(getByTestId("chart")).toHaveTextContent("cba");
      expect(getByTestId("market-chart")).toHaveTextContent("cba");
      expect(getByTestId("company-profile")).toHaveTextContent("cba");
      expect(getByTestId("company-stats")).toHaveTextContent("cba");
      expect(getByTestId("company-info")).toHaveTextContent("cba");
    });

    it("should include structured data for SEO", async () => {
      const jsx = await Page({ params: { stockCode: "BHP" } });
      const { getByTestId } = render(jsx);

      const structuredData = getByTestId("structured-data");
      expect(structuredData).toBeInTheDocument();
      expect(structuredData).toHaveAttribute("data-stock", "BHP");
    });

    it("should render breadcrumbs navigation", async () => {
      const jsx = await Page({ params: { stockCode: "CSL" } });
      const { getByTestId } = render(jsx);

      const breadcrumbs = getByTestId("breadcrumbs");
      expect(breadcrumbs).toHaveTextContent("Stocks > CSL");
    });
  });

  describe("Metadata Generation", () => {
    it("should generate metadata with stock code", async () => {
      const metadata = await generateMetadata({
        params: { stockCode: "cba" },
      });

      expect(metadata.title).toContain("CBA");
      expect(metadata.description).toContain("CBA");
      expect(metadata.keywords).toContain("CBA short position");
      expect(metadata.keywords).toContain("CBA ASX");
    });

    it("should include OpenGraph metadata", async () => {
      const metadata = await generateMetadata({
        params: { stockCode: "bhp" },
      });

      expect(metadata.openGraph?.title).toContain("BHP");
      expect(metadata.openGraph?.type).toBe("article");
      expect(metadata.openGraph?.url).toContain("/shorts/BHP");
    });

    it("should include Twitter card metadata", async () => {
      const metadata = await generateMetadata({
        params: { stockCode: "csl" },
      });

      expect(metadata.twitter?.card).toBe("summary_large_image");
      expect(metadata.twitter?.title).toContain("CSL");
    });

    it("should set canonical URL correctly", async () => {
      const metadata = await generateMetadata({
        params: { stockCode: "wbc" },
      });

      expect(metadata.alternates?.canonical).toContain("/shorts/WBC");
    });

    it("should enable search indexing", async () => {
      const metadata = await generateMetadata({
        params: { stockCode: "nab" },
      });

      expect(metadata.robots?.index).toBe(true);
      expect(metadata.robots?.follow).toBe(true);
    });
  });

  describe("ISR Configuration", () => {
    it("should have revalidate time of 60 seconds", async () => {
      const module = await import("../page");
      expect(module.revalidate).toBe(60);
    });
  });
});
