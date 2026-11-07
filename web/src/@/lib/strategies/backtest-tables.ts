// The Backtest tab's tables as plain data: the monthly grid's cells and years,
// the coverage bars, the data-quality counts and the sensitivity rows. Pure, so
// the rules (which years show by default, which cell says what, which chip a
// run earns) are tested without a DOM.

import type {
  CoverageYearView,
  MonthlyReturnView,
  SensitivityView,
} from "./map-backtest";
import { formatSigned } from "./format";

export const MONTH_NAMES = [
  "Jan",
  "Feb",
  "Mar",
  "Apr",
  "May",
  "Jun",
  "Jul",
  "Aug",
  "Sep",
  "Oct",
  "Nov",
  "Dec",
] as const;

/** The years the monthly table shows before the disclosure (the newest three). */
export const MONTHLY_RECENT_YEARS = 3;

/** One month's cell: a figure, or the words that say why there is none (1.7). */
export type MonthCell =
  | { kind: "value"; value: number; current: boolean }
  | { kind: "hatched"; label: string };

/**
 * The words of a month with no figure (1.7). The API omits a month that has not
 * elapsed or falls before the window, so the words follow from the window's bounds:
 * a month after the window's last session is "Not elapsed", one before its first is
 * "Before window". A month inside the window with no row reads "n/a", never a figure.
 */
export function monthWords(
  year: number,
  month: number,
  windowStart: string,
  windowEnd: string,
): string {
  const key = year * 100 + month;
  const startKey = monthKey(windowStart);
  const endKey = monthKey(windowEnd);
  if (startKey !== null && key < startKey) return "Before window";
  if (endKey !== null && key > endKey) return "Not elapsed";
  return "n/a";
}

/** YYYYMM of a YYYY-MM-DD date, or null. */
function monthKey(iso: string): number | null {
  const m = /^(\d{4})-(\d{2})/.exec(iso);
  return m ? Number(m[1]) * 100 + Number(m[2]) : null;
}

/** The years a run's monthly table carries, newest first. */
export function monthlyYears(monthly: readonly MonthlyReturnView[]): number[] {
  return [...new Set(monthly.map((m) => m.year))].sort((a, b) => b - a);
}

/** The newest years shown by default, and the earlier ones behind the disclosure. */
export function splitMonthlyYears(years: readonly number[]): {
  recent: number[];
  earlier: number[];
} {
  return {
    recent: years.slice(0, MONTHLY_RECENT_YEARS),
    earlier: years.slice(MONTHLY_RECENT_YEARS),
  };
}

/**
 * The twelve cells of one year, January first. A figure where the API served one;
 * otherwise the words of monthWords. The current month (to_date, or labelled MTD)
 * is marked so the table can say it is month to date.
 */
export function monthCells(
  monthly: readonly MonthlyReturnView[],
  year: number,
  windowStart: string,
  windowEnd: string,
): MonthCell[] {
  return MONTH_NAMES.map((_, index) => {
    const month = index + 1;
    const row = monthly.find((m) => m.year === year && m.month === month);
    if (!row || row.state === "unknown" || row.strategyPct === null) {
      return { kind: "hatched", label: monthWords(year, month, windowStart, windowEnd) };
    }
    return {
      kind: "value",
      value: row.strategyPct,
      current: row.state === "to_date" || row.label === "MTD",
    };
  });
}




/** The sensitivity rows' figures. A run that does not take a change says why, and prints no figure. */
export function sensitivityFigures(row: SensitivityView): {
  cagr: string;
  excess: string;
} {
  if (!row.applies) return { cagr: "n/a", excess: "n/a" };
  return {
    cagr: row.cagrPct === null ? "n/a" : formatSigned(row.cagrPct, "%"),
    excess: row.excessVsBenchmarkPct === null ? "n/a" : formatSigned(row.excessVsBenchmarkPct, " pp"),
  };
}

/**
 * The chips a run earns from its sensitivity runs (5.12): one per fragile
 * sensitivity, in the order the API sent them, de-duplicated.
 */
export function fragileChips(sensitivity: readonly SensitivityView[]): string[] {
  const chips: string[] = [];
  for (const row of sensitivity) {
    if (row.fragile && row.fragileChip && !chips.includes(row.fragileChip)) {
      chips.push(row.fragileChip);
    }
  }
  return chips;
}


/**
 * The ONE coverage measure a run uses, read from the survivorship statement (10.3, B1):
 * `measured` is the qualifying measure (name-days of at least 5% short); `partial` and
 * `not_measurable` are the all-reported measure (every ordinary name in the report). A run
 * with no survivorship block names none.
 */
export type CoverageMeasureKey = "qualifying" | "all_reported" | "";

export function coverageMeasureOf(measurement: string | null | undefined): CoverageMeasureKey {
  if (measurement === "measured") return "qualifying";
  if (measurement === "partial" || measurement === "not_measurable") return "all_reported";
  return "";
}

/** The measure's name as the page prints it, for the chip, the bars and the sentence. */
export function coverageMeasureName(measure: CoverageMeasureKey): string {
  return measure === "qualifying" ? "qualifying ≥ 5% short" : measure === "all_reported" ? "all reported" : "";
}

/**
 * A year's figure under the run's one measure, in percent, or null when it is not measurable.
 * Under the all-reported measure a year counts only once the qualifying measure can see it (the
 * first measurable year, 1.7): a partial run never cites a pre-2025 year in the chip, the bars or
 * the lowest-year sentence, whatever the all-reported figure there is.
 */
export function yearCoverage(year: CoverageYearView, measure: CoverageMeasureKey): number | null {
  if (measure === "qualifying") return year.measurable ? year.coveragePct : null;
  if (measure === "all_reported") return year.measurable && year.allReportedMeasurable ? year.allReportedPct : null;
  return null;
}

/** The "?" mark on a year the run's measure cannot measure (1.5, 1.7); null for every measured year. */
export const UNMEASURED_MARK = "?";

/** Whether a year gets the "?" mark: the all-reported measure runs, and the qualifying one cannot see the year. */
export function isUnmeasuredYear(year: CoverageYearView, measure: CoverageMeasureKey): boolean {
  return measure === "all_reported" && !year.measurable;
}

/**
 * A year's printed figure in the table. A year the run's measure cannot see reads "?" (beside its
 * all-reported figure when the API serves one for that year, so no bare number reads as measured);
 * a measured year reads its percentage; a year with no figure reads "n/a".
 */
export function coverageFigure(year: CoverageYearView, measure: CoverageMeasureKey): string {
  if (isUnmeasuredYear(year, measure)) {
    return year.allReportedMeasurable && year.allReportedPct !== null
      ? `${Math.round(year.allReportedPct)}% ${UNMEASURED_MARK}`
      : UNMEASURED_MARK;
  }
  const figure = yearCoverage(year, measure);
  return figure === null ? "n/a" : `${Math.round(figure)}%`;
}

/** The bars for the yearly strip (fractions 0 to 1) under the run's one measure. */
export function coverageBars(
  years: readonly CoverageYearView[],
  measure: CoverageMeasureKey,
): Array<{ key: string; label: string; coverage: number | null; mark?: string }> {
  return years.map((year) => {
    const figure = yearCoverage(year, measure);
    return {
      key: String(year.year),
      label: String(year.year),
      coverage: figure === null ? null : figure / 100,
      ...(isUnmeasuredYear(year, measure) ? { mark: UNMEASURED_MARK } : {}),
    };
  });
}

/** The lowest measured year under the run's one measure: the one the survivorship line names. */
export function lowestCoverageYear(
  years: readonly CoverageYearView[],
  measure: CoverageMeasureKey,
): { year: number; coveragePct: number } | null {
  let lowest: { year: number; coveragePct: number } | null = null;
  for (const year of years) {
    const figure = yearCoverage(year, measure);
    if (figure === null) continue;
    if (lowest === null || lowest.coveragePct > figure) lowest = { year: year.year, coveragePct: figure };
  }
  return lowest;
}

/**
 * The chip the header prints (1.5, 1.8 item 3), under the run's one measure. The qualifying
 * measure reads "Coverage (qualifying ≥ 5% short) 64% (2019) → 96% (2025) · flatters results;
 * by how much cannot be measured". The all-reported measure adds that the gap cannot be
 * measured for companies that were never reported short. "" when no year is measured.
 */
export function coverageChip(years: readonly CoverageYearView[], measure: CoverageMeasureKey): string {
  const measured = years
    .map((y) => ({ year: y.year, figure: yearCoverage(y, measure) }))
    .filter((y): y is { year: number; figure: number } => y.figure !== null)
    .sort((a, b) => a.year - b.year);
  const first = measured[0];
  const last = measured[measured.length - 1];
  if (!first || !last || measure === "") return "";
  const name = measure === "qualifying" ? "qualifying ≥ 5% short" : "all reported";
  const span =
    first.year === last.year
      ? `Coverage (${name}) ${Math.round(first.figure)}% (${first.year})`
      : `Coverage (${name}) ${Math.round(first.figure)}% (${first.year}) → ${Math.round(last.figure)}% (${last.year})`;
  const tail = "flatters results; by how much cannot be measured";
  if (measure === "all_reported") {
    return `${span} · ${tail}; the gap cannot be measured for companies that were never reported short`;
  }
  return `${span} · ${tail}`;
}
