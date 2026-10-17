// The financial statements' line definitions and the island's prop shapes
// (docs/plans/fundamentals-coverage.md §7.1, item 3).
//
// Dependency-free and NOT a client module, so the server shaper
// (statements-shape.ts) and the client island (financial-statements.tsx) read
// the same lists: the server decides which lines carry data, the client owns
// the labels and formatters. Only plain data crosses the RSC boundary.
//
// A line id is the wire (snake_case) field name, the same key `field_sources`
// uses, so a cell's provenance is looked up by the id it already carries.

export type StatementId = "income" | "balance" | "cashflow";

/** How a line's values are formatted. */
export type StatementLineKind = "amount" | "perShare" | "shares";

export interface StatementLineDef {
  /** Wire field name, e.g. "net_income". */
  id: string;
  label: string;
  kind: StatementLineKind;
  /** Title (tooltip) for the row header. */
  title?: string;
}

export const STATEMENT_IDS: readonly StatementId[] = [
  "income",
  "balance",
  "cashflow",
];

export const STATEMENT_LABELS: Readonly<Record<StatementId, string>> = {
  income: "Income",
  balance: "Balance sheet",
  cashflow: "Cash flow",
};

export const STATEMENT_LINES: Readonly<
  Record<StatementId, readonly StatementLineDef[]>
> = {
  income: [
    { id: "revenue", label: "Revenue", kind: "amount" },
    { id: "gross_profit", label: "Gross profit", kind: "amount" },
    { id: "operating_income", label: "Operating income", kind: "amount" },
    {
      id: "ebitda",
      label: "EBITDA",
      kind: "amount",
      title: "Statutory: includes impairments and revaluations",
    },
    { id: "ebit", label: "EBIT", kind: "amount" },
    { id: "interest_expense", label: "Interest expense", kind: "amount" },
    { id: "pretax_income", label: "Pretax income", kind: "amount" },
    { id: "tax_provision", label: "Tax", kind: "amount" },
    {
      id: "net_income",
      label: "NPAT",
      kind: "amount",
      title: "Net profit after tax attributable to shareholders",
    },
    {
      id: "net_interest_income",
      label: "Net interest income",
      kind: "amount",
      title: "Banks; other companies report it as minus interest expense",
    },
    { id: "eps_basic", label: "EPS basic", kind: "perShare" },
    { id: "eps_diluted", label: "EPS diluted", kind: "perShare" },
    { id: "shares_outstanding", label: "Shares", kind: "shares" },
  ],
  balance: [
    { id: "total_assets", label: "Total assets", kind: "amount" },
    { id: "total_liabilities", label: "Total liabilities", kind: "amount" },
    {
      id: "total_equity",
      label: "Equity",
      kind: "amount",
      title: "Shareholders' equity",
    },
    { id: "cash_and_equivalents", label: "Cash", kind: "amount" },
    {
      id: "total_debt",
      label: "Total debt",
      kind: "amount",
      title: "Includes lease liabilities",
    },
    { id: "capital_lease_obligations", label: "Lease liabilities", kind: "amount" },
    {
      id: "net_debt",
      label: "Net debt (excl. leases)",
      kind: "amount",
      title: "Total debt minus leases minus cash, as the provider reports it",
    },
    { id: "current_assets", label: "Current assets", kind: "amount" },
    { id: "current_liabilities", label: "Current liabilities", kind: "amount" },
  ],
  cashflow: [
    { id: "operating_cash_flow", label: "Operating cash flow", kind: "amount" },
    {
      id: "capital_expenditure",
      label: "Capex",
      kind: "amount",
      title: "Capital expenditure, an outflow",
    },
    { id: "free_cash_flow", label: "Free cash flow", kind: "amount" },
    {
      id: "dividends_paid",
      label: "Dividends paid",
      kind: "amount",
      title: "Cash dividends paid, an outflow",
    },
    {
      id: "share_buybacks",
      label: "Buybacks",
      kind: "amount",
      title: "Share buybacks, an outflow",
    },
  ],
};

/** The column kinds a statement can show. Quarter snapshots fold into these. */
export type StatementColumnType = "ttm" | "annual" | "half";

/** One column, shared by every statement. Keys: "t", "a0".."a3", "h0".."h3". */
export interface StatementColumn {
  k: string;
  t: StatementColumnType;
  /** Period end, YYYY-MM-DD. */
  e: string;
  /** Fiscal year when the provider labels it. */
  fy?: number;
  /** The column's currency, only when it differs from the island's. */
  c?: string;
}

/** One line: values by column key (nulls omitted), provenance by column key. */
export interface StatementLine {
  id: string;
  v: Record<string, number>;
  /**
   * Where a value came from when it is not the default vendor, by column key:
   * the cell's `field_sources` entry, else its row's own source (a filing
   * half, a Markit year), as its one-letter PROVENANCE_GLYPHS code (the full
   * source id only for a source without one). Omitted when every value is
   * the vendor's.
   */
  p?: Record<string, string>;
}

/**
 * The letter that marks each known non-vendor source. The server sends the
 * letter (it keeps the island's props small), the island resolves it back to
 * the source for the mark's text and the legend.
 */
export const PROVENANCE_GLYPHS: Readonly<Record<string, string>> = {
  "asx-filing-extraction": "F",
  "markit-key-statistics": "M",
  "derived:fcf-minus-capex": "D",
  "derived:ttm-at-fye": "T",
};

/** Source id -> the code the props carry (the letter, or the id itself). */
export function provenanceCode(source: string): string {
  const id = source.trim();
  return PROVENANCE_GLYPHS[id] ?? id;
}

/** A props code (or a source id) -> the source id. */
export function provenanceSource(code: string): string {
  const value = code.trim();
  for (const [source, glyph] of Object.entries(PROVENANCE_GLYPHS)) {
    if (glyph === value) return source;
  }
  return value;
}

export interface StatementData {
  id: StatementId;
  lines: StatementLine[];
}

/** Everything the island receives: data only, no row definitions, no functions. */
export interface FinancialStatementsProps {
  code: string;
  /** The reporting currency most columns share; "" when not stated. */
  currency: string;
  columns: StatementColumn[];
  statements: StatementData[];
}

/** The ceiling on columns the server sends (TTM + 4 FY + 4 HY). */
export const MAX_STATEMENT_COLUMNS = 9;
export const MAX_YEAR_COLUMNS = 4;
export const MAX_HALF_COLUMNS = 4;

/** The source every unmarked value comes from. */
export const DEFAULT_VENDOR_SOURCE = "yahoo-timeseries";
