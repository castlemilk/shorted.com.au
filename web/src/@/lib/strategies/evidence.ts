// The evidence the Signals tab prints for one stock: the one-line headline, the
// reason an unknown rule could not be tested, a rule's measure against its
// threshold, and the reading of a stock the signals list does not hold.
//
// Pure, so every line of copy is unit-tested without React. Nothing here reads
// a colour: rule outcomes are drawn by the components from the status word.

import { formatDate } from "~/@/lib/fundamentals/format";
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
  no_bar_on_session: "no trade on the session",
  exchange_traded_product: "an exchange-traded product",
  debt_or_hybrid: "a debt or hybrid security",
  secondary_line: "a secondary line of the company",
  corporate_action_guard:
    "a possible unadjusted share consolidation or split is recent",
  not_in_asic_report: "not in ASIC's latest complete short report",
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
  // An unknown status is served under the v1 ladder: a core rule cannot be tested.
  if (pick.status === "unknown") {
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

const MINUS = "−";

const COMPARATOR_SYMBOL: Readonly<Record<string, string>> = {
  ">=": "≥",
  "<=": "≤",
  ">": ">",
};

/** The symbol that prints the comparison when it does not hold. */
const NEGATED_SYMBOL: Readonly<Record<string, string>> = {
  ">=": "<",
  "<=": ">",
  ">": "≤",
};

/** The comparison as a predicate on two numbers; null for an operator not listed. */
function comparisonHolds(
  value: number,
  comparator: string,
  threshold: number,
): boolean | null {
  switch (comparator) {
    case ">=":
      return value >= threshold;
    case "<=":
      return value <= threshold;
    case ">":
      return value > threshold;
    default:
      return null;
  }
}

interface FigureUnit {
  /** The value is divided by this to get the number printed. */
  div: number;
  prefix: string;
  suffix: string;
  /** Decimals printed for the scaled number. */
  decimals: number;
  /** A "+" on a positive figure (signed rule units). */
  signed: boolean;
}

/** How a figure in a rule's unit is scaled and written; A$ amounts pick m or k by size. */
function figureUnit(value: number, unit: string): FigureUnit {
  switch (unit) {
    case "pct":
      return { div: 1, prefix: "", suffix: "%", decimals: 1, signed: false };
    case "pp":
      return { div: 1, prefix: "", suffix: "pp", decimals: 1, signed: true };
    case "aud": {
      const abs = Math.abs(value);
      if (abs >= 1_000_000)
        return {
          div: 1_000_000,
          prefix: "A$",
          suffix: "m",
          decimals: 1,
          signed: false,
        };
      if (abs >= 1_000)
        return {
          div: 1_000,
          prefix: "A$",
          suffix: "k",
          decimals: 0,
          signed: false,
        };
      return { div: 1, prefix: "A$", suffix: "", decimals: 0, signed: false };
    }
    case "days":
      return {
        div: 1,
        prefix: "",
        suffix: " days",
        decimals: 1,
        signed: false,
      };
    case "x":
      return { div: 1, prefix: "", suffix: "×", decimals: 1, signed: false };
    default:
      return { div: 1, prefix: "", suffix: "", decimals: 1, signed: false };
  }
}

/** The number written at `decimals` places, with the unit's prefix, suffix and sign. */
function writeFigure(num: number, meta: FigureUnit, decimals: number): string {
  const body = Math.abs(num).toFixed(decimals);
  const zero = Number(body) === 0;
  const sign = num < 0 && !zero ? MINUS : meta.signed && !zero ? "+" : "";
  return `${sign}${meta.prefix}${body}${meta.suffix}`;
}

/**
 * A figure written so that the printed pair keeps the outcome it had. Rounding
 * to the nearest place can carry a failing 4.96 to "5.0" against a 5.0 cut-off,
 * so each candidate (nearest, then down, then up) is taken only when comparing
 * the printed numbers gives the outcome the true numbers give. The places grow
 * until one does (a value a hair under a cut-off prints one more digit).
 */
function figureAgreeing(
  value: number,
  unit: string,
  comparator: string,
  threshold: number,
  holds: boolean,
): string {
  const meta = figureUnit(value, unit);
  for (let extra = 0; extra <= 3; extra++) {
    const decimals = meta.decimals + extra;
    const factor = 10 ** decimals;
    const scaled = Math.round((value / meta.div) * factor * 1e6) / 1e6;
    const candidates = [
      Math.round(scaled),
      Math.floor(scaled),
      Math.ceil(scaled),
    ];
    for (const rounded of candidates) {
      const printed = rounded / factor;
      const printedValue = printed * meta.div;
      if (comparisonHolds(printedValue, comparator, threshold) === holds) {
        return writeFigure(printed, meta, decimals);
      }
    }
  }
  return writeFigure(value / meta.div, meta, meta.decimals);
}

/** One figure in its rule's unit. Units are the definition's, never guessed. */
export function formatRuleFigure(value: number, unit: string): string {
  const meta = figureUnit(value, unit);
  return writeFigure(value / meta.div, meta, meta.decimals);
}

/**
 * The measured value against the rule's threshold: "10.0% ≥ 5.0%" when the
 * comparison holds, "−5.7% < −5.0%" when it does not, so a failing or waiting
 * rule never prints a comparison that is false. Null when the value or the
 * threshold is not known, so the caller prints the rule's detail.
 */
export function formatRuleMeasure(
  rule: Pick<StrategyRuleDef, "threshold" | "unit" | "comparator">,
  result: Pick<RuleResultRow, "value"> | undefined,
): string | null {
  if (result?.value === undefined || rule.threshold === undefined) {
    return null;
  }
  const comparator = rule.comparator ?? "";
  const holds = comparisonHolds(result.value, comparator, rule.threshold);
  if (holds === null) return null;
  const unit = rule.unit ?? "";
  const symbol = holds
    ? COMPARATOR_SYMBOL[comparator]
    : NEGATED_SYMBOL[comparator];
  if (!symbol) return null;
  const measure = figureAgreeing(
    result.value,
    unit,
    comparator,
    rule.threshold,
    holds,
  );
  return `${measure} ${symbol} ${formatRuleFigure(rule.threshold, unit)}`;
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
 * The heading of a stock the picker did not read. "yet" only where a later
 * session can read it: a short history, a missing bar, or a recent corporate
 * action that grows out of the guard. An exchange-traded product, a debt or
 * hybrid security and a secondary line are never evaluated, so their heading
 * does not promise an evaluation.
 */
const CLEARABLE_INELIGIBLE: ReadonlySet<string> = new Set([
  "short_history",
  "no_bar_on_session",
  "corporate_action_guard",
]);

export function notEvaluatedHeading(reason: string | undefined | null): string {
  return !reason || CLEARABLE_INELIGIBLE.has(reason)
    ? "Not evaluated yet"
    : "Not evaluated";
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
