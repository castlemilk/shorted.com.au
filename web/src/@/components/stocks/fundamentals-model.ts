// Period selection and page decisions over the mapped fundamentals
// (docs/plans/fundamentals-coverage.md §7.1). Pure and dependency-free (type
// imports only), so every server card and the Overview summary read the SAME
// "latest result", the same prior period and the same empty-state rule.

import type {
  StockFundamentals,
  StockFundamentalsPeriod,
} from "~/app/actions/getStockFundamentals";

const DAY_MS = 86_400_000;

/** A year apart, give or take: 52/53-week years and month-end drift. */
const PRIOR_YEAR_MIN_DAYS = 365 - 25;
const PRIOR_YEAR_MAX_DAYS = 365 + 25;

/** The flow period types a result can be read from, most authoritative first. */
const FLOW_TYPE_RANK: Readonly<Record<string, number>> = {
  annual: 0,
  half: 1,
  ttm: 2,
};

export function isFlowPeriodType(periodType: string): boolean {
  return Object.prototype.hasOwnProperty.call(FLOW_TYPE_RANK, periodType);
}

/**
 * Where one value came from: its `field_sources` entry, else its row's
 * source. A vendor row can carry a filing- or Markit-filled revenue or NPAT
 * (contract §2.2, §3.6), so any attribution of a quoted figure reads this,
 * never the row's source alone.
 */
export function valueSource(period: StockFundamentalsPeriod, wire: string): string {
  return period.fieldSources[wire] ?? period.source;
}

/**
 * The flow fields the Key ratios card's ratios read, as `field_sources` keys.
 * Balance-sheet inputs are not listed: no filing or Markit fill reaches them.
 */
const RATIO_FLOW_FIELDS: readonly string[] = [
  "revenue",
  "net_income",
  "gross_profit",
  "operating_income",
  "free_cash_flow",
  "ebitda",
  "normalized_ebitda",
  "interest_expense",
  "dividends_paid",
];

/**
 * Every source behind the Key ratios: the flow row's source first, then any
 * field of the basis period that came from elsewhere (a filing- or
 * Markit-filled revenue or NPAT), so the card never credits a vendor for a
 * filing figure.
 */
export function ratioSources(
  rowSource: string,
  basisPeriod: StockFundamentalsPeriod | null,
): string[] {
  const sources = [rowSource];
  if (basisPeriod) {
    for (const field of RATIO_FLOW_FIELDS) {
      const source = basisPeriod.fieldSources[field];
      if (source) sources.push(source);
    }
  }
  return sources;
}

/** A headline figure (revenue, NPAT or EPS) is held for the period. */
export function hasHeadlineFigure(period: StockFundamentalsPeriod): boolean {
  return (
    period.revenue !== null ||
    period.netIncome !== null ||
    period.epsBasic !== null ||
    period.epsDiluted !== null
  );
}

function parseDay(iso: string): number | null {
  if (!/^\d{4}-\d{2}-\d{2}/.test(iso)) return null;
  const ms = Date.parse(`${iso.slice(0, 10)}T00:00:00Z`);
  return Number.isNaN(ms) ? null : ms;
}

/** Days from `earlier` to `later`; null when either date does not parse. */
export function daysBetween(earlier: string, later: string): number | null {
  const a = parseDay(earlier);
  const b = parseDay(later);
  return a === null || b === null ? null : Math.round((b - a) / DAY_MS);
}

function compareNewestFirst(
  a: StockFundamentalsPeriod,
  b: StockFundamentalsPeriod,
): number {
  const byEnd = b.periodEnd.localeCompare(a.periodEnd);
  if (byEnd !== 0) return byEnd;
  return (FLOW_TYPE_RANK[a.periodType] ?? 9) - (FLOW_TYPE_RANK[b.periodType] ?? 9);
}

/**
 * The newest flow period (annual, half or TTM) with a headline figure. At the
 * same period end the reported period wins: annual, then half, then TTM.
 */
export function latestResultPeriod(
  periods: readonly StockFundamentalsPeriod[],
): StockFundamentalsPeriod | null {
  const candidates = periods
    .filter((p) => isFlowPeriodType(p.periodType) && hasHeadlineFigure(p))
    .sort(compareNewestFirst);
  return candidates[0] ?? null;
}

/**
 * The same kind of period about a year before `latest` (the prior
 * corresponding period), or null when none is held.
 */
export function priorCorrespondingPeriod(
  periods: readonly StockFundamentalsPeriod[],
  latest: StockFundamentalsPeriod,
): StockFundamentalsPeriod | null {
  let best: StockFundamentalsPeriod | null = null;
  let bestDistance = Number.POSITIVE_INFINITY;
  for (const period of periods) {
    if (period === latest || period.periodType !== latest.periodType) continue;
    const days = daysBetween(period.periodEnd, latest.periodEnd);
    if (days === null || days < PRIOR_YEAR_MIN_DAYS || days > PRIOR_YEAR_MAX_DAYS) {
      continue;
    }
    const distance = Math.abs(days - 365);
    if (distance < bestDistance) {
      best = period;
      bestDistance = distance;
    }
  }
  return best;
}

/** An http(s) URL, or "" when the value is anything else. */
export function safeHttpUrl(value: string | null | undefined): string {
  const url = typeof value === "string" ? value.trim() : "";
  return /^https?:\/\//i.test(url) ? url : "";
}

export interface SourceDocument {
  url: string;
  /** YYYY-MM-DD; "" when not stated. */
  date: string;
}

/**
 * The filing the Latest result's figures come from, read ONLY from the
 * period's source_document_url (never guessed from the reports list or the
 * latest filing summary). Null when the figures are not filing-sourced.
 */
export function latestResultSourceDocument(
  fundamentals: StockFundamentals | null,
): SourceDocument | null {
  if (!fundamentals) return null;
  const latest = latestResultPeriod(fundamentals.periods);
  if (!latest) return null;
  const url = safeHttpUrl(latest.sourceDocumentUrl);
  return url ? { url, date: latest.sourceDocumentDate } : null;
}

/** Normalises a report URL for comparison: trimmed, no trailing slash, no fragment. */
export function comparableUrl(value: string | null | undefined): string {
  const url = safeHttpUrl(value);
  return url.replace(/#.*$/, "").replace(/\/+$/, "");
}

/**
 * The empty state is shown ONLY when nothing is held AND the collector has a
 * definite answer. A null result (API failure) and an unknown coverage (an
 * older API) render nothing extra: absent is not a status.
 */
export type FundamentalsEmptyKind = "empty" | "pending" | "failed";

export function fundamentalsEmptyKind(
  fundamentals: StockFundamentals | null,
): FundamentalsEmptyKind | null {
  if (!fundamentals || fundamentals.periods.length > 0) return null;
  const status = fundamentals.coverage.status;
  return status === "empty" || status === "pending" || status === "failed"
    ? status
    : null;
}
