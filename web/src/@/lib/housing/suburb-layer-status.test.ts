import { describe, it, expect } from "@jest/globals";
import { suburbLayerStatus } from "./suburb-layer-status";

describe("suburbLayerStatus", () => {
  it("shows no overlay on the national view (no state active)", () => {
    expect(suburbLayerStatus(null, false, false)).toBe("national");
    expect(suburbLayerStatus(null, false, true)).toBe("national");
  });

  it("is ready once a state's suburbs are built", () => {
    expect(suburbLayerStatus("NSW", true, false)).toBe("ready");
    // a background refetch while data is already shown stays 'ready' (no overlay)
    expect(suburbLayerStatus("NSW", true, true)).toBe("ready");
  });

  it("shows loading while a fetch is in flight and suburbs aren't ready", () => {
    expect(suburbLayerStatus("NSW", false, true)).toBe("loading");
  });

  it("shows error (retry) when settled with no suburbs and nothing in flight", () => {
    // e.g. listStateSuburbs rejected (swallowed -> undefined) or the boundary
    // fetch failed: active, no suburb, not busy.
    expect(suburbLayerStatus("VIC", false, false)).toBe("error");
  });
});
