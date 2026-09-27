// StrategyService response -> plain rows (./types.ts).
//
// TYPE-ONLY imports from the generated module: this file is erased of every
// protobuf reference at compile time, so importing it never pulls the
// descriptor or the protobuf runtime into a bundle. The server actions call
// it; nothing else needs to.
//
// This is the ONE place proto3's "0 means missing" is resolved. Fields with a
// has_* flag honour it; fields without one are nulled where 0 is not a real
// value (a price, a pivot, a base length, a volume multiple) and, for the
// 3-month relative strength, the rs rule's own has_value decides when the
// strategy carries that rule.

import type {
  MarketRegime,
  RuleResult,
  Strategy,
  StrategyPick,
} from "~/gen/shorts/v1alpha1/strategies_pb";
import type {
  MarketRegimeView,
  PickRow,
  PickStatus,
  RegimeLabel,
  RuleResultRow,
  RuleStatus,
  StrategyDef,
} from "./types";

function positiveOrNull(value: number | undefined): number | null {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? value
    : null;
}

function finiteOrNull(value: number | undefined): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function toRuleStatus(value: string): RuleStatus {
  return value === "pass" || value === "fail" ? value : "unknown";
}

function toPickStatus(value: string): PickStatus {
  return value === "triggered" || value === "setup" ? value : "watch";
}

function toRegimeLabel(value: string): RegimeLabel {
  return value === "uptrend" || value === "neutral" || value === "downtrend"
    ? value
    : "";
}

export function mapStrategy(strategy: Strategy): StrategyDef {
  const metadata = strategy.metadata;
  return {
    id: strategy.id,
    name: strategy.name,
    author: strategy.author,
    tagline: strategy.tagline,
    descriptionParagraphs: [...(strategy.descriptionParagraphs ?? [])],
    rules: (strategy.rules ?? []).map((rule) => ({
      id: rule.id,
      title: rule.title,
      ruleText: rule.ruleText,
      evaluation: rule.evaluation,
      core: rule.core,
      dataSource: rule.dataSource,
    })),
    metadata: metadata
      ? {
          style: metadata.style,
          holdingPeriod: metadata.holdingPeriod,
          riskPosture: metadata.riskPosture,
          universe: metadata.universe,
          refreshCadence: metadata.refreshCadence,
          ruleCount: metadata.ruleCount || (strategy.rules ?? []).length,
        }
      : null,
    caveats: [...(strategy.caveats ?? [])],
    sources: [...(strategy.sources ?? [])],
  };
}

export function mapRegime(regime: MarketRegime | undefined): MarketRegimeView | null {
  if (!regime) return null;
  const label = toRegimeLabel(regime.regime);
  return {
    indexCode: regime.indexCode || "XJO",
    asOf: regime.asOf,
    regime: label,
    // An unreadable regime carries zeros; none of them is a real level.
    close: label ? positiveOrNull(regime.close) : null,
    sma50: label ? positiveOrNull(regime.sma50) : null,
    sma200: label ? positiveOrNull(regime.sma200) : null,
    pctOff52wHigh: label ? finiteOrNull(regime.pctOff52wHigh) : null,
    verdict: regime.verdict,
  };
}

function mapRuleResult(result: RuleResult): RuleResultRow {
  return {
    ruleId: result.ruleId,
    status: toRuleStatus(result.status),
    detail: result.detail,
  };
}

/** Rule ids whose value IS the 3-month relative strength (plan §1). */
const RS_3M_RULE_IDS = new Set(["rs"]);

export function mapPick(pick: StrategyPick): PickRow {
  const rules = pick.rules ?? [];
  const rsRule = rules.find((rule) => RS_3M_RULE_IDS.has(rule.ruleId));
  // Without an rs rule there is no flag to consult, and an exact 0.0-point
  // lead over the index is far less likely than a missing value.
  const hasRs3m = rsRule ? rsRule.hasValue : pick.rs3mPct !== 0;
  return {
    rank: pick.rank,
    code: pick.stockCode,
    name: pick.companyName,
    industry: pick.industry,
    status: toPickStatus(pick.status),
    score: finiteOrNull(pick.score) ?? 0,
    rules: rules.map(mapRuleResult),
    close: positiveOrNull(pick.close),
    asOf: pick.asOf,
    pivot: positiveOrNull(pick.pivot),
    // A base needs at least one session, so length 0 means no base was read,
    // and its depth is then meaningless too.
    baseDepthPct: pick.baseLengthDays > 0 ? finiteOrNull(pick.baseDepthPct) : null,
    baseLengthDays: pick.baseLengthDays > 0 ? pick.baseLengthDays : null,
    volumeRatio: positiveOrNull(pick.volumeRatio50d),
    revenueYoyPct: pick.hasRevenueYoy ? finiteOrNull(pick.revenueYoyPct) : null,
    epsYoyPct: pick.hasEpsYoy ? finiteOrNull(pick.epsYoyPct) : null,
    rs3mPct: hasRs3m ? finiteOrNull(pick.rs3mPct) : null,
    // 0 means no reported ASIC short position (proto contract).
    shortPct: positiveOrNull(pick.shortPct),
    marketCap: positiveOrNull(pick.marketCap),
    logoUrl: pick.logoUrl,
  };
}
