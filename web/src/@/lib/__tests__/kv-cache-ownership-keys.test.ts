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

  it("keeps every ownership key under the prefix the flush reaches", () => {
    expect(OWNERSHIP_DATA_CACHE_PREFIXES).toEqual(["cache:ownership:"]);
    const keys = [
      CACHE_KEYS.ownershipOverview(),
      CACHE_KEYS.ownershipInstitutions("", "", 200, 0),
      CACHE_KEYS.ownershipInstitution("blackrock"),
      CACHE_KEYS.stockOwnership("BHP"),
    ];
    for (const key of keys) {
      expect(key.startsWith("cache:ownership:")).toBe(true);
    }
  });
});
