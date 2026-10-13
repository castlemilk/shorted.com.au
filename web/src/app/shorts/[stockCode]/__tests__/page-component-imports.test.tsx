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

  it("should import CompanyInfo and its placeholder together without conflicts", async () => {
    // Import both as page.tsx does
    const [CompanyInfo, { CompanyInfoPlaceholder }] = await Promise.all([
      import("~/@/components/ui/companyInfo").then(m => m.default),
      import("~/@/components/ui/companyInfo"),
    ]);

    // Both should be functions (React components)
    expect(typeof CompanyInfo).toBe("function");
    expect(typeof CompanyInfoPlaceholder).toBe("function");

    // Neither should be undefined
    expect(CompanyInfo).not.toBeUndefined();
    expect(CompanyInfoPlaceholder).not.toBeUndefined();
  });
});

describe("Chart section imports (matching page.tsx and short-interest/page.tsx)", () => {
  it("should import the pieces of the chart section exactly as the pages do", async () => {
    const [PanelModule, SectionModule] = await Promise.all([
      import("~/@/components/charts/StockChartPanel"),
      import("~/@/components/charts/stock-chart-section"),
    ]);

    // The pages load the panel with next/dynamic and pick the NAMED export:
    // import(...).then((m) => m.StockChartPanel). A typo there is an undefined
    // component at render time, not an import error.
    expect(typeof PanelModule.StockChartPanel).toBe("function");

    // What a server page renders itself: the heading and the skeleton the
    // dynamic import's `loading` and both loading.tsx files show.
    expect(typeof SectionModule.StockChartHeading).toBe("function");
    expect(typeof SectionModule.StockChartPanelSkeleton).toBe("function");
    expect(typeof SectionModule.CHART_BOX_HEIGHT_CLASS).toBe("string");
  });
});

describe("Layout component imports (matching layout.tsx)", () => {
  it("should import the header and the tab bar exactly as the layout does", async () => {
    const [HeaderModule, TabNavModule] = await Promise.all([
      import("~/@/components/company/stock-header"),
      import("~/@/components/company/stock-tab-nav"),
    ]);

    expect(typeof HeaderModule.StockHeader).toBe("function");
    expect(typeof TabNavModule.StockTabNav).toBe("function");
  });
});

describe("Strategy tab component imports (matching strategy/page.tsx)", () => {
  it("should import the panel, the chart island and the status line exactly as the page does", async () => {
    const [PanelModule, ChartModule, StripModule] = await Promise.all([
      import("~/@/components/strategy/strategy-fit-panel"),
      import("~/@/components/strategy/strategy-levels-chart"),
      import("~/@/components/stocks/strategy-fit-strip"),
    ]);

    // Used as: import { StrategyFitPanel, sortFitsByStrength } from ...
    expect(typeof PanelModule.StrategyFitPanel).toBe("function");
    expect(typeof PanelModule.sortFitsByStrength).toBe("function");

    // The page loads the island with next/dynamic and picks the NAMED export:
    // import(...).then((m) => m.StrategyLevelsChart). A typo there is an
    // undefined component, not an import error.
    expect(typeof ChartModule.StrategyLevelsChart).toBe("function");

    // The panel header renders the strip's status line.
    expect(typeof StripModule.FitStatusLine).toBe("function");
  });
});
