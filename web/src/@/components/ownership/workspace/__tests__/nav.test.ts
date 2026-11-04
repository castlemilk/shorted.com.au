/// <reference types="jest" />

import { OWNERSHIP_TABS, activeOwnershipTab } from "../nav";

describe("ownership workspace nav (spec 14.1)", () => {
  it("lists the seven pages in the wireframes' order", () => {
    expect(OWNERSHIP_TABS.map((t) => t.label)).toEqual([
      "Overview",
      "Market map",
      "Connections",
      "Activity",
      "Funds",
      "Holders",
      "Changes",
    ]);
  });

  it("makes Overview active only on its own path", () => {
    expect(activeOwnershipTab("/ownership")).toBe("overview");
    expect(activeOwnershipTab("/ownership/")).toBe("overview");
    expect(activeOwnershipTab("/ownership/map")).toBe("map");
  });

  it("keeps a tab active for the pages nested under it", () => {
    expect(activeOwnershipTab("/ownership/funds/A200")).toBe("funds");
    expect(activeOwnershipTab("/ownership/holders/vanguard")).toBe("holders");
  });

  it("has no active tab outside the workspace", () => {
    expect(activeOwnershipTab("/ownership/vanguard")).toBeNull();
    expect(activeOwnershipTab("/ownership/stocks/BHP")).toBeNull();
    expect(activeOwnershipTab("/shorts/BHP")).toBeNull();
  });

  it("does not match a page that only shares a prefix", () => {
    expect(activeOwnershipTab("/ownership/mapping")).toBeNull();
  });
});
