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

/** One coverage bar's figure as the page prints it: a percent, or "n/a" when not measurable. */
export function coverageFigure(year: CoverageYearView): string {
  if (!year.measurable || year.coveragePct === null) return "not measurable";
  return `${Math.round(year.coveragePct)}%`;
}

/**
 * The coverage of every year, as the bars the strip draws: a fraction of the names
 * (the API's coverage is a percent; the strip takes 0 to 1). A null bar is not measured.
 */
export function coverageBars(
  years: readonly CoverageYearView[],
): Array<{ key: string; label: string; coverage: number | null }> {
  return years.map((year) => ({
    key: String(year.year),
    label: String(year.year),
    coverage: year.measurable && year.coveragePct !== null ? year.coveragePct / 100 : null,
  }));
}

/** The lowest measured coverage year: the one the survivorship line says flatters most. */
export function lowestCoverageYear(
  years: readonly CoverageYearView[],
): CoverageYearView | null {
  let lowest: CoverageYearView | null = null;
  for (const year of years) {
    if (!year.measurable || year.coveragePct === null) continue;
    if (lowest === null || (lowest.coveragePct ?? 1) > year.coveragePct) lowest = year;
  }
  return lowest;
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
 * The coverage chip the header prints (1.5, 1.8 item 3): the first and last measured years
 * on the qualifying measure, and the survivorship caveat in words. A strategy whose
 * qualifying measure cannot be measured (Minervini: the whole ASX universe) prints the
 * all-reported measure with its own caveat (1.7, "Coverage not measurable"). "" when no
 * year is measured on either measure, so the chip is omitted rather than guessed.
 */
export function coverageChip(years: readonly CoverageYearView[]): string {
  const qualifying = years
    .filter((y) => y.measurable && y.coveragePct !== null)
    .sort((a, b) => a.year - b.year);
  // A run whose qualifying measure cannot be measured for any year (Minervini before 2025)
  // states the all-reported figures and their caveat, never one measurable year as the span.
  const qualifyingWhole = years.length > 0 && years.every((y) => y.measurable);
  if (qualifying.length > 0 && qualifyingWhole) {
    const first = qualifying[0]!;
    const last = qualifying[qualifying.length - 1]!;
    const span =
      first.year === last.year
        ? `Coverage ${Math.round(first.coveragePct ?? 0)}% (${first.year})`
        : `Coverage ${Math.round(first.coveragePct ?? 0)}% (${first.year}) → ${Math.round(last.coveragePct ?? 0)}% (${last.year})`;
    return `${span} · flatters results; by how much cannot be measured`;
  }
  const reported = years
    .filter((y) => y.allReportedMeasurable && y.allReportedPct !== null)
    .sort((a, b) => a.year - b.year);
  const first = reported[0];
  const last = reported[reported.length - 1];
  if (!first || !last || first.allReportedPct === null || last.allReportedPct === null) return "";
  const span =
    first.year === last.year
      ? `Coverage (all reported) ${Math.round(first.allReportedPct)}% (${first.year})`
      : `Coverage (all reported) ${Math.round(first.allReportedPct)}% (${first.year}) → ${Math.round(last.allReportedPct)}% (${last.year})`;
  return `${span} · measured on ASIC-reported names only; delisted companies never shorted cannot be counted`;
}
