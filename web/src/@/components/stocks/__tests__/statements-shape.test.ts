import type {
  StockFundamentals,
  StockFundamentalsPeriod,
} from "~/app/actions/getStockFundamentals";
import { shapeStatements } from "../statements-shape";
import { MAX_STATEMENT_COLUMNS, STATEMENT_LINES } from "../statement-lines";
import { fortyPeriods, period, wesLike } from "./fixtures";

function withPeriods(periods: StockFundamentalsPeriod[]): StockFundamentals {
  return { ...wesLike(), periods };
}

function lineValues(
  shaped: NonNullable<ReturnType<typeof shapeStatements>>,
  statement: string,
  line: string,
): Record<string, number> | undefined {
  return shaped.statements
    .find((s) => s.id === statement)
    ?.lines.find((l) => l.id === line)?.v;
}

describe("shapeStatements", () => {
  it("returns null when nothing carries a value", () => {
    expect(shapeStatements(withPeriods([]))).toBeNull();
    expect(
      shapeStatements(
        withPeriods([period({ periodType: "annual", periodEnd: "2026-06-30" })]),
      ),
    ).toBeNull();
  });

  it("leads with TTM only when it is newer than the latest annual and has revenue or NPAT", () => {
    const annual = period({
      periodType: "annual",
      periodEnd: "2025-06-30",
      revenue: 100,
      netIncome: 10,
      totalAssets: 500,
    });
    const newerTtm = period({
      periodType: "ttm",
      periodEnd: "2025-12-31",
      revenue: 110,
      netIncome: 11,
      totalAssets: 999,
    });
    const shaped = shapeStatements(withPeriods([newerTtm, annual]))!;
    expect(shaped.columns[0]).toMatchObject({ k: "t", t: "ttm", e: "2025-12-31" });
    expect(lineValues(shaped, "income", "revenue")).toEqual({ t: 110, a0: 100 });
    // The balance sheet never reads a TTM column.
    expect(lineValues(shaped, "balance", "total_assets")).toEqual({ a0: 500 });

    // Same date as the annual: no TTM column.
    const sameDate = shapeStatements(
      withPeriods([{ ...newerTtm, periodEnd: "2025-06-30" }, annual]),
    )!;
    expect(sameDate.columns.map((c) => c.k)).toEqual(["a0"]);

    // Newer but without revenue or NPAT: no TTM column.
    const epsOnly = shapeStatements(
      withPeriods([
        period({ periodType: "ttm", periodEnd: "2025-12-31", epsBasic: 1.2 }),
        annual,
      ]),
    )!;
    expect(epsOnly.columns.map((c) => c.k)).toEqual(["a0"]);
  });

  it("keeps at most four year columns, newest first, labelled by fiscal year", () => {
    const years = [2026, 2025, 2024, 2023, 2022, 2021].map((year) =>
      period({ periodType: "annual", periodEnd: `${year}-06-30`, fiscalYear: year, revenue: year }),
    );
    const shaped = shapeStatements(withPeriods(years))!;
    expect(shaped.columns).toEqual([
      { k: "a0", t: "annual", e: "2026-06-30", fy: 2026 },
      { k: "a1", t: "annual", e: "2025-06-30", fy: 2025 },
      { k: "a2", t: "annual", e: "2024-06-30", fy: 2024 },
      { k: "a3", t: "annual", e: "2023-06-30", fy: 2023 },
    ]);
  });

  it("reads quarter snapshots into the year and half columns they fall on, never as columns", () => {
    const shaped = shapeStatements(
      withPeriods([
        period({ periodType: "annual", periodEnd: "2026-06-30", revenue: 100 }),
        // Year-end snapshot: fills the annual row's missing balance lines.
        period({ periodType: "quarter", periodEnd: "2026-06-30", totalAssets: 900, sharesOutstanding: 50 }),
        // Half-end snapshot (June balance date): a half column, balance only.
        period({ periodType: "quarter", periodEnd: "2025-12-31", totalAssets: 850 }),
        // Not a half or year end: ignored.
        period({ periodType: "quarter", periodEnd: "2025-09-30", totalAssets: 870 }),
      ]),
    )!;
    expect(shaped.columns.map((c) => [c.k, c.t, c.e])).toEqual([
      ["a0", "annual", "2026-06-30"],
      ["h0", "half", "2025-12-31"],
    ]);
    expect(lineValues(shaped, "balance", "total_assets")).toEqual({ a0: 900, h0: 850 });
    expect(lineValues(shaped, "income", "shares_outstanding")).toEqual({ a0: 50 });
    expect(JSON.stringify(shaped)).not.toContain("870");
  });

  it("never mixes currencies inside a column", () => {
    const shaped = shapeStatements(
      withPeriods([
        period({ periodType: "annual", periodEnd: "2026-06-30", currency: "USD", revenue: 100 }),
        period({ periodType: "quarter", periodEnd: "2026-06-30", currency: "AUD", totalAssets: 900 }),
      ]),
    )!;
    expect(lineValues(shaped, "balance", "total_assets")).toBeUndefined();
    expect(shaped.currency).toBe("USD");
  });

  it("flags a column whose currency differs from the table's", () => {
    const shaped = shapeStatements(
      withPeriods([
        period({ periodType: "annual", periodEnd: "2026-06-30", currency: "USD", revenue: 100 }),
        period({ periodType: "annual", periodEnd: "2025-06-30", currency: "AUD", revenue: 90 }),
      ]),
    )!;
    expect(shaped.columns).toEqual([
      { k: "a0", t: "annual", e: "2026-06-30" },
      { k: "a1", t: "annual", e: "2025-06-30", c: "AUD" },
    ]);
  });

  it("sends only lines and columns that carry values, and no nulls", () => {
    const shaped = shapeStatements(wesLike())!;
    const serialised = JSON.stringify(shaped);
    expect(serialised).not.toContain("null");
    const income = shaped.statements.find((s) => s.id === "income")!;
    // WES has no net interest income: the line is not sent.
    expect(income.lines.map((l) => l.id)).not.toContain("net_interest_income");
    // Every sent line is a known line of its statement.
    for (const statement of shaped.statements) {
      const known = STATEMENT_LINES[statement.id].map((l) => l.id);
      for (const line of statement.lines) expect(known).toContain(line.id);
    }
  });

  it("carries field provenance, and a filing row's own source, per cell", () => {
    const shaped = shapeStatements(
      withPeriods([
        period({
          periodType: "annual",
          periodEnd: "2026-06-30",
          revenue: 100,
          operatingCashFlow: 40,
          fieldSources: { operating_cash_flow: "derived:fcf-minus-capex" },
        }),
        period({
          periodType: "half",
          periodEnd: "2025-12-31",
          revenue: 48,
          netIncome: 5,
          source: "asx-filing-extraction",
        }),
      ]),
    )!;
    const ocf = shaped.statements
      .find((s) => s.id === "cashflow")!
      .lines.find((l) => l.id === "operating_cash_flow")!;
    // Known sources travel as their one-letter code.
    expect(ocf.p).toEqual({ a0: "D" });
    const revenue = shaped.statements
      .find((s) => s.id === "income")!
      .lines.find((l) => l.id === "revenue")!;
    expect(revenue.v).toEqual({ a0: 100, h0: 48 });
    expect(revenue.p).toEqual({ h0: "F" });
  });

  it("stays within 9 columns and 8192 bytes of props for a 40-period stock", () => {
    const fixture = fortyPeriods();
    expect(fixture.periods).toHaveLength(40);
    const shaped = shapeStatements(fixture)!;
    expect(shaped.columns.length).toBeLessThanOrEqual(MAX_STATEMENT_COLUMNS);
    expect(shaped.columns.map((c) => c.k)).toEqual([
      "t",
      "a0",
      "a1",
      "a2",
      "a3",
      "h0",
      "h1",
      "h2",
      "h3",
    ]);
    const bytes = new TextEncoder().encode(JSON.stringify(shaped)).length;
    expect(bytes).toBeLessThanOrEqual(8192);
  });
});
