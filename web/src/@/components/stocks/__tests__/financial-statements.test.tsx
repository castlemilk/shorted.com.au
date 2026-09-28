import { fireEvent, render, screen, within } from "@testing-library/react";
import { FinancialStatements } from "../financial-statements";
import { shapeStatements } from "../statements-shape";
import type { FinancialStatementsProps } from "../statement-lines";
import { fortyPeriods, period, wesLike } from "./fixtures";

function shaped(fundamentals = wesLike()): FinancialStatementsProps {
  const props = shapeStatements(fundamentals);
  if (!props) throw new Error("fixture shaped to null");
  return props;
}

function headers(): string[] {
  return within(screen.getByRole("table"))
    .getAllByRole("columnheader")
    .map((th) => th.textContent ?? "");
}

// Radix Tabs activates on mousedown in jsdom (it listens for pointer/mouse
// down, not click).
function selectTab(name: RegExp) {
  const tab = screen.getByRole("tab", { name });
  fireEvent.mouseDown(tab, { button: 0 });
  fireEvent.click(tab);
}

describe("FinancialStatements", () => {
  it("shows Income | Balance sheet | Cash flow with FY columns, AUD with $", () => {
    render(<FinancialStatements {...shaped()} />);
    expect(screen.getByRole("tab", { name: "Income" })).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: "Balance sheet" })).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: "Cash flow" })).toBeInTheDocument();
    expect(headers()).toEqual(["Line item", "FY26", "FY25", "FY24", "FY23"]);
    // WES's TTM equals its latest annual: no TTM column.
    expect(headers().join(" ")).not.toContain("TTM");
    expect(screen.getByRole("rowheader", { name: "Revenue" })).toBeInTheDocument();
    expect(screen.getByText("$44.00B")).toBeInTheDocument();
    expect(screen.getByText(/figures in AUD, the reporting currency/)).toBeInTheDocument();
  });

  it("renders a non-AUD reporter bare, with the currency stated once", () => {
    const f = wesLike();
    const usd = { ...f, periods: f.periods.map((p) => ({ ...p, currency: "USD" })) };
    render(<FinancialStatements {...shaped(usd)} />);
    expect(screen.getByText("44.00B")).toBeInTheDocument();
    expect(screen.queryByText("$44.00B")).not.toBeInTheDocument();
    expect(screen.getByText(/figures in USD, the reporting currency/)).toBeInTheDocument();
  });

  it("leads the income statement with TTM but never shows it on the balance sheet", () => {
    render(<FinancialStatements {...shaped(fortyPeriods())} />);
    expect(headers()[1]).toMatch(/^TTM /);
    selectTab(/Balance sheet/);
    expect(headers().join(" ")).not.toContain("TTM");
  });

  it("offers the Half toggle only when a half column carries 2+ lines", () => {
    const f = wesLike();
    const oneLine = {
      ...f,
      periods: [
        ...f.periods,
        period({ periodType: "half", periodEnd: "2025-12-31", revenue: 22_000_000_000 }),
      ],
    };
    const { unmount } = render(<FinancialStatements {...shaped(oneLine)} />);
    expect(screen.queryByRole("button", { name: "Half" })).not.toBeInTheDocument();
    unmount();

    const twoLines = {
      ...f,
      periods: [
        ...f.periods,
        period({
          periodType: "half",
          periodEnd: "2025-12-31",
          revenue: 22_000_000_000,
          netIncome: 1_500_000_000,
          source: "asx-filing-extraction",
        }),
      ],
    };
    render(<FinancialStatements {...shaped(twoLines)} />);
    const half = screen.getByRole("button", { name: "Half" });
    expect(screen.getByRole("button", { name: "Year" })).toHaveAttribute("aria-pressed", "true");
    fireEvent.click(half);
    expect(half).toHaveAttribute("aria-pressed", "true");
    expect(headers()).toEqual(["Line item", "HY26"]);
    // A line renders only when a shown column has it.
    expect(screen.queryByRole("rowheader", { name: "Gross profit" })).not.toBeInTheDocument();
    expect(screen.getByRole("rowheader", { name: "NPAT" })).toBeInTheDocument();
  });

  it("marks non-vendor cells with a glyph, screen-reader text and a legend", () => {
    const f = wesLike();
    const marked = {
      ...f,
      periods: f.periods.map((p, i) =>
        i === 1
          ? { ...p, fieldSources: { revenue: "asx-filing-extraction" } }
          : p,
      ),
    };
    render(<FinancialStatements {...shaped(marked)} />);
    // Glyph: never colour alone.
    expect(screen.getAllByText("F").length).toBeGreaterThanOrEqual(1);
    expect(screen.getByText(/\(source: Company filing \(extracted\)\)/)).toBeInTheDocument();
    const legend = screen.getByRole("list", { name: "Source marks" });
    expect(within(legend).getByText("Company filing (extracted)")).toBeInTheDocument();
  });

  it("shows n/a for a held line's missing cell, never a dash or 0", () => {
    const f = wesLike();
    const gap = {
      ...f,
      periods: f.periods.map((p, i) => (i === 2 ? { ...p, grossProfit: null } : p)),
    };
    const { container } = render(<FinancialStatements {...shaped(gap)} />);
    const row = screen.getByRole("rowheader", { name: "Gross profit" }).closest("tr")!;
    expect(within(row).getByText("n/a")).toBeInTheDocument();
    expect(container.textContent).not.toContain("—");
  });
});
