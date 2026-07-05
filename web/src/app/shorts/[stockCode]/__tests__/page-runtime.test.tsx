/// <reference types="jest" />
import "@testing-library/jest-dom";
import fs from "node:fs";
import path from "node:path";

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
 * Runtime Import Test
 * 
 * This test verifies that all components can be imported at runtime
 * without "Element type is invalid" errors. It catches issues that
 * static analysis might miss, such as:
 * - Circular dependencies
 * - Dynamic imports that fail
 * - Components that are undefined at runtime
 */

import { describe, it, expect } from "@jest/globals";

describe("Stock Detail Page Runtime Imports", () => {
  it("should import all components without errors", async () => {
    // Test that all components can be imported
    const [
      CompanyInfoModule,
      CompanyProfileModule,
      CompanyStatsModule,
      StockChartPanelModule,
      EnrichedCompanySectionModule,
    ] = await Promise.all([
      import("~/@/components/ui/companyInfo"),
      import("~/@/components/ui/companyProfile"),
      import("~/@/components/ui/companyStats"),
      import("~/@/components/charts/StockChartPanel"),
      import("~/@/components/company/enriched-company-section"),
    ]);

    // Verify default exports exist
    expect(CompanyInfoModule.default).toBeDefined();
    expect(typeof CompanyInfoModule.default).toBe("function");
    
    expect(CompanyProfileModule.default).toBeDefined();
    expect(typeof CompanyProfileModule.default).toBe("function");
    
    expect(CompanyStatsModule.default).toBeDefined();
    expect(typeof CompanyStatsModule.default).toBe("function");
    
    expect(StockChartPanelModule.StockChartPanel).toBeDefined();
    expect(typeof StockChartPanelModule.StockChartPanel).toBe("function");

    // Verify named exports exist
    expect(CompanyInfoModule.CompanyInfoPlaceholder).toBeDefined();
    expect(typeof CompanyInfoModule.CompanyInfoPlaceholder).toBe("function");
    
    expect(CompanyProfileModule.CompanyProfilePlaceholder).toBeDefined();
    expect(typeof CompanyProfileModule.CompanyProfilePlaceholder).toBe("function");
    
    expect(CompanyStatsModule.CompanyStatsPlaceholder).toBeDefined();
    expect(typeof CompanyStatsModule.CompanyStatsPlaceholder).toBe("function");

    // Verify EnrichedCompanySection is exported correctly
    expect(EnrichedCompanySectionModule.EnrichedCompanySection).toBeDefined();
    expect(typeof EnrichedCompanySectionModule.EnrichedCompanySection).toBe("function");
  });

  it("should import page component without errors", async () => {
    // This will fail if any component import fails
    const PageModule = await import("../page");
    
    expect(PageModule.default).toBeDefined();
    expect(typeof PageModule.default).toBe("function");
  });

  it("renders stock pages through ISR so warm stock pages serve from cache", async () => {
    const PageModule = await import("../page");

    expect(PageModule.revalidate).toBe(86400);
    expect(PageModule.dynamic).toBeUndefined();
    expect(PageModule.fetchCache).toBeUndefined();
    expect(typeof PageModule.generateStaticParams).toBe("function");
  });

  it("keeps volatile community data out of the stock page HTML cache path", () => {
    const source = fs.readFileSync(
      path.resolve(__dirname, "../page.tsx"),
      "utf8",
    );

    expect(source).not.toContain("community-summary-cache");
    expect(source).not.toContain("getCachedStockCommunitySummary");
  });

  it("does not let stock-page child fetches lower the 24h ISR window", () => {
    const source = fs.readFileSync(
      path.resolve(__dirname, "../short-interest-history.tsx"),
      "utf8",
    );

    expect(source).toContain("STOCK_PAGE_CACHE_SECONDS");
    expect(source).not.toContain("revalidate: 3600");
  });

  it("should import child components used by EnrichedCompanySection", async () => {
    const [
      CompanyOverviewModule,
      KeyPeopleModule,
      FinancialReportsModule,
    ] = await Promise.all([
      import("~/@/components/company/company-overview"),
      import("~/@/components/company/key-people"),
      import("~/@/components/company/financial-reports"),
    ]);

    expect(CompanyOverviewModule.CompanyOverview).toBeDefined();
    expect(typeof CompanyOverviewModule.CompanyOverview).toBe("function");
    
    expect(KeyPeopleModule.KeyPeople).toBeDefined();
    expect(typeof KeyPeopleModule.KeyPeople).toBe("function");
    
    expect(FinancialReportsModule.FinancialReports).toBeDefined();
    expect(typeof FinancialReportsModule.FinancialReports).toBe("function");
  });
});
