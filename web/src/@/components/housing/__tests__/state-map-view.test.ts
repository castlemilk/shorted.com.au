import { describe, it, expect } from "@jest/globals";
import { viewSearchParams, type MapView } from "../state-suburb-map";

const base: MapView = {
  level: "suburb", metricKey: "price", councilMetricKey: "population", overlays: [],
  councilBorders: false, defaultMetric: "price",
};
const qs = (view: Partial<MapView>, from = "") =>
  viewSearchParams({ ...base, ...view }, new URLSearchParams(from)).toString();

describe("state map URL sync", () => {
  it("keeps the canonical URL clean at the defaults", () => {
    expect(qs({})).toBe("");
    expect(qs({ level: "council" })).toBe("level=council");
  });

  it("writes ?level=council&metric=<council key> at council level", () => {
    expect(qs({ level: "council", councilMetricKey: "population_growth" })).toBe("level=council&metric=population_growth");
  });

  it("switching back to suburbs drops the council params and restores the suburb metric", () => {
    const council = qs({ level: "council", councilMetricKey: "density" });
    expect(qs({ level: "suburb", metricKey: "income" }, council)).toBe("metric=income");
  });

  it("council borders are a suburb-level toggle, implied at council level", () => {
    expect(qs({ councilBorders: true })).toBe("boundaries=councils");
    expect(qs({ level: "council", councilBorders: true })).toBe("level=council");
  });

  it("keeps unrelated params (?sal=) and overlays", () => {
    expect(qs({ overlays: ["flood_planning"] }, "sal=12166")).toBe("sal=12166&overlays=flood_planning");
  });
});
