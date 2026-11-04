// The ownership keys are pinned as strings. A renamed key would orphan the
// entries the flush has to reach, and a version bump is a decision that
// should show up in this file, never a side effect.
jest.mock("@upstash/redis", () => ({
  Redis: jest.fn().mockImplementation(() => ({
    get: jest.fn(),
    setex: jest.fn(),
    del: jest.fn(),
  })),
}));

import { CACHE_KEYS, OWNERSHIP_DATA_CACHE_PREFIXES } from "../kv-cache";

describe("ownership cache keys", () => {
  it("pins the v2 keys of the overview, one stock and one institution", () => {
    expect(CACHE_KEYS.ownershipOverview()).toBe("cache:ownership:overview:v2");
    expect(CACHE_KEYS.stockOwnership("BHP")).toBe("cache:ownership:stock:v2:BHP");
    expect(CACHE_KEYS.ownershipInstitution("blackrock")).toBe(
      "cache:ownership:institution:v2:blackrock",
    );
  });

  it("leaves the institutions list key as it was", () => {
    expect(CACHE_KEYS.ownershipInstitutions("", "", 200, 0)).toBe(
      "cache:ownership:institutions:all:-:200:0",
    );
    expect(CACHE_KEYS.ownershipInstitutions("investors", "vanguard", 50, 100)).toBe(
      "cache:ownership:institutions:investors:vanguard:50:100",
    );
  });

  it("pins the v1 keys of the explorer's default views, the notices feed and the registers table", () => {
    expect(CACHE_KEYS.ownershipNotices()).toBe("cache:ownership:notices:v1");
    expect(CACHE_KEYS.ownershipRegisters()).toBe("cache:ownership:registers:v1");
  });

  it("pins the keys of the desk's four default views (the map, the flows and the activity at v2 since spec 14.10 widened their rows)", () => {
    expect(CACHE_KEYS.ownershipDeskMap()).toBe("cache:ownership:desk-map:v2");
    expect(CACHE_KEYS.ownershipDeskFlows()).toBe("cache:ownership:desk-flows:v2");
    expect(CACHE_KEYS.ownershipDeskActivity()).toBe("cache:ownership:desk-activity:v2");
    expect(CACHE_KEYS.ownershipDeskFunds()).toBe("cache:ownership:desk-funds:v1");
  });

  it("takes no argument for any explorer or desk key, so no filter value can ever become a key", () => {
    expect(CACHE_KEYS.ownershipNotices).toHaveLength(0);
    expect(CACHE_KEYS.ownershipRegisters).toHaveLength(0);
    expect(CACHE_KEYS.ownershipDeskMap).toHaveLength(0);
    expect(CACHE_KEYS.ownershipDeskFlows).toHaveLength(0);
    expect(CACHE_KEYS.ownershipDeskActivity).toHaveLength(0);
    expect(CACHE_KEYS.ownershipDeskFunds).toHaveLength(0);
  });

  it("keeps every ownership key under the prefix the flush reaches", () => {
    expect(OWNERSHIP_DATA_CACHE_PREFIXES).toEqual(["cache:ownership:"]);
    const keys = [
      CACHE_KEYS.ownershipOverview(),
      CACHE_KEYS.ownershipInstitutions("", "", 200, 0),
      CACHE_KEYS.ownershipInstitution("blackrock"),
      CACHE_KEYS.stockOwnership("BHP"),
      CACHE_KEYS.ownershipNotices(),
      CACHE_KEYS.ownershipRegisters(),
      CACHE_KEYS.ownershipDeskMap(),
      CACHE_KEYS.ownershipDeskFlows(),
      CACHE_KEYS.ownershipDeskActivity(),
      CACHE_KEYS.ownershipDeskFunds(),
    ];
    for (const key of keys) {
      expect(key.startsWith("cache:ownership:")).toBe(true);
    }
  });
});
