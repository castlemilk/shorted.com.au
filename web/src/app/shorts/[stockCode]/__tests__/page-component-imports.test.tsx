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
 * Component Import Test
 * 
 * This test verifies that components can be imported exactly as they are
 * in page.tsx. This catches runtime import issues that static analysis misses.
 */

import { describe, it, expect } from "@jest/globals";

// Mock the actions to avoid Connect RPC issues in tests
jest.mock("~/app/actions/getStockDetails", () => ({
  getStockDetails: jest.fn(),
}));

jest.mock("~/app/actions/getStock", () => ({
  getStock: jest.fn(),
}));

jest.mock("~/app/actions/company-metadata", () => ({
  getEnrichedCompanyMetadata: jest.fn(),
}));

describe("Page Component Imports (matching page.tsx)", () => {
  it("should import CompanyInfo exactly as page.tsx does", async () => {
    // Import exactly as page.tsx does
    const CompanyInfoModule = await import("~/@/components/ui/companyInfo");
    
    // Verify default export exists (used as: import CompanyInfo from ...)
    expect(CompanyInfoModule.default).toBeDefined();
    expect(typeof CompanyInfoModule.default).toBe("function");
    
    // Verify named export exists (used as: import { CompanyInfoPlaceholder } from ...)
    expect(CompanyInfoModule.CompanyInfoPlaceholder).toBeDefined();
    expect(typeof CompanyInfoModule.CompanyInfoPlaceholder).toBe("function");
  });

  it("should import CompanyProfile exactly as page.tsx does", async () => {
    const CompanyProfileModule = await import("~/@/components/ui/companyProfile");
    
    expect(CompanyProfileModule.default).toBeDefined();
    expect(typeof CompanyProfileModule.default).toBe("function");
    expect(CompanyProfileModule.CompanyProfilePlaceholder).toBeDefined();
    expect(typeof CompanyProfileModule.CompanyProfilePlaceholder).toBe("function");
  });

  it("should import CompanyStats exactly as page.tsx does", async () => {
    const CompanyStatsModule = await import("~/@/components/ui/companyStats");
    
    expect(CompanyStatsModule.default).toBeDefined();
    expect(typeof CompanyStatsModule.default).toBe("function");
    expect(CompanyStatsModule.CompanyStatsPlaceholder).toBeDefined();
    expect(typeof CompanyStatsModule.CompanyStatsPlaceholder).toBe("function");
  });

  it("should import all components together without conflicts", async () => {
    // Import all components as page.tsx does
    const [
      CompanyInfo,
      { CompanyInfoPlaceholder },
      CompanyProfile,
      { CompanyProfilePlaceholder },
      CompanyStats,
      { CompanyStatsPlaceholder },
    ] = await Promise.all([
      import("~/@/components/ui/companyInfo").then(m => m.default),
      import("~/@/components/ui/companyInfo"),
      import("~/@/components/ui/companyProfile").then(m => m.default),
      import("~/@/components/ui/companyProfile"),
      import("~/@/components/ui/companyStats").then(m => m.default),
      import("~/@/components/ui/companyStats"),
    ]);

    // All should be functions (React components)
    expect(typeof CompanyInfo).toBe("function");
    expect(typeof CompanyInfoPlaceholder).toBe("function");
    expect(typeof CompanyProfile).toBe("function");
    expect(typeof CompanyProfilePlaceholder).toBe("function");
    expect(typeof CompanyStats).toBe("function");
    expect(typeof CompanyStatsPlaceholder).toBe("function");
    
    // None should be undefined
    expect(CompanyInfo).not.toBeUndefined();
    expect(CompanyInfoPlaceholder).not.toBeUndefined();
    expect(CompanyProfile).not.toBeUndefined();
    expect(CompanyProfilePlaceholder).not.toBeUndefined();
    expect(CompanyStats).not.toBeUndefined();
    expect(CompanyStatsPlaceholder).not.toBeUndefined();
  });
});



