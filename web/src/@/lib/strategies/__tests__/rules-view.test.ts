import {
  buildRuleParamRows,
  formatParamValue,
  ruleRoles,
  ruleWeightLabel,
} from "~/@/lib/strategies/rules-view";
import type { StrategyRuleDef } from "~/@/lib/strategies/types";

function rule(overrides: Partial<StrategyRuleDef> & { id: string }): StrategyRuleDef {
  return {
    title: "",
    ruleText: "The author's words, never shown here.",
    evaluation: "Our test, never shown here.",
    core: false,
    dataSource: "stock_prices",
    ...overrides,
  };
}

describe("rule parameter rows", () => {
  it("prints whole numbers bare and other values to four places", () => {
    expect(formatParamValue(5)).toBe("5");
    expect(formatParamValue(0.8)).toBe("0.8");
    expect(formatParamValue(1 / 3)).toBe("0.3333");
    expect(formatParamValue(Number.NaN)).toBe("");
  });

  it("states the role and the weight of each rule", () => {
    expect(ruleRoles({ core: true, trigger: true })).toEqual(["Core", "Trigger"]);
    expect(ruleRoles({ core: false, trigger: false })).toEqual(["Non-core"]);
    expect(ruleWeightLabel({ weight: 0.2 })).toBe("20%");
    expect(ruleWeightLabel({ weight: 0.125 })).toBe("12.5%");
    expect(ruleWeightLabel({ weight: 0 })).toBe("0%");
    expect(ruleWeightLabel({ weight: Number.NaN })).toBe("");
  });

  it("gives every rule the version names a row in the version's order, with its own parameters", () => {
    const rows = buildRuleParamRows(
      [
        rule({ id: "short_interest", title: "Short crowding" }),
        rule({ id: "breakout", title: "Breakout" }),
        rule({ id: "dropped_from_version", title: "Not in this version" }),
      ],
      [
        { ruleId: "short_interest", core: true, trigger: false, weight: 0.3 },
        { ruleId: "breakout", core: true, trigger: true, weight: 0.2 },
        { ruleId: "liquidity", core: true, trigger: false, weight: 0 },
      ],
      [
        { ruleId: "breakout", name: "volume_multiple", value: 1.5 },
        { ruleId: "short_interest", name: "min_pct", value: 5 },
        { ruleId: "breakout", name: "window", value: 5 },
      ],
    );
    expect(rows.map((row) => row.ruleId)).toEqual(["short_interest", "breakout", "liquidity"]);
    expect(rows[0]).toEqual({
      ruleId: "short_interest",
      title: "Short crowding",
      roles: ["Core"],
      weight: "30%",
      params: [{ name: "min_pct", value: "5" }],
    });
    expect(rows[1]?.params).toEqual([
      { name: "volume_multiple", value: "1.5" },
      { name: "window", value: "5" },
    ]);
    expect(rows[1]?.roles).toEqual(["Core", "Trigger"]);
    expect(rows[2]).toEqual(
      expect.objectContaining({ title: "liquidity", weight: "0%", params: [] }),
    );
    expect(rows.map((row) => row.title)).not.toContain("Not in this version");
  });

  it("keeps a parameter whose rule the strategy does not list, titled by its id", () => {
    const rows = buildRuleParamRows([], [], [{ ruleId: "orphan", name: "min_pct", value: 2 }]);
    expect(rows).toEqual([
      { ruleId: "orphan", title: "orphan", roles: [], weight: "", params: [{ name: "min_pct", value: "2" }] },
    ]);
  });
});
