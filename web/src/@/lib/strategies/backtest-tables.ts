// The Backtest tab's tables as plain data: the monthly grid's cells and years,
// the coverage bars, the data-quality counts and the sensitivity rows. Pure, so
// the rules (which years show by default, which cell says what, which chip a
// run earns) are tested without a DOM.

import type {
  CoverageYearView,
  MonthlyReturnView,
  PeriodState,
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

/** The words a period with no figure carries, per state (1.7). */
export function periodWords(state: PeriodState): string {
  switch (state) {
    case "not_elapsed":
      return "Not elapsed";
    case "before_window":
      return "Before window";
    case "run_required":
      return "Run required";
    case "not_computable":
      return "Not computable";
    default:
      return "n/a";
  }
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

/** The twelve cells of one year, January first. A month the run does not carry is "n/a", never a figure. */
export function monthCells(
  monthly: readonly MonthlyReturnView[],
  year: number,
): MonthCell[] {
  return MONTH_NAMES.map((_, index) => {
    const month = index + 1;
    const row = monthly.find((m) => m.year === year && m.month === month);
    if (!row) return { kind: "hatched", label: "n/a" };
    if (row.strategyPct !== null && (row.state === "complete" || row.state === "partial" || row.state === "current")) {
      return {
        kind: "value",
        value: row.strategyPct,
        current: row.state === "current" || row.label === "MTD",
      };
    }
    return { kind: "hatched", label: periodWords(row.state) };
  });
}

/** One coverage bar's figure as the page prints it: a percent, or "n/a" when not measurable. */
export function coverageFigure(year: CoverageYearView): string {
  if (!year.measurable || year.coveragePct === null) return "n/a";
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
 * The coverage chip the header prints (1.5, 1.8 item 3): the first and last measured
 * years on the qualifying measure, and the survivorship caveat in words. "" when no
 * year is measured, so the chip is omitted rather than printed with a guess.
 */
export function coverageChip(years: readonly CoverageYearView[]): string {
  const measured = years
    .filter((y) => y.measurable && y.coveragePct !== null)
    .sort((a, b) => a.year - b.year);
  const first = measured[0];
  const last = measured[measured.length - 1];
  if (!first || !last || first.coveragePct === null || last.coveragePct === null) return "";
  const span =
    first.year === last.year
      ? `Coverage ${Math.round(first.coveragePct)}% (${first.year})`
      : `Coverage ${Math.round(first.coveragePct)}% (${first.year}) → ${Math.round(last.coveragePct)}% (${last.year})`;
  return `${span} · flatters results; by how much cannot be measured`;
}
