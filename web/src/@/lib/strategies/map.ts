// StrategyService response -> plain rows (./types.ts).
//
// TYPE-ONLY imports from the generated module: this file is erased of every
// protobuf reference at compile time, so importing it never pulls the
// descriptor or the protobuf runtime into a bundle. The server actions call
// it; nothing else needs to.
//
// This is the ONE place proto3's "0 means missing" is resolved. Fields with a
// has_* flag honour it, so a measured zero survives (flat growth, a stock
// exactly in line with the index, an ASIC row reporting no position); fields
// without one are nulled where 0 is not a real value (a pivot, a base length,
// a volume multiple).

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

export function mapPick(pick: StrategyPick): PickRow {
  const rules = pick.rules ?? [];
  return {
    rank: pick.rank,
    code: pick.stockCode,
    name: pick.companyName,
    industry: pick.industry,
    status: toPickStatus(pick.status),
    score: finiteOrNull(pick.score) ?? 0,
    rules: rules.map(mapRuleResult),
    close: pick.hasClose ? positiveOrNull(pick.close) : null,
    asOf: pick.asOf,
    pivot: positiveOrNull(pick.pivot),
    // A base needs at least one session, so length 0 means no base was read,
    // and its depth is then meaningless too.
    baseDepthPct: pick.baseLengthDays > 0 ? finiteOrNull(pick.baseDepthPct) : null,
    baseLengthDays: pick.baseLengthDays > 0 ? pick.baseLengthDays : null,
    volumeRatio: positiveOrNull(pick.volumeRatio50d),
    revenueYoyPct: pick.hasRevenueYoy ? finiteOrNull(pick.revenueYoyPct) : null,
    epsYoyPct: pick.hasEpsYoy ? finiteOrNull(pick.epsYoyPct) : null,
    rs3mPct: pick.hasRs3mPct ? finiteOrNull(pick.rs3mPct) : null,
    shortPct: pick.hasShortPct ? finiteOrNull(pick.shortPct) : null,
    // A reported market cap of 0 is not a company size; treat it as unknown.
    marketCap: pick.hasMarketCap ? positiveOrNull(pick.marketCap) : null,
    logoUrl: pick.logoUrl,
  };
}
