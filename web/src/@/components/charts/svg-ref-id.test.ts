/// <reference types="jest" />

import { svgRefId } from "./chart-primitives";

/**
 * Regression guard for a bug that shipped: a suburb's region code is
 * "SUBURB:NSW-BONDI BEACH", and the colon and space both terminate the
 * reference inside url(#…). The gradient never resolved, the area fell back to
 * rgb(0,0,0), and every priced suburb page rendered a solid black chart.
 */
describe("svgRefId", () => {
  it("strips the characters that break url(#id)", () => {
    expect(svgRefId("housing-SUBURB:NSW-BONDI BEACH-median_price")).toBe(
      "housing-SUBURB-NSW-BONDI-BEACH-median_price",
    );
  });

  it("leaves an already-safe id untouched", () => {
    expect(svgRefId("nodata-hatch")).toBe("nodata-hatch");
    expect(svgRefId("stock_BHP-grad-0")).toBe("stock_BHP-grad-0");
  });

  it("handles the other separators that appear in domain identifiers", () => {
    expect(svgRefId("a.b/c#d?e=f")).toBe("a-b-c-d-e-f");
    // Sanitising leaves a leading dash, so the identifier prefix then applies.
    expect(svgRefId("Ω régionö")).toBe("id---r-gion-");
  });

  it("prefixes ids that would not be valid CSS identifiers", () => {
    expect(svgRefId("2024-series")).toBe("id-2024-series");
    expect(svgRefId("-leading-dash")).toBe("id--leading-dash");
  });
});
