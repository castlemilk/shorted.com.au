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
    expect(ruleRoles({ core: false })).toEqual(["Non-core"]);
    expect(ruleWeightLabel({ core: true, weight: 0.2 })).toBe("20%");
    expect(ruleWeightLabel({ core: true, weight: 0.125 })).toBe("12.5%");
    expect(ruleWeightLabel({ core: false, weight: 0 })).toBe("Off");
    expect(ruleWeightLabel({ core: true, weight: 0 })).toBe("0%");
    expect(ruleWeightLabel({ core: true, weight: undefined })).toBe("");
  });

  it("gives every listed rule a row in the strategy's order, with its own parameters", () => {
    const rows = buildRuleParamRows(
      [
        rule({ id: "short_interest", title: "Short crowding", core: true, weight: 0.3 }),
        rule({ id: "breakout", title: "Breakout", core: true, trigger: true, weight: 0.2 }),
        rule({ id: "liquidity", core: true, weight: 0 }),
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
    expect(rows[2]).toEqual(expect.objectContaining({ title: "liquidity", params: [] }));
  });

  it("keeps a parameter whose rule the strategy does not list, titled by its id", () => {
    const rows = buildRuleParamRows([], [{ ruleId: "orphan", name: "min_pct", value: 2 }]);
    expect(rows).toEqual([
      { ruleId: "orphan", title: "orphan", roles: [], weight: "", params: [{ name: "min_pct", value: "2" }] },
    ]);
  });
});
