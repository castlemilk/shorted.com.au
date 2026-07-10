import { describe, it, expect } from "@jest/globals";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { FinancialStatementsCard } from "../financial-statements-card";
import type { FinancialStatements } from "~/@/types/company-metadata";

/**
 * Realistic mock mirroring the dev-API shape for an enriched large cap
 * (validated against CBA/BHP GetStockDetails): yfinance metric names,
 * RAW dollar magnitudes, sparse coverage. Two statements × three periods,
 * including a null metric (FY23 Free Cash Flow) and a period missing
 * entirely from one statement (income statement has no 2023 period).
 */
function mockStatements(): FinancialStatements {
  return {
    stock_code: "TST",
    success: true,
    annual: {
      income_statement: {
        "2025-06-30": {
          "Total Revenue": 1_200_000_000,
          "Net Income": -340_000_000,
          "Basic EPS": 2.345,
        },
        "2024-06-30": {
          "Total Revenue": 980_000_000,
          "Net Income": 210_000_000,
          "Basic EPS": 1.1,
        },
        // 2023 period missing from the income statement entirely.
      },
      cash_flow: {
        "2025-06-30": {
          "Operating Cash Flow": 450_000_000,
          "Free Cash Flow": 12_000,
        },
        "2024-06-30": {
          "Operating Cash Flow": 380_000_000,
          "Free Cash Flow": 95_000_000,
        },
        "2023-06-30": {
          "Operating Cash Flow": 310_000_000,
          "Free Cash Flow": null,
        },
      },
    },
    info: {},
    error: null,
  };
}

function emptyStatements(): FinancialStatements {
  return {
    stock_code: "TST",
    success: false,
    annual: {},
    info: {},
    error: null,
  };
}

describe("FinancialStatementsCard", () => {
  it("renders the card chrome and only the statement tabs that have data", () => {
    render(<FinancialStatementsCard statements={mockStatements()} />);

    expect(screen.getByText("Financial statements")).toBeInTheDocument();
    expect(
      screen.getByText(/Annual results · Source: Yahoo Finance/),
    ).toBeInTheDocument();

    expect(screen.getByRole("tab", { name: "Income" })).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: "Cash flow" })).toBeInTheDocument();
    // No balance sheet data → no balance sheet tab.
    expect(
      screen.queryByRole("tab", { name: "Balance sheet" }),
    ).not.toBeInTheDocument();

    // No quarterly data → no period toggle.
    expect(
      screen.queryByRole("group", { name: "Reporting period" }),
    ).not.toBeInTheDocument();
  });

  it("renders FY column headers newest-first and formats currency and EPS values", () => {
    render(<FinancialStatementsCard statements={mockStatements()} />);

    const incomePanel = screen.getByRole("tabpanel");
    const headers = within(incomePanel)
      .getAllByRole("columnheader")
      .map((cell) => cell.textContent);
    expect(headers).toEqual(["Metric", "FY25", "FY24"]);

    // Compact AUD in raw dollars: $1.2B, negative as -$340M.
    expect(within(incomePanel).getByText("$1.2B")).toBeInTheDocument();
    expect(within(incomePanel).getByText("-$340M")).toBeInTheDocument();
    // EPS rows render plain dollars.
    expect(within(incomePanel).getByText("$2.35")).toBeInTheDocument();
    // Curated rows absent from the data (Gross Profit, Operating Income)
    // do not render.
    expect(
      within(incomePanel).queryByText("Gross profit"),
    ).not.toBeInTheDocument();
  });

  it("switches statements, includes sparse periods, and renders null metrics as em dashes", async () => {
    const user = userEvent.setup();
    render(<FinancialStatementsCard statements={mockStatements()} />);

    await user.click(screen.getByRole("tab", { name: "Cash flow" }));

    const cashFlowPanel = screen.getByRole("tabpanel");
    const headers = within(cashFlowPanel)
      .getAllByRole("columnheader")
      .map((cell) => cell.textContent);
    expect(headers).toEqual(["Metric", "FY25", "FY24", "FY23"]);

    expect(within(cashFlowPanel).getByText("$450M")).toBeInTheDocument();
    // Small raw-dollar value uses the k tier.
    expect(within(cashFlowPanel).getByText("$12k")).toBeInTheDocument();
    // FY23 Free Cash Flow is null → em dash placeholder.
    expect(within(cashFlowPanel).getByText("—")).toBeInTheDocument();
  });

  it("returns null when no statement group has data", () => {
    const { container } = render(
      <FinancialStatementsCard statements={emptyStatements()} />,
    );
    expect(container).toBeEmptyDOMElement();
  });
});
