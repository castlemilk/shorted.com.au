import { render, screen, within } from "@testing-library/react";
import { KeyRatiosCard, ratioItems } from "../key-ratios-card";
import { period, quality } from "./fixtures";

function valueOf(label: string): HTMLElement {
  const term = screen.getByText(label, { selector: "dt" });
  return term.nextElementSibling as HTMLElement;
}

describe("KeyRatiosCard", () => {
  it("shows every ratio with its basis, balance date and as-at", () => {
    render(
      <KeyRatiosCard
        quality={quality()}
        basisPeriod={period({
          periodType: "annual",
          periodEnd: "2026-06-30",
          fetchedAt: "2026-09-27T20:00:00Z",
        })}
      />,
    );
    const card = screen.getByRole("region", { name: "Key ratios" });
    expect(within(card).getByText(/Year to 30 Jun 2026 \(FY\)/)).toBeInTheDocument();
    expect(within(card).getByText(/balance sheet at 30 Jun 2026/)).toBeInTheDocument();
    expect(within(card).getByText(/prices to 26 Sep 2026/)).toBeInTheDocument();
    expect(valueOf("Gross margin")).toHaveTextContent("34.2%");
    expect(valueOf("ROE")).toHaveTextContent("18.4%");
    expect(valueOf("FCF conversion")).toHaveTextContent("0.81×");
    expect(valueOf("Net debt (excl. leases)")).toHaveTextContent("$1.25B");
    expect(valueOf("Net debt / EBITDA")).toHaveTextContent("1.3×");
    expect(valueOf("Current ratio")).toHaveTextContent("1.4×");
    expect(valueOf("Cash dividends paid / net profit")).toHaveTextContent("62.5%");
    expect(valueOf("Market cap")).toHaveTextContent("$44.30B");
    expect(valueOf("P/E")).toHaveTextContent("21.4×");
    expect(valueOf("P/B")).toHaveTextContent("3.1×");
    expect(within(card).getByText(/Source: Yahoo Finance, as at 28 Sep 2026/)).toBeInTheDocument();
  });

  it("reads net cash for a negative net debt, and >100x interest cover", () => {
    render(
      <KeyRatiosCard
        quality={quality({ netDebt: -318_000_000, interestCover: 250 })}
        basisPeriod={null}
      />,
    );
    expect(valueOf("Net cash (excl. leases)")).toHaveTextContent("$318.0M");
    expect(valueOf("Interest cover")).toHaveTextContent(">100×");
  });

  it("renders n/m (with its title) for ratios withheld from a financial", () => {
    render(
      <KeyRatiosCard
        quality={quality({
          isFinancial: true,
          grossMarginPct: null,
          netDebt: null,
          currentRatio: null,
          notMeaningful: ["gross_margin_pct", "net_debt", "current_ratio"],
        })}
        basisPeriod={null}
      />,
    );
    expect(valueOf("Gross margin")).toHaveTextContent("n/m");
    expect(valueOf("Gross margin")).toHaveAttribute(
      "title",
      "Not meaningful for banks, insurers and other financials",
    );
    expect(valueOf("Net debt (excl. leases)")).toHaveTextContent("n/m");
    expect(valueOf("Current ratio")).toHaveTextContent("n/m");
    // Not withheld, simply held: net margin still shows.
    expect(valueOf("Net margin")).toHaveTextContent("9.1%");
    expect(
      screen.getByText(/n\/m: not meaningful for banks, insurers and other financials/),
    ).toBeInTheDocument();
  });

  it("reads P/E and P/B as n/a (reports in USD) for a non-AUD reporter; USD amounts carry the code", () => {
    render(
      <KeyRatiosCard
        quality={quality({
          currency: "USD",
          balanceCurrency: "USD",
          peRatio: null,
          priceToBook: null,
          valuationNote: "non-aud",
          netDebt: 4_290_000_000,
        })}
        basisPeriod={null}
      />,
    );
    expect(valueOf("P/E")).toHaveTextContent("n/a (reports in USD)");
    expect(valueOf("P/B")).toHaveTextContent("n/a (reports in USD)");
    // The card mixes an AUD market cap with USD balance figures.
    expect(valueOf("Net debt (excl. leases)")).toHaveTextContent("USD 4.29B");
    expect(valueOf("Market cap")).toHaveTextContent("$44.30B");
  });

  it("says why market cap is absent, and n/a for a ratio simply not held", () => {
    const items = ratioItems(
      quality({ marketCap: null, valuationNote: "no-shares", roePct: null }),
    );
    expect(items.find((i) => i.name === "market_cap")!.value.text).toBe(
      "n/a (no share count held)",
    );
    expect(items.find((i) => i.name === "roe_pct")!.value.text).toBe("n/a");
  });

  describe("P/E reason", () => {
    function peText(overrides: Parameters<typeof quality>[0]): string {
      return ratioItems(quality({ peRatio: null, ...overrides })).find(
        (i) => i.name === "pe_ratio",
      )!.value.text;
    }

    it("never blames the share count for a P/E it does not need (a loss, stale EPS)", () => {
      // Valuate sets 'no-shares' for a stale share count yet still computes
      // P/E from close / EPS: a null P/E under that note has another cause.
      const items = ratioItems(
        quality({
          netMarginPct: -12,
          peRatio: null,
          marketCap: null,
          priceToBook: null,
          valuationNote: "no-shares",
        }),
      );
      const text = (name: string) => items.find((i) => i.name === name)!.value.text;
      expect(text("pe_ratio")).toBe("n/a");
      // Market cap and P/B do need the share count: the note still governs them.
      expect(text("market_cap")).toBe("n/a (no share count held)");
      expect(text("price_to_book")).toBe("n/a (no share count held)");
    });

    it("keeps the notes that do govern P/E", () => {
      expect(peText({ currency: "USD", valuationNote: "non-aud" })).toBe(
        "n/a (reports in USD)",
      );
      expect(peText({ valuationNote: "listed-unit" })).toBe(
        "n/a (listed unit is not one ordinary share)",
      );
      expect(peText({ valuationNote: "no-price" })).toBe("n/a (no recent price)");
      expect(peText({ valuationNote: "" })).toBe("n/a");
    });
  });

  describe("source footer", () => {
    function footer(): string {
      return screen.getByText(/^Ratios use the reporting currency/).textContent!;
    }

    it("never credits the vendor for a filing-filled revenue or NPAT behind the ratios", () => {
      render(
        <KeyRatiosCard
          quality={quality()}
          basisPeriod={period({
            periodType: "annual",
            periodEnd: "2026-06-30",
            fetchedAt: "2026-09-27T20:00:00Z",
            fieldSources: {
              revenue: "asx-filing-extraction",
              net_income: "asx-filing-extraction",
            },
          })}
        />,
      );
      expect(footer()).toContain(
        "Sources: Yahoo Finance and Company filing (extracted), as at 28 Sep 2026.",
      );
    });

    it("names Markit when it filled the basis year", () => {
      render(
        <KeyRatiosCard
          quality={quality()}
          basisPeriod={period({
            periodType: "annual",
            periodEnd: "2026-06-30",
            fieldSources: { net_income: "markit-key-statistics" },
          })}
        />,
      );
      expect(footer()).toContain("Sources: Yahoo Finance and ASX (Markit)");
    });

    it("names one source once when every input shares it", () => {
      render(
        <KeyRatiosCard
          quality={quality({ source: "asx-filing-extraction" })}
          basisPeriod={period({
            periodType: "annual",
            periodEnd: "2026-06-30",
            source: "asx-filing-extraction",
            fieldSources: { revenue: "asx-filing-extraction" },
          })}
        />,
      );
      expect(footer()).toContain("Source: Company filing (extracted), as at");
      expect(footer()).not.toContain("Yahoo");
    });
  });

  it("adds the property caveat for a property trust", () => {
    render(<KeyRatiosCard quality={quality({ isProperty: true })} basisPeriod={null} />);
    expect(screen.getByText(/profit and EBITDA include property revaluations/)).toBeInTheDocument();
  });

  it("says when no balance sheet is aligned, and never writes an em dash", () => {
    const { container } = render(
      <KeyRatiosCard
        quality={quality({ balancePeriodEnd: "", balanceLagMonths: null, roePct: null })}
        basisPeriod={null}
      />,
    );
    expect(screen.getByText(/no balance sheet aligned with this period/)).toBeInTheDocument();
    expect(container.textContent).not.toContain("—");
  });
});
