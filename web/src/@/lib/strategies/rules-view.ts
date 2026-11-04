// The Rules tab's view of one rules version: each rule with the numeric
// parameters the version tests it with, its role in the ladder and its share of
// the score. Pure, so the table is tested without React.
//
// The rule's wording (ruleText, evaluation) is the Overview's and is never read
// here: this module states numbers and roles only.

import type { RuleParamView, StrategyRuleDef } from "./types";

export interface RuleParamLine {
  name: string;
  value: string;
}

export interface RuleParamRow {
  ruleId: string;
  /** The rule's title, or its id when the registry names none. */
  title: string;
  /** "Core", "Non-core", with "Trigger" added for a trigger rule. */
  roles: string[];
  /** The share of the score as "20%", "Off" for a non-core rule at weight 0, "" when unknown. */
  weight: string;
  params: RuleParamLine[];
}

/** A parameter value as the table prints it: whole numbers bare, others to four places at most. */
export function formatParamValue(value: number): string {
  if (!Number.isFinite(value)) return "";
  if (Number.isInteger(value)) return String(value);
  return String(Number(value.toFixed(4)));
}

/** The rule's role words, in ladder order. */
export function ruleRoles(rule: Pick<StrategyRuleDef, "core" | "trigger">): string[] {
  const roles = [rule.core ? "Core" : "Non-core"];
  if (rule.trigger) roles.push("Trigger");
  return roles;
}

/**
 * A rule's weight as a share of the score. A non-core rule at weight 0 is
 * switched off (the evaluator skips it), so it reads "Off", never "0%".
 */
export function ruleWeightLabel(
  rule: Pick<StrategyRuleDef, "core" | "weight">,
): string {
  if (rule.weight === undefined || !Number.isFinite(rule.weight)) return "";
  if (rule.weight <= 0) return rule.core ? "0%" : "Off";
  return `${formatParamValue(Number((rule.weight * 100).toFixed(4)))}%`;
}

/**
 * One row per rule, in the strategy's rule order, with the version's parameters
 * for it in their stated order. A parameter whose rule the strategy does not
 * list still gets a row (titled by its id), so no parameter is dropped.
 */
export function buildRuleParamRows(
  rules: readonly StrategyRuleDef[],
  params: readonly RuleParamView[],
): RuleParamRow[] {
  const byRule = new Map<string, RuleParamLine[]>();
  for (const param of params) {
    const lines = byRule.get(param.ruleId) ?? [];
    lines.push({ name: param.name, value: formatParamValue(param.value) });
    byRule.set(param.ruleId, lines);
  }

  const rows: RuleParamRow[] = rules.map((rule) => ({
    ruleId: rule.id,
    title: rule.title || rule.id,
    roles: ruleRoles(rule),
    weight: ruleWeightLabel(rule),
    params: byRule.get(rule.id) ?? [],
  }));
  const listed = new Set(rules.map((rule) => rule.id));
  for (const [ruleId, lines] of byRule) {
    if (listed.has(ruleId)) continue;
    rows.push({ ruleId, title: ruleId, roles: [], weight: "", params: lines });
  }
  return rows;
}
