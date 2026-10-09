/// <reference types="jest" />
import "@testing-library/jest-dom";

// Mock Connect RPC before any imports
jest.mock("@connectrpc/connect", () => ({
  createClient: jest.fn(() => ({
    getStockDetails: jest.fn(),
  })),
}));

jest.mock("@connectrpc/connect-web", () => ({
  createConnectTransport: jest.fn(() => ({})),
}));

/**
 * Comprehensive Import Test
 * 
 * This test verifies that ALL components used in page.tsx can be imported
 * without errors. This helps identify which component is undefined.
 */

import { describe, it, expect } from "@jest/globals";

// Mock Next.js modules
jest.mock("next/navigation", () => ({
  usePathname: jest.fn(() => "/shorts/BOE"),
}));

jest.mock("next/link", () => ({
  __esModule: true,
  default: ({ children, href }: any) => {
    const React = require("react");
    return React.createElement("a", { href }, children);
  },
}));

jest.mock("next-auth/react", () => ({
  useSession: jest.fn(() => ({
    data: null,
    status: "unauthenticated",
  })),
}));

// The Overview and Company pages reach kv-cache through their actions, and the
// real module logs "No Redis configured" when it loads. The same stand-in
// page.test.tsx uses.
jest.mock("~/@/lib/kv-cache", () => require("~/@/lib/__mocks__/kv-cache"));

// Mock actions
jest.mock("~/app/actions/getStockDetails", () => ({
  getStockDetails: jest.fn().mockResolvedValue({
    productCode: "BOE",
    companyName: "Test Company",
  }),
}));

jest.mock("~/app/actions/getStock", () => ({
  getStock: jest.fn().mockResolvedValue({
    productCode: "BOE",
    percentageShorted: 5.0,
  }),
}));

jest.mock("~/app/actions/company-metadata", () => ({
  getEnrichedCompanyMetadata: jest.fn().mockResolvedValue(null),
}));

describe("Page Component Imports - All Components", () => {
  it("should import all SEO components", async () => {
    const [
      StockStructuredDataModule,
      BreadcrumbsModule,
      BreadcrumbStructuredDataModule,
      LLMMetaModule,
    ] = await Promise.all([
      import("~/@/components/seo/structured-data"),
      import("~/@/components/seo/breadcrumbs"),
      import("~/@/components/seo/breadcrumbs"),
      import("~/@/components/seo/llm-meta"),
    ]);

    expect(StockStructuredDataModule.StockStructuredData).toBeDefined();
    expect(typeof StockStructuredDataModule.StockStructuredData).toBe("function");
    
    expect(BreadcrumbsModule.Breadcrumbs).toBeDefined();
    expect(typeof BreadcrumbsModule.Breadcrumbs).toBe("function");
    
    expect(BreadcrumbStructuredDataModule.BreadcrumbStructuredData).toBeDefined();
    expect(typeof BreadcrumbStructuredDataModule.BreadcrumbStructuredData).toBe("function");
    
    expect(LLMMetaModule.LLMMeta).toBeDefined();
    expect(typeof LLMMetaModule.LLMMeta).toBe("function");
  });

  it("should import DashboardLayout", async () => {
    const DashboardLayoutModule = await import("~/@/components/layouts/dashboard-layout");
    
    expect(DashboardLayoutModule.DashboardLayout).toBeDefined();
    expect(typeof DashboardLayoutModule.DashboardLayout).toBe("function");
  });

  it("should import all UI components", async () => {
    const [
      CardModule,
      StockChartPanelModule,
      CompanyInfoModule,
      CompanyProfileModule,
      CompanyStatsModule,
    ] = await Promise.all([
      import("~/@/components/ui/card"),
      import("~/@/components/charts/StockChartPanel"),
      import("~/@/components/ui/companyInfo"),
      import("~/@/components/ui/companyProfile"),
      import("~/@/components/ui/companyStats"),
    ]);

    expect(CardModule.Card).toBeDefined();
    expect(CardModule.CardHeader).toBeDefined();
    expect(CardModule.CardTitle).toBeDefined();
    expect(CardModule.CardContent).toBeDefined();
    expect(CardModule.CardDescription).toBeDefined();

    expect(StockChartPanelModule.StockChartPanel).toBeDefined();
    expect(typeof StockChartPanelModule.StockChartPanel).toBe("function");

    expect(CompanyInfoModule.default).toBeDefined();
    expect(CompanyInfoModule.CompanyInfoPlaceholder).toBeDefined();
    
    expect(CompanyProfileModule.default).toBeDefined();
    expect(CompanyProfileModule.CompanyProfilePlaceholder).toBeDefined();
    
    expect(CompanyStatsModule.default).toBeDefined();
    expect(CompanyStatsModule.CompanyStatsPlaceholder).toBeDefined();
  });

  it("should import EnrichedCompanySection", async () => {
    const EnrichedModule = await import("~/@/components/company/enriched-company-section");
    
    expect(EnrichedModule.EnrichedCompanySection).toBeDefined();
    expect(typeof EnrichedModule.EnrichedCompanySection).toBe("function");
  });

  it("should import all components exactly as page.tsx does", async () => {
    // Import exactly as page.tsx does
    const [
      StockChartPanel,
      CompanyProfile,
      CompanyProfilePlaceholder,
      CompanyStats,
      CompanyStatsPlaceholder,
      CompanyInfo,
      CompanyInfoPlaceholder,
      EnrichedCompanySection,
      StockStructuredData,
      Breadcrumbs,
      BreadcrumbStructuredData,
      LLMMeta,
      DashboardLayout,
      Card,
      CardContent,
      CardDescription,
      CardHeader,
      CardTitle,
    ] = await Promise.all([
      import("~/@/components/charts/StockChartPanel").then(m => m.StockChartPanel),
      import("~/@/components/ui/companyProfile").then(m => m.default),
      import("~/@/components/ui/companyProfile").then(m => m.CompanyProfilePlaceholder),
      import("~/@/components/ui/companyStats").then(m => m.default),
      import("~/@/components/ui/companyStats").then(m => m.CompanyStatsPlaceholder),
      import("~/@/components/ui/companyInfo").then(m => m.default),
      import("~/@/components/ui/companyInfo").then(m => m.CompanyInfoPlaceholder),
      import("~/@/components/company/enriched-company-section").then(m => m.EnrichedCompanySection),
      import("~/@/components/seo/structured-data").then(m => m.StockStructuredData),
      import("~/@/components/seo/breadcrumbs").then(m => m.Breadcrumbs),
      import("~/@/components/seo/breadcrumbs").then(m => m.BreadcrumbStructuredData),
      import("~/@/components/seo/llm-meta").then(m => m.LLMMeta),
      import("~/@/components/layouts/dashboard-layout").then(m => m.DashboardLayout),
      import("~/@/components/ui/card").then(m => m.Card),
      import("~/@/components/ui/card").then(m => m.CardContent),
      import("~/@/components/ui/card").then(m => m.CardDescription),
      import("~/@/components/ui/card").then(m => m.CardHeader),
      import("~/@/components/ui/card").then(m => m.CardTitle),
    ]);

    // Verify none are undefined
    const components = {
      StockChartPanel,
      CompanyProfile,
      CompanyProfilePlaceholder,
      CompanyStats,
      CompanyStatsPlaceholder,
      CompanyInfo,
      CompanyInfoPlaceholder,
      EnrichedCompanySection,
      StockStructuredData,
      Breadcrumbs,
      BreadcrumbStructuredData,
      LLMMeta,
      DashboardLayout,
      Card,
      CardContent,
      CardDescription,
      CardHeader,
      CardTitle,
    };

    for (const [name, component] of Object.entries(components)) {
      expect(component).toBeDefined();
      expect(component).not.toBeNull();
      // Components can be functions or objects (React.forwardRef returns an object)
      expect(typeof component === "function" || typeof component === "object").toBe(true);
    }
  });
});

describe("Stock page route modules", () => {
  // The layout and every tab page, imported the way Next imports them. A module
  // that throws while loading, or a route file without a component as its
  // default export, otherwise only shows up at render time as "Element type is
  // invalid" (for the layout, on every route beneath it).
  it("should import the layout and every tab page with a component as its default export", async () => {
    const routes = await Promise.all([
      import("../layout"),
      import("../page"),
      import("../short-interest/page"),
      import("../strategy/page"),
      import("../financials/page"),
      import("../company/page"),
      import("../news/page"),
      import("../community/page"),
    ]);

    expect(routes).toHaveLength(8);
    for (const route of routes) {
      expect(typeof route.default).toBe("function");
    }
  });

  it("should import the stock loader the layout and the tab pages share", async () => {
    const { loadStockOrFail } = await import("../stock-page-data");

    expect(typeof loadStockOrFail).toBe("function");
  });
});
