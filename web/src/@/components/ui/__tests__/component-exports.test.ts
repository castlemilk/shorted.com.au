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
 * Component Export Tests
 * 
 * These tests verify that components can be imported correctly and have
 * the expected exports. This catches import/export mismatches that would
 * cause "Element type is invalid" errors at runtime.
 */

import { describe, it, expect } from "@jest/globals";

describe("Component Exports", () => {
  describe("CompanyInfo", () => {
    it("should export default component", async () => {
      const module = await import("~/@/components/ui/companyInfo");
      expect(module.default).toBeDefined();
      expect(typeof module.default).toBe("function");
    });

    it("should export CompanyInfoPlaceholder", async () => {
      const module = await import("~/@/components/ui/companyInfo");
      expect(module.CompanyInfoPlaceholder).toBeDefined();
      expect(typeof module.CompanyInfoPlaceholder).toBe("function");
    });

    it("should not export companyInfo (lowercase)", async () => {
      const module = await import("~/@/components/ui/companyInfo");
      // @ts-expect-error - This should not exist
      expect(module.companyInfo).toBeUndefined();
    });
  });

  describe("CompanyFinancials", () => {
    it("should export default component", async () => {
      const module = await import("~/@/components/ui/companyFinancials");
      expect(module.default).toBeDefined();
      expect(typeof module.default).toBe("function");
    });

    it("should export CompanyFinancialsPlaceholder", async () => {
      const module = await import("~/@/components/ui/companyFinancials");
      expect(module.CompanyFinancialsPlaceholder).toBeDefined();
      expect(typeof module.CompanyFinancialsPlaceholder).toBe("function");
    });
  });

  describe("Component imports match page.tsx expectations", () => {
    it("should allow importing CompanyInfo as default export", async () => {
      const CompanyInfo = (await import("~/@/components/ui/companyInfo")).default;
      expect(CompanyInfo).toBeDefined();
    });

    it("should allow importing CompanyInfoPlaceholder as named export", async () => {
      const { CompanyInfoPlaceholder } = await import("~/@/components/ui/companyInfo");
      expect(CompanyInfoPlaceholder).toBeDefined();
    });

    it("should allow importing CompanyFinancials as default export", async () => {
      const CompanyFinancials = (await import("~/@/components/ui/companyFinancials")).default;
      expect(CompanyFinancials).toBeDefined();
    });

    it("should allow importing CompanyFinancialsPlaceholder as named export", async () => {
      const { CompanyFinancialsPlaceholder } = await import("~/@/components/ui/companyFinancials");
      expect(CompanyFinancialsPlaceholder).toBeDefined();
    });
  });
});

