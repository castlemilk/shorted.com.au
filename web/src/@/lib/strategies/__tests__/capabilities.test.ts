import {
  STRATEGY_CAPABILITIES,
  STRATEGY_CAPABILITY_NAMES,
  strategyCapabilityEnabled,
} from "~/@/lib/strategies/capabilities";

describe("strategy capability registry", () => {
  it("names the seven capabilities of the workspace", () => {
    expect([...STRATEGY_CAPABILITY_NAMES]).toEqual([
      "compare",
      "alertBuilder",
      "alertEnable",
      "alertEmail",
      "trackedEntries",
      "variants",
      "saves",
    ]);
  });

  it("holds every flag off until its capability ships, except saves, which ships with My strategies", () => {
    expect(Object.keys(STRATEGY_CAPABILITIES).sort()).toEqual(
      [...STRATEGY_CAPABILITY_NAMES].sort(),
    );
    for (const name of STRATEGY_CAPABILITY_NAMES) {
      const on = name === "saves";
      expect(STRATEGY_CAPABILITIES[name]).toBe(on);
      expect(strategyCapabilityEnabled(name)).toBe(on);
    }
  });
});
