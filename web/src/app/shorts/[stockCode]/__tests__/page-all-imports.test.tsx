/// <reference types="jest" />
import "@testing-library/jest-dom";
import { TextEncoder, TextDecoder } from "util";

if (!globalThis.TextEncoder) {
  globalThis.TextEncoder = TextEncoder;
}
if (!globalThis.TextDecoder) {
  // @ts-expect-error - TextDecoder type on Node differs from DOM lib
  globalThis.TextDecoder = TextDecoder;
}

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

jest.mock("next-auth/react", () => ({
  useSession: jest.fn(() => ({
    data: null,
    status: "unauthenticated",
  })),
}));

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
      ChartModule,
      MarketChartModule,
      CompanyInfoModule,
      CompanyProfileModule,
      CompanyStatsModule,
    ] = await Promise.all([
      import("~/@/components/ui/card"),
      import("~/@/components/ui/chart"),
      import("~/@/components/ui/market-chart"),
      import("~/@/components/ui/companyInfo"),
      import("~/@/components/ui/companyProfile"),
      import("~/@/components/ui/companyStats"),
    ]);

    expect(CardModule.Card).toBeDefined();
    expect(CardModule.CardHeader).toBeDefined();
    expect(CardModule.CardTitle).toBeDefined();
    expect(CardModule.CardContent).toBeDefined();
    expect(CardModule.CardDescription).toBeDefined();
    
    expect(ChartModule.default).toBeDefined();
    expect(typeof ChartModule.default).toBe("function");
    
    expect(MarketChartModule.default).toBeDefined();
    expect(typeof MarketChartModule.default).toBe("function");
    
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
      Chart,
      MarketChart,
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
      import("~/@/components/ui/chart").then(m => m.default),
      import("~/@/components/ui/market-chart").then(m => m.default),
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
      Chart,
      MarketChart,
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
      expect(typeof component).toBe("function");
    }
  });
});



