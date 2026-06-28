import { describe, it, expect } from "@jest/globals";
import { featureFill } from "../choropleth-map";

describe("featureFill", () => {
  const color = (v: number) => (v > 100 ? "#f00" : "#0f0");
  it("returns the hatch sentinel when value is null/undefined", () => {
    expect(featureFill(null, color)).toBe("url(#nodata-hatch)");
    expect(featureFill(undefined, color)).toBe("url(#nodata-hatch)");
  });
  it("applies the colour scale to a real value", () => {
    expect(featureFill(150, color)).toBe("#f00");
    expect(featureFill(50, color)).toBe("#0f0");
  });
});
