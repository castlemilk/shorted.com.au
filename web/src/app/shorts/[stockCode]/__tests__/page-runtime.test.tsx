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

  it("renders stock pages with ISR (every server fetch is unstable_cache-wrapped or revalidate-tagged)", async () => {
    const PageModule = await import("../page");

    // The page moved off force-dynamic (July 2026): all connect POSTs in the
    // render tree run inside unstable_cache, so ISR is safe and ~1,600 pages
    // stop re-rendering on every crawl hit.
    expect(PageModule.dynamic).toBeUndefined();
    expect(PageModule.revalidate).toBe(3600);
    expect(PageModule.fetchCache).toBeUndefined();
    // Present-but-empty generateStaticParams is REQUIRED: without it a
    // dynamic segment is never statically optimized and revalidate is inert.
    expect(PageModule.generateStaticParams).toBeDefined();
    expect(PageModule.generateStaticParams()).toEqual([]);
  });

  it("keeps per-request session reads out of the ISR render path", () => {
    const source = fs.readFileSync(
      path.resolve(__dirname, "../page.tsx"),
      "utf8",
    );

    // auth() reads cookies and silently forces the whole route dynamic —
    // session-dependent UI must be client-gated instead. Gated DATA (the
    // evidence dossier) is client-FETCHED post-auth so it never ships in
    // the shared ISR payload.
    expect(source).not.toContain("~/server/auth");
    expect(source).not.toContain("await auth()");
    expect(source).toContain("StockEvidencePanelClient");
    expect(source).toContain("SignedOutOnly");
  });

  it("keeps volatile community data out of the stock page HTML cache path", () => {
    const source = fs.readFileSync(
      path.resolve(__dirname, "../page.tsx"),
      "utf8",
    );

    expect(source).not.toContain("community-summary-cache");
    expect(source).not.toContain("getCachedStockCommunitySummary");
  });

  it("keeps stock-page child fetches aligned with the public edge cache window", () => {
    const source = fs.readFileSync(
      path.resolve(__dirname, "../short-interest-history.tsx"),
      "utf8",
    );

    expect(source).toContain("STOCK_PAGE_CACHE_SECONDS");
    expect(source).not.toContain("revalidate: 3600");
  });

  it("should import child components used by EnrichedCompanySection", async () => {
    const [
      CompanyInsightsModule,
      KeyPeopleModule,
      FinancialReportsModule,
    ] = await Promise.all([
      import("~/@/components/company/company-insights-card"),
      import("~/@/components/company/key-people"),
      import("~/@/components/company/financial-reports"),
    ]);

    expect(CompanyInsightsModule.CompanyInsightsCard).toBeDefined();
    expect(typeof CompanyInsightsModule.CompanyInsightsCard).toBe("function");
    
    expect(KeyPeopleModule.KeyPeople).toBeDefined();
    expect(typeof KeyPeopleModule.KeyPeople).toBe("function");
    
    expect(FinancialReportsModule.FinancialReports).toBeDefined();
    expect(typeof FinancialReportsModule.FinancialReports).toBe("function");
  });
});
