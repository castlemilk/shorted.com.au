// The Rules tab's view of one rules version: each rule with the numeric
// parameters the version tests it with, its role in the ladder and its share of
// the score. Pure, so the table is tested without React.
//
// The roles and weights come from the version itself (its canonical spec); the
// catalogue supplies only the rule titles. The rule's wording (ruleText,
// evaluation) is the Overview's and is never read here.

import type {
  RuleParamView,
  RuleSettingView,
  StrategyRuleDef,
} from "./types";

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
  /** The share of the score as "20%", "0%" for a rule that carries none, "" when unknown. */
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
export function ruleRoles(rule: Pick<RuleSettingView, "core" | "trigger">): string[] {
  const roles = [rule.core ? "Core" : "Non-core"];
  if (rule.trigger) roles.push("Trigger");
  return roles;
}

/** A rule's weight as a share of the score, as a percentage. */
export function ruleWeightLabel(rule: Pick<RuleSettingView, "weight">): string {
  if (rule.weight === undefined || !Number.isFinite(rule.weight)) return "";
  return `${formatParamValue(Number((rule.weight * 100).toFixed(4)))}%`;
}

/**
 * One row per rule the version names, in the version's rule order, with the
 * version's parameters for it in their stated order. The title comes from the
 * catalogue by rule id, or the id when the catalogue has none. A parameter whose
 * rule the version does not list still gets a row (titled by its id), so no
 * parameter is dropped.
 */
export function buildRuleParamRows(
  titles: readonly Pick<StrategyRuleDef, "id" | "title">[],
  settings: readonly RuleSettingView[],
  params: readonly RuleParamView[],
): RuleParamRow[] {
  const byRule = new Map<string, RuleParamLine[]>();
  for (const param of params) {
    const lines = byRule.get(param.ruleId) ?? [];
    lines.push({ name: param.name, value: formatParamValue(param.value) });
    byRule.set(param.ruleId, lines);
  }

  const titleOf = new Map(titles.map((rule) => [rule.id, rule.title]));
  const rows: RuleParamRow[] = settings.map((setting) => {
    const title = titleOf.get(setting.ruleId);
    return {
      ruleId: setting.ruleId,
      title: title ? title : setting.ruleId,
      roles: ruleRoles(setting),
      weight: ruleWeightLabel(setting),
      params: byRule.get(setting.ruleId) ?? [],
    };
  });
  const listed = new Set(settings.map((setting) => setting.ruleId));
  for (const [ruleId, lines] of byRule) {
    if (listed.has(ruleId)) continue;
    rows.push({ ruleId, title: ruleId, roles: [], weight: "", params: lines });
  }
  return rows;
}
