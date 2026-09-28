// How much of the universe the picker holds fundamentals for
// (docs/plans/fundamentals-coverage.md §7.2). Pure, no imports.

/**
 * True when the response reported fundamentals_rows_count: then a pick
 * without StrategyPick.fundamentals genuinely has no fundamentals row, and the
 * table may say so. An API that predates the field sends 0 (proto3 cannot
 * tell it from none), and a count below the growth coverage is not a count of
 * stocks with data (every stock with a growth figure has a row), so both read
 * as "not reported" and the page renders as it did before the field existed.
 */
export function fundamentalsHeld(
  rowsCount: number,
  coverageCount: number,
): boolean {
  return rowsCount > 0 && rowsCount >= coverageCount;
}
