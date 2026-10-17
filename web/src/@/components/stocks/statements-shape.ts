// Server-side shaping of the financial statements island's props
// (docs/plans/fundamentals-coverage.md §7.1, item 3). Pure: the Financials
// tab (a server component) calls it and hands the island data only.
//
// Rules, all of them from the contract:
//   - at most 9 columns: a leading TTM column, up to 4 FY and up to 4 HY;
//   - the TTM column exists only when the latest TTM row is newer than the
//     latest annual AND carries revenue or NPAT, and it is never a balance
//     sheet column;
//   - quarter rows are balance snapshots: they are read into the FY or HY
//     column whose period end they fall on (same currency only), never shown
//     as columns of their own;
//   - only lines that carry a value are sent, only columns that carry a value
//     are sent, and nulls are omitted;
//   - a cell's `field_sources` entry travels with it, so the island can mark it.

import type {
  StockFundamentals,
  StockFundamentalsPeriod,
} from "~/app/actions/getStockFundamentals";
import {
  DEFAULT_VENDOR_SOURCE,
  MAX_HALF_COLUMNS,
  MAX_YEAR_COLUMNS,
  STATEMENT_IDS,
  STATEMENT_LINES,
  provenanceCode,
  type FinancialStatementsProps,
  type StatementColumn,
  type StatementColumnType,
  type StatementData,
  type StatementLine,
} from "./statement-lines";
import { daysBetween } from "./fundamentals-model";

type NumericField = {
  [K in keyof StockFundamentalsPeriod]: StockFundamentalsPeriod[K] extends
    | number
    | null
    ? K
    : never;
}[keyof StockFundamentalsPeriod];

/** Wire line id -> the mapped period field that holds it. */
export const PERIOD_FIELD_BY_LINE: Readonly<Record<string, NumericField>> = {
  revenue: "revenue",
  gross_profit: "grossProfit",
  operating_income: "operatingIncome",
  ebitda: "ebitda",
  ebit: "ebit",
  interest_expense: "interestExpense",
  pretax_income: "pretaxIncome",
  tax_provision: "taxProvision",
  net_income: "netIncome",
  net_interest_income: "netInterestIncome",
  eps_basic: "epsBasic",
  eps_diluted: "epsDiluted",
  shares_outstanding: "sharesOutstanding",
  total_assets: "totalAssets",
  total_liabilities: "totalLiabilities",
  total_equity: "totalEquity",
  cash_and_equivalents: "cashAndEquivalents",
  total_debt: "totalDebt",
  capital_lease_obligations: "capitalLeaseObligations",
  net_debt: "netDebt",
  current_assets: "currentAssets",
  current_liabilities: "currentLiabilities",
  operating_cash_flow: "operatingCashFlow",
  capital_expenditure: "capitalExpenditure",
  free_cash_flow: "freeCashFlow",
  dividends_paid: "dividendsPaid",
  share_buybacks: "shareBuybacks",
};

/** Point-in-time lines a quarter snapshot may fill: the balance sheet and shares. */
const SNAPSHOT_LINES: ReadonlySet<string> = new Set([
  ...STATEMENT_LINES.balance.map((line) => line.id),
  "shares_outstanding",
]);

/** A snapshot within this many days of a period end falls on it. */
const SAME_END_DAYS = 10;

interface Slot {
  type: StatementColumnType;
  end: string;
  row: StockFundamentalsPeriod | null;
  snapshot: StockFundamentalsPeriod | null;
}

function newestFirst(
  a: StockFundamentalsPeriod,
  b: StockFundamentalsPeriod,
): number {
  return b.periodEnd.localeCompare(a.periodEnd);
}

function ofType(
  periods: readonly StockFundamentalsPeriod[],
  type: string,
): StockFundamentalsPeriod[] {
  return periods.filter((p) => p.periodType === type).sort(newestFirst);
}

/**
 * Calendar month (0-11) a period end belongs to, folding a 52/53-week end in
 * the first days of a month back into the month before (same fold as
 * format.ts periodColumnLabel and the jobs module).
 */
function effectiveMonth(iso: string): number | null {
  if (!/^\d{4}-\d{2}-\d{2}/.test(iso)) return null;
  const ms = Date.parse(`${iso.slice(0, 10)}T00:00:00Z`);
  if (Number.isNaN(ms)) return null;
  return new Date(ms - 7 * 86_400_000).getUTCMonth();
}

function sameEnd(a: string, b: string): boolean {
  const days = daysBetween(a, b);
  return days !== null && Math.abs(days) <= SAME_END_DAYS;
}

function hasFlowHeadline(period: StockFundamentalsPeriod): boolean {
  return period.revenue !== null || period.netIncome !== null;
}

function slotCurrency(slot: Slot): string {
  return slot.row?.currency ?? slot.snapshot?.currency ?? "";
}

/**
 * Where one value came from, when it is not the default vendor: the field's
 * own `field_sources` entry, else the row's source (a filing half, a Markit
 * year). "" for a plain vendor value.
 */
function provenanceOf(row: StockFundamentalsPeriod, lineId: string): string {
  const field = row.fieldSources[lineId];
  if (field) return field;
  return row.source && row.source !== DEFAULT_VENDOR_SOURCE ? row.source : "";
}

/** The value and provenance of one line in one slot. */
function cell(
  slot: Slot,
  lineId: string,
): { value: number; provenance: string } | null {
  const field = PERIOD_FIELD_BY_LINE[lineId];
  if (!field) return null;
  const row = slot.row;
  const fromRow = row?.[field];
  if (row && typeof fromRow === "number") {
    return { value: fromRow, provenance: provenanceOf(row, lineId) };
  }
  const snapshot = slot.snapshot;
  if (!SNAPSHOT_LINES.has(lineId) || !snapshot) return null;
  // Never mix currencies inside one column.
  if (row && snapshot.currency !== row.currency) return null;
  const fromSnapshot = snapshot[field];
  if (typeof fromSnapshot === "number") {
    return { value: fromSnapshot, provenance: provenanceOf(snapshot, lineId) };
  }
  return null;
}

function slotHasValue(slot: Slot, statementIds: readonly string[]): boolean {
  return statementIds.some((id) =>
    STATEMENT_LINES[id as keyof typeof STATEMENT_LINES].some(
      (line) => cell(slot, line.id) !== null,
    ),
  );
}

/** Statements a slot type can appear in: the balance sheet never shows TTM. */
function statementsFor(type: StatementColumnType): readonly string[] {
  return type === "ttm"
    ? STATEMENT_IDS.filter((id) => id !== "balance")
    : STATEMENT_IDS;
}

/**
 * The island's props for one stock, or null when no statement carries a
 * value. Never throws on sparse or odd data: it only ever omits.
 */
export function shapeStatements(
  fundamentals: StockFundamentals,
): FinancialStatementsProps | null {
  const periods = fundamentals.periods;
  const annual = ofType(periods, "annual");
  const halves = ofType(periods, "half");
  const ttms = ofType(periods, "ttm");
  const quarters = ofType(periods, "quarter");

  const currency =
    (annual[0] ?? ttms[0] ?? halves[0] ?? quarters[0])?.currency ?? "";

  // The fiscal year-end month, from the latest annual (or, failing that, six
  // months after the latest half); snapshots fold onto year and half ends.
  const fyMonth =
    annual[0] !== undefined
      ? effectiveMonth(annual[0].periodEnd)
      : halves[0] !== undefined
        ? (() => {
            const month = effectiveMonth(halves[0].periodEnd);
            return month === null ? null : (month + 6) % 12;
          })()
        : null;
  const halfMonth = fyMonth === null ? null : (fyMonth + 6) % 12;

  // TTM: only a trailing year newer than the latest annual, with a headline.
  const latestTtm = ttms[0];
  const ttmSlot: Slot | null =
    latestTtm &&
    hasFlowHeadline(latestTtm) &&
    (annual[0] === undefined ||
      latestTtm.periodEnd.localeCompare(annual[0].periodEnd) > 0)
      ? { type: "ttm", end: latestTtm.periodEnd, row: latestTtm, snapshot: null }
      : null;

  // Year columns: annual rows, a year-end snapshot read into the same column.
  const yearSlots: Slot[] = [];
  for (const row of annual) {
    if (yearSlots.some((slot) => sameEnd(slot.end, row.periodEnd))) continue;
    yearSlots.push({ type: "annual", end: row.periodEnd, row, snapshot: null });
  }
  // Half columns: half rows, and half-end snapshots (a balance sheet alone).
  const halfSlots: Slot[] = [];
  for (const row of halves) {
    if (halfSlots.some((slot) => sameEnd(slot.end, row.periodEnd))) continue;
    halfSlots.push({ type: "half", end: row.periodEnd, row, snapshot: null });
  }
  for (const snapshot of quarters) {
    const month = effectiveMonth(snapshot.periodEnd);
    if (month === null || fyMonth === null) continue;
    if (month === fyMonth) {
      const slot = yearSlots.find((s) => sameEnd(s.end, snapshot.periodEnd));
      if (slot && !slot.snapshot) slot.snapshot = snapshot;
    } else if (month === halfMonth) {
      const slot = halfSlots.find((s) => sameEnd(s.end, snapshot.periodEnd));
      if (slot) {
        if (!slot.snapshot) slot.snapshot = snapshot;
      } else {
        halfSlots.push({
          type: "half",
          end: snapshot.periodEnd,
          row: null,
          snapshot,
        });
      }
    }
  }
  halfSlots.sort((a, b) => b.end.localeCompare(a.end));

  const keep = (slots: Slot[], max: number) =>
    slots.filter((slot) => slotHasValue(slot, statementsFor(slot.type))).slice(0, max);

  const keyed: Array<{ key: string; slot: Slot }> = [];
  if (ttmSlot && slotHasValue(ttmSlot, statementsFor("ttm"))) {
    keyed.push({ key: "t", slot: ttmSlot });
  }
  keep(yearSlots, MAX_YEAR_COLUMNS).forEach((slot, index) =>
    keyed.push({ key: `a${index}`, slot }),
  );
  keep(halfSlots, MAX_HALF_COLUMNS).forEach((slot, index) =>
    keyed.push({ key: `h${index}`, slot }),
  );
  if (keyed.length === 0) return null;

  const statements: StatementData[] = [];
  for (const statementId of STATEMENT_IDS) {
    const lines: StatementLine[] = [];
    for (const def of STATEMENT_LINES[statementId]) {
      const values: Record<string, number> = {};
      const provenance: Record<string, string> = {};
      for (const { key, slot } of keyed) {
        if (statementId === "balance" && slot.type === "ttm") continue;
        const found = cell(slot, def.id);
        if (!found) continue;
        values[key] = found.value;
        if (found.provenance) provenance[key] = provenanceCode(found.provenance);
      }
      if (Object.keys(values).length === 0) continue;
      lines.push(
        Object.keys(provenance).length > 0
          ? { id: def.id, v: values, p: provenance }
          : { id: def.id, v: values },
      );
    }
    if (lines.length > 0) statements.push({ id: statementId, lines });
  }
  if (statements.length === 0) return null;

  // Only columns some statement line uses.
  const used = new Set<string>();
  for (const statement of statements) {
    for (const line of statement.lines) {
      for (const key of Object.keys(line.v)) used.add(key);
    }
  }

  const columns: StatementColumn[] = keyed
    .filter(({ key }) => used.has(key))
    .map(({ key, slot }) => {
      const column: StatementColumn = { k: key, t: slot.type, e: slot.end };
      const fiscalYear = slot.row?.fiscalYear;
      if (slot.type === "annual" && typeof fiscalYear === "number" && fiscalYear > 0) {
        column.fy = fiscalYear;
      }
      const columnCurrency = slotCurrency(slot);
      if (columnCurrency && columnCurrency !== currency) column.c = columnCurrency;
      return column;
    });

  return {
    code: fundamentals.stockCode,
    currency,
    columns,
    statements,
  };
}
