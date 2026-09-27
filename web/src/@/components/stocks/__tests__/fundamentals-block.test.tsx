import { describe, expect, it } from "@jest/globals";
import "@testing-library/jest-dom";
import { render, screen, within } from "@testing-library/react";
import {
  FundamentalsBlock,
  basisLabel,
  formatCompactAmount,
  formatPerShare,
  isTurnaround,
} from "../fundamentals-block";
import type {
  StockFundamentals,
  StockFundamentalsGrowth,
  StockFundamentalsPeriod,
} from "~/app/actions/getStockFundamentals";

function period(
  overrides: Partial<StockFundamentalsPeriod> = {},
): StockFundamentalsPeriod {
  return {
    periodEnd: "2025-06-30",
    fiscalYear: 2025,
    currency: "USD",
    revenue: 55_658_000_000,
    netIncome: 9_010_000_000,
    epsDiluted: 1.7734,
    operatingCashFlow: 18_690_000_000,
    ...overrides,
  };
}

function growth(
  overrides: Partial<StockFundamentalsGrowth> = {},
): StockFundamentalsGrowth {
  return {
    basisPeriodType: "annual",
    revenueBasisPeriodType: "annual",
    revenueYoyPct: null,
    epsYoyPct: null,
    revenueHalfYoyPct: null,
    epsHalfYoyPct: null,
    halfLatestPeriodEnd: "",
    ...overrides,
  };
}

function bhp(overrides: Partial<StockFundamentals> = {}): StockFundamentals {
  return {
    stockCode: "BHP",
    periods: [
      period(),
      period({
        periodEnd: "2024-06-30",
        fiscalYear: 2024,
        revenue: 55_658_000_000 * 0.9,
        netIncome: 7_897_000_000,
        epsDiluted: 1.5512,
      }),
      period({
        periodEnd: "2023-06-30",
        fiscalYear: 2023,
        operatingCashFlow: null,
      }),
      period({ periodEnd: "2022-06-30", fiscalYear: 2022, epsDiluted: null }),
    ],
    growth: growth({
      basisPeriodType: "ttm",
      revenueBasisPeriodType: "annual",
      revenueYoyPct: 11.1,
      epsYoyPct: -4.25,
    }),
    ...overrides,
  };
}

describe("FundamentalsBlock", () => {
  it("renders nothing without coverage, so pages for uncovered stocks do not change", () => {
    const { container: none } = render(
      <FundamentalsBlock fundamentals={null} />,
    );
    expect(none).toBeEmptyDOMElement();

    const { container: empty } = render(
      <FundamentalsBlock
        fundamentals={{ stockCode: "XYZ", periods: [], growth: null }}
      />,
    );
    expect(empty).toBeEmptyDOMElement();
  });

  it("renders the last four annual periods in the reporting currency, stated once", () => {
    render(<FundamentalsBlock fundamentals={bhp()} />);

    const region = screen.getByRole("region", {
      name: /reported fundamentals/i,
    });
    expect(
      within(region).getByText("Last 4 financial years, figures in USD"),
    ).toBeInTheDocument();

    const table = within(region).getByRole("table");
    const headers = within(table)
      .getAllByRole("columnheader")
      .map((h) => h.textContent);
    expect(headers).toEqual(["Line item", "FY25", "FY24", "FY23", "FY22"]);
    expect(
      within(table).getByRole("columnheader", { name: "FY25" }),
    ).toHaveAttribute("title", "Year ended 30 June 2025");

    const rowLabels = within(table)
      .getAllByRole("rowheader")
      .map((h) => h.textContent);
    expect(rowLabels).toEqual([
      "Revenue",
      "NPAT",
      "Diluted EPS",
      "Operating cash flow",
    ]);

    const revenue = within(table).getByRole("row", { name: /^Revenue/ });
    expect(
      within(revenue)
        .getAllByRole("cell")
        .map((c) => c.textContent),
    ).toEqual(["55.66B", "50.09B", "55.66B", "55.66B"]);
    const eps = within(table).getByRole("row", { name: /^Diluted EPS/ });
    expect(
      within(eps)
        .getAllByRole("cell")
        .map((c) => c.textContent),
    ).toEqual(["1.77", "1.55", "1.77", "n/a"]);
    const ocf = within(table).getByRole("row", {
      name: /^Operating cash flow/,
    });
    expect(within(ocf).getAllByRole("cell")[2]).toHaveTextContent("n/a");

    // Never a "$": that would read as AUD for a USD reporter.
    expect(region.textContent).not.toContain("$");
    expect(table).toHaveClass("tabular-nums", "font-mono");
  });

  it("states growth with the EPS basis and the provenance line", () => {
    render(<FundamentalsBlock fundamentals={bhp()} />);
    const region = screen.getByRole("region", {
      name: /reported fundamentals/i,
    });
    const text = region.textContent ?? "";
    expect(text).toContain("revenue +11.1% YoY (annual)");
    expect(text).toContain("EPS −4.3% YoY (TTM)");
    expect(text).not.toContain("prior loss, now profit");
    expect(text).toContain(
      "Company-filed figures via market data provider; reporting currency; not financial advice.",
    );
    // DESIGN.md: no em dashes in UI copy.
    expect(text).not.toContain("—");
    // No half-year figures: no half line and no filing provenance.
    expect(text).not.toContain("same half a year earlier");
    expect(text).not.toContain("half-year filings");
  });

  it("labels revenue and EPS on the half basis and names the filings", () => {
    render(
      <FundamentalsBlock
        fundamentals={bhp({
          growth: growth({
            basisPeriodType: "half",
            revenueBasisPeriodType: "half",
            revenueYoyPct: 22.04,
            epsYoyPct: 31.2,
            revenueHalfYoyPct: 22.04,
            epsHalfYoyPct: 31.2,
            halfLatestPeriodEnd: "2025-12-31",
          }),
        })}
      />,
    );
    const region = screen.getByRole("region", {
      name: /reported fundamentals/i,
    });
    const text = region.textContent ?? "";
    expect(text).toContain("revenue +22.0% YoY (half-year)");
    expect(text).toContain("EPS +31.2% YoY (half-year)");
    expect(text).not.toContain("(annual)");
    // Both headlines already are the half figures: no duplicate line.
    expect(text).not.toContain("Half-year to");
    expect(text).toContain(
      "Company-filed figures via market data provider and ASX half-year filings; reporting currency; not financial advice.",
    );
  });

  it("shows the half-year line when the headline basis is annual or TTM", () => {
    render(
      <FundamentalsBlock
        fundamentals={bhp({
          growth: growth({
            basisPeriodType: "ttm",
            revenueBasisPeriodType: "annual",
            revenueYoyPct: 11.1,
            epsYoyPct: 8,
            revenueHalfYoyPct: 4.26,
            epsHalfYoyPct: null,
            halfLatestPeriodEnd: "2025-12-31",
          }),
        })}
      />,
    );
    const text =
      screen.getByRole("region", { name: /reported fundamentals/i })
        .textContent ?? "";
    expect(text).toContain("revenue +11.1% YoY (annual)");
    expect(text).toContain("EPS +8.0% YoY (TTM)");
    expect(text).toContain(
      "Half-year to Dec 2025: revenue +4.3% · EPS n/a vs the same half a year earlier",
    );
    expect(text).toContain("and ASX half-year filings");
    expect(text).not.toContain("—");
  });

  it("reads n/a for missing growth and says prior loss, now profit on a turnaround", () => {
    render(
      <FundamentalsBlock
        fundamentals={bhp({
          periods: [
            period({ netIncome: 120_000_000 }),
            period({
              periodEnd: "2024-06-30",
              fiscalYear: 2024,
              netIncome: -45_000_000,
            }),
          ],
          growth: growth({ revenueBasisPeriodType: "" }),
        })}
      />,
    );
    const region = screen.getByRole("region", {
      name: /reported fundamentals/i,
    });
    const text = region.textContent ?? "";
    expect(text).toContain("Last 2 financial years");
    expect(text).toContain("revenue n/a YoY (annual)");
    expect(text).toContain("EPS n/a YoY (annual)");
    expect(text).toContain("prior loss, now profit");
    const npat = within(region).getByRole("row", { name: /^NPAT/ });
    expect(
      within(npat)
        .getAllByRole("cell")
        .map((c) => c.textContent),
    ).toEqual(["120.0M", "−45.0M"]);
  });

  it("puts the currency under each column when a company switched reporting currency", () => {
    render(
      <FundamentalsBlock
        fundamentals={bhp({
          periods: [
            period({ currency: "USD" }),
            period({
              periodEnd: "2024-06-30",
              fiscalYear: null,
              currency: "AUD",
            }),
          ],
          growth: null,
        })}
      />,
    );
    const region = screen.getByRole("region", {
      name: /reported fundamentals/i,
    });
    expect(
      within(region).getByText(
        "Last 2 financial years, reporting currency varies by year",
      ),
    ).toBeInTheDocument();
    const headers = within(region)
      .getAllByRole("columnheader")
      .map((h) => h.textContent);
    expect(headers).toEqual(["Line item", "FY25USD", "Jun 2024AUD"]);
  });
});

describe("formatters", () => {
  it("names every growth basis", () => {
    expect(basisLabel("ttm")).toBe("TTM");
    expect(basisLabel("annual")).toBe("annual");
    expect(basisLabel("half")).toBe("half-year");
  });

  it("formats compact amounts with a true minus and n/a for missing", () => {
    expect(formatCompactAmount(1_234_000_000_000)).toBe("1.23T");
    expect(formatCompactAmount(55_658_000_000)).toBe("55.66B");
    expect(formatCompactAmount(-412_340_000)).toBe("−412.3M");
    expect(formatCompactAmount(85_200)).toBe("85.2K");
    expect(formatCompactAmount(512)).toBe("512");
    expect(formatCompactAmount(0)).toBe("0");
    expect(formatCompactAmount(null)).toBe("n/a");
  });

  it("formats per-share amounts, keeping a third digit under ten cents", () => {
    expect(formatPerShare(1.7734)).toBe("1.77");
    expect(formatPerShare(-0.0451)).toBe("−0.045");
    expect(formatPerShare(0)).toBe("0.00");
    expect(formatPerShare(null)).toBe("n/a");
  });

  it("calls a turnaround only for consecutive reported years, loss then profit", () => {
    const profit = period({ netIncome: 10 });
    const loss = period({ periodEnd: "2024-06-30", netIncome: -5 });
    expect(isTurnaround([profit, loss])).toBe(true);
    expect(
      isTurnaround([profit, period({ periodEnd: "2024-06-30", netIncome: 0 })]),
    ).toBe(true);
    expect(
      isTurnaround([profit, period({ periodEnd: "2024-06-30", netIncome: 3 })]),
    ).toBe(false);
    expect(isTurnaround([period({ netIncome: -1 }), loss])).toBe(false);
    expect(
      isTurnaround([
        profit,
        period({ periodEnd: "2024-06-30", netIncome: null }),
      ]),
    ).toBe(false);
    // A gap year is not "the prior year".
    expect(
      isTurnaround([
        profit,
        period({ periodEnd: "2023-06-30", netIncome: -5 }),
      ]),
    ).toBe(false);
    expect(isTurnaround([profit])).toBe(false);
  });
});
