import {
  STRATEGY_CAPABILITIES,
  STRATEGY_CAPABILITY_NAMES,
  strategyCapabilityEnabled,
} from "~/@/lib/strategies/capabilities";

describe("strategy capability registry", () => {
  it("names the six capabilities of the workspace", () => {
    expect([...STRATEGY_CAPABILITY_NAMES]).toEqual([
      "compare",
      "alertBuilder",
      "alertEnable",
      "alertEmail",
      "trackedEntries",
      "variants",
    ]);
  });

  it("holds every flag off until its capability ships", () => {
    expect(Object.keys(STRATEGY_CAPABILITIES).sort()).toEqual(
      [...STRATEGY_CAPABILITY_NAMES].sort(),
    );
    for (const name of STRATEGY_CAPABILITY_NAMES) {
      expect(STRATEGY_CAPABILITIES[name]).toBe(false);
      expect(strategyCapabilityEnabled(name)).toBe(false);
    }
  });
});
