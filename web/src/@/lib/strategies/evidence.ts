// The evidence the Signals tab prints for one stock: the one-line headline, the
// reason an unknown rule could not be tested, a rule's measure against its
// threshold, and the reading of a stock the signals list does not hold.
//
// Pure, so every line of copy is unit-tested without React. Nothing here reads
// a colour: rule outcomes are drawn by the components from the status word.

import { formatDate } from "~/@/lib/fundamentals/format";
import { formatSigned } from "~/@/lib/strategies/format";
import type {
  PickRow,
  RuleResultRow,
  StrategyRuleDef,
} from "~/@/lib/strategies/types";
import type {
  StockStrategyFit,
  StockStrategyFitRow,
} from "~/app/actions/getStockStrategyFit";

/** The reason codes a rule result can carry (6.3), with the copy the page prints. */
export const REASON_TEXT: Readonly<Record<string, string>> = {
  no_price_history: "Not enough price history yet",
  no_volume: "Too few traded sessions to measure volume",
  no_index: "No index level to compare against",
  asic_report_stale: "No ASIC report within 8 sessions",
  asic_value_missing: "Value missing in ASIC's report",
  basis_change: "Share basis changed after the report",
  no_fundamentals: "No reported fundamentals",
  not_meaningful: "Not meaningful for this company",
};

/** Copy for a reason code; an unlisted code reads as a plain sentence, never a raw id. */
export function reasonText(reason: string | undefined | null): string {
  const code = (reason ?? "").trim();
  if (!code) return "";
  const known = REASON_TEXT[code];
  if (known) return known;
  const words = code.replace(/[_-]+/g, " ").trim().toLowerCase();
  return words.charAt(0).toUpperCase() + words.slice(1);
}

/** Why a stock the API did not evaluate is not read, as the stock page words it. */
export const INELIGIBLE_TEXT: Readonly<Record<string, string>> = {
  short_history: "not enough trading history to read its signals",
};

/** "3 Nov 2026" becomes "3 Nov"; "" when the date is not a real day. */
export function shortDayLabel(iso: string | null | undefined): string {
  if (!iso) return "";
  return formatDate(iso).replace(/\s\d{4}$/, "");
}

type RuleRef = Pick<StrategyRuleDef, "id" | "title" | "core"> & {
  trigger?: boolean;
};

function ruleTitle(rules: readonly RuleRef[], id: string): string {
  return rules.find((rule) => rule.id === id)?.title ?? id;
}

/**
 * The headline of one row's evidence, by its status (6.3):
 * triggered names the breakout session, setup names the trigger it waits for,
 * unknown names the rule that cannot be tested and why, watch names the first
 * core rule that fails.
 */
export function evidenceHeadline(
  pick: Pick<PickRow, "status" | "rules" | "breakoutDate" | "asOf">,
  rules: readonly RuleRef[],
): string {
  if (pick.status === "triggered") {
    const day = shortDayLabel(pick.breakoutDate) || shortDayLabel(pick.asOf);
    return day ? `Triggered on ${day}` : "Triggered";
  }
  if (pick.status === "setup") {
    const waiting = pick.rules.find(
      (result) => result.waiting === true || isFailingTrigger(result, rules),
    );
    if (waiting) {
      return `Waiting for ${ruleTitle(rules, waiting.ruleId).toLowerCase()}`;
    }
    return "Waiting for the trigger rule";
  }
  // An unknown status arrives with the v1 ladder; the API does not send it
  // before then, and the copy is ready for it without widening the shared
  // status type here.
  if ((pick.status as string) === "unknown") {
    const unknown = firstCore(
      pick.rules,
      rules,
      (result) => result.status === "unknown",
    );
    if (unknown) {
      const why = reasonText(unknown.reason);
      const title = ruleTitle(rules, unknown.ruleId);
      return why
        ? `${title} cannot be tested: ${why}`
        : `${title} cannot be tested`;
    }
    return "A rule cannot be tested";
  }
  const failing = firstCore(
    pick.rules,
    rules,
    (result) => result.status === "fail",
  );
  return failing
    ? `${ruleTitle(rules, failing.ruleId)} fails`
    : "Not yet triggered";
}

function isFailingTrigger(
  result: RuleResultRow,
  rules: readonly RuleRef[],
): boolean {
  const rule = rules.find((r) => r.id === result.ruleId);
  return rule?.trigger === true && result.status === "fail";
}

function firstCore(
  results: readonly RuleResultRow[],
  rules: readonly RuleRef[],
  match: (result: RuleResultRow) => boolean,
): RuleResultRow | undefined {
  return results.find((result) => {
    const rule = rules.find((r) => r.id === result.ruleId);
    return rule?.core === true && match(result);
  });
}

const COMPARATOR_SYMBOL: Readonly<Record<string, string>> = {
  ">=": "≥",
  "<=": "≤",
  ">": ">",
};

/** A.$ amount as the picker's liquidity figure reads: "A$63.5m", "A$250k". */
function audAmount(value: number): string {
  const abs = Math.abs(value);
  if (abs >= 1_000_000) return `A$${(value / 1_000_000).toFixed(1)}m`;
  if (abs >= 1_000) return `A$${Math.round(value / 1_000)}k`;
  return `A$${Math.round(value)}`;
}

/** One figure in its rule's unit. Units are the definition's, never guessed. */
export function formatRuleFigure(value: number, unit: string): string {
  switch (unit) {
    case "pct":
      return `${value.toFixed(1)}%`;
    case "pp":
      return formatSigned(value, "pp");
    case "aud":
      return audAmount(value);
    case "days":
      return `${value.toFixed(1)} days`;
    case "x":
      return `${value.toFixed(1)}×`;
    default:
      return Number(value.toFixed(1)).toString();
  }
}

/**
 * The measured value against the rule's threshold: "10.0% ≥ 5%". Null when the
 * value or the threshold is not known, so the caller prints the rule's detail.
 */
export function formatRuleMeasure(
  rule: Pick<StrategyRuleDef, "threshold" | "unit" | "comparator">,
  result: Pick<RuleResultRow, "value"> | undefined,
): string | null {
  if (result?.value === undefined || rule.threshold === undefined) {
    return null;
  }
  const symbol = COMPARATOR_SYMBOL[rule.comparator ?? ""];
  if (!symbol) return null;
  const unit = rule.unit ?? "";
  return `${formatRuleFigure(result.value, unit)} ${symbol} ${formatRuleFigure(rule.threshold, unit)}`;
}

/**
 * The copy for a stock the strategy did not read on the session (its own
 * "Not evaluated" line), or null when the stock was read.
 */
export function notEvaluatedCopy(
  fit: Pick<
    StockStrategyFit,
    "eligible" | "ineligibleReason" | "sessionDate" | "asOf"
  >,
): string | null {
  if (fit.eligible !== false) return null;
  const date = shortDayLabel(fit.sessionDate) || shortDayLabel(fit.asOf);
  const why =
    INELIGIBLE_TEXT[fit.ineligibleReason ?? ""] ??
    (fit.ineligibleReason
      ? reasonText(fit.ineligibleReason).toLowerCase()
      : "");
  const lead = date ? `Not evaluated on ${date}` : "Not evaluated";
  return why ? `${lead}: ${why}.` : `${lead}.`;
}

/**
 * A pick row built from one stock's fit, for a stock outside the list the page
 * holds (the `?sel=stock:` deep link). The fit carries the status, the rules
 * and the price features; the figures it does not carry stay null. Null when
 * the fit does not place the stock in this strategy at all.
 */
export function pickFromStockFit(
  fit: StockStrategyFit,
  strategyId: string,
): PickRow | null {
  const row: StockStrategyFitRow | undefined = fit.fits.find(
    (f) => f.strategyId === strategyId,
  );
  if (!row || row.status === "none") return null;
  const pf = fit.priceFeatures;
  return {
    rank: row.rank ?? 0,
    code: fit.stockCode,
    name: "",
    industry: "",
    status: row.status,
    score: row.score ?? 0,
    rules: row.rules,
    close: pf?.close ?? null,
    asOf: pf?.asOf ? pf.asOf : fit.asOf,
    pivot: pf?.baseHigh ?? null,
    baseDepthPct: pf?.baseDepthPct ?? null,
    baseLengthDays: pf?.baseLengthDays ?? null,
    volumeRatio: pf?.volumeRatio50d ?? null,
    revenueYoyPct: null,
    epsYoyPct: null,
    rs3mPct: pf?.rs3mPct ?? null,
    shortPct: null,
    marketCap: null,
    logoUrl: "",
    breakoutDate: pf?.breakoutDate ?? undefined,
    shortReportDate: fit.shortReportDate,
    shortAvailableDate: fit.shortAvailableDate,
  };
}
