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
 * SSR Test for Stock Detail Page
 * 
 * This test verifies that the page can be server-side rendered without errors.
 * It catches issues that only appear during SSR (like accessing browser APIs).
 */

import { describe, it, expect } from "@jest/globals";
import React from "react";
import { renderToString } from "react-dom/server";

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

// Mock all async components and actions
jest.mock("~/app/actions/getStockDetails", () => ({
  getStockDetails: jest.fn().mockResolvedValue({
    productCode: "BOE",
    companyName: "Test Company",
    summary: "Test summary",
  }),
}));

jest.mock("~/app/actions/getStock", () => ({
  getStock: jest.fn().mockResolvedValue({
    productCode: "BOE",
    percentageShorted: 5.0,
    reportedShortPositions: 1000000,
    totalProductInIssue: 20000000,
  }),
}));

jest.mock("~/app/actions/company-metadata", () => ({
  getEnrichedCompanyMetadata: jest.fn().mockResolvedValue(null),
}));

jest.mock("~/app/actions/getStockData", () => ({
  getStockData: jest.fn().mockResolvedValue({
    productCode: "BOE",
    points: [],
  }),
}));

// Mock DashboardLayout (now uses dynamic import for Sidebar)
jest.mock("~/@/components/layouts/dashboard-layout", () => ({
  DashboardLayout: ({ children }: { children: React.ReactNode }) => (
    <div data-testid="dashboard-layout">{children}</div>
  ),
}));

// Mock next/dynamic
jest.mock("next/dynamic", () => {
  return jest.fn((loader, options) => {
    // Return a simple component for testing
    return function DynamicComponent(props: any) {
      return null; // Sidebar won't render during SSR anyway
    };
  });
});

// Mock client components
jest.mock("~/@/components/ui/chart", () => ({
  __esModule: true,
  default: ({ stockCode }: { stockCode: string }) => (
    <div data-testid="chart">{stockCode}</div>
  ),
}));

jest.mock("~/@/components/ui/market-chart", () => ({
  __esModule: true,
  default: ({ stockCode }: { stockCode: string }) => (
    <div data-testid="market-chart">{stockCode}</div>
  ),
}));

describe("Stock Detail Page SSR", () => {
  it("should render without errors during SSR", async () => {
    // Import the page component
    const PageModule = await import("../page");
    const Page = PageModule.default;

    // Attempt to render to string (simulating SSR)
    let html: string;
    let error: Error | null = null;

    try {
      html = renderToString(
        React.createElement(Page, { params: { stockCode: "BOE" } }),
      );
    } catch (e) {
      error = e as Error;
      // Log the error to help debug
      console.error("SSR Error:", error.message);
      console.error("Stack:", error.stack);
    }

    // Should not throw an error
    if (error) {
      // If there's an error, check if it's about undefined component
      const errorMsg = error.message.toLowerCase();
      if (errorMsg.includes("element type is invalid") || errorMsg.includes("undefined")) {
        // Try to identify which component is undefined
        const componentImports = [
          "DashboardLayout",
          "Sidebar",
          "CompanyInfo",
          "CompanyProfile",
          "CompanyStats",
          "Chart",
          "MarketChart",
        ];
        
        for (const compName of componentImports) {
          try {
            // This is a basic check - in real scenario we'd need to check imports
            console.log(`Checking ${compName}...`);
          } catch (e) {
            console.error(`${compName} import failed:`, e);
          }
        }
      }
    }
    
    expect(error).toBeNull();
    expect(html!).toBeDefined();
    expect(typeof html!).toBe("string");
    expect(html!.length).toBeGreaterThan(0);
  });

  it("should handle missing stock data gracefully during SSR", async () => {
    const { getStockDetails } = require("~/app/actions/getStockDetails");
    getStockDetails.mockResolvedValueOnce(undefined);

    const PageModule = await import("../page");
    const Page = PageModule.default;

    let error: Error | null = null;
    try {
      renderToString(
        React.createElement(Page, { params: { stockCode: "INVALID" } }),
      );
    } catch (e) {
      error = e as Error;
    }

    // Should handle missing data gracefully
    expect(error).toBeNull();
  });
});

