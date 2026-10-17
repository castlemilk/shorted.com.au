import { render, screen } from "@testing-library/react";
import {
  FundamentalsSummary,
  fundamentalsSummarySentences,
} from "../fundamentals-summary";
import { period, quality, wesLike } from "./fixtures";

describe("FundamentalsSummary", () => {
  it("states the latest result, the prior year, growth and ratios, with provenance", () => {
    render(
      <FundamentalsSummary
        stockCode="WES"
        companyName="Wesfarmers"
        fundamentals={wesLike()}
      />,
    );
    expect(screen.getByRole("heading", { name: "WES fundamentals" })).toBeInTheDocument();
    const text = screen.getByText(/In the year to 30 Jun 2026/).textContent!;
    expect(text).toContain(
      "In the year to 30 Jun 2026, Wesfarmers (ASX:WES) recorded revenue of A$44.0B and net profit after tax of A$2.9B.",
    );
    expect(text).toContain("A year earlier it recorded revenue of A$43.0B");
    expect(text).toContain("Year-on-year growth: revenue +8.4% (FY), EPS +12.1% (FY).");
    expect(text).toContain("Net margin 9.1%, return on equity 18.4% (FY).");
    expect(text).toContain("Figures are in AUD, the company's reporting currency; source: Yahoo Finance, as at 28 Sep 2026.");
    expect(text).not.toContain("—");
  });

  it("marks a non-AUD reporter's amounts so they cannot be read as AUD", () => {
    const f = wesLike();
    const usd = { ...f, periods: f.periods.map((p) => ({ ...p, currency: "USD" })) };
    const sentences = fundamentalsSummarySentences("BHP Group", "BHP", usd)!;
    expect(sentences[0]).toContain("revenue of US$44.0B");
    expect(sentences.join(" ")).toContain("Figures are in USD");
  });

  it("writes a loss as a loss", () => {
    const sentences = fundamentalsSummarySentences("Loss Co", "LSS", {
      ...wesLike(),
      periods: [period({ periodType: "annual", periodEnd: "2026-06-30", netIncome: -12_300_000 })],
      growth: null,
      quality: null,
    })!;
    expect(sentences[0]).toBe(
      "In the year to 30 Jun 2026, Loss Co (ASX:LSS) recorded a net loss after tax of A$12.3M.",
    );
  });

  it("omits growth outside the displayed range and withheld ratios, never guessing", () => {
    const sentences = fundamentalsSummarySentences("Wesfarmers", "WES", {
      ...wesLike(),
      growth: { ...wesLike().growth!, revenueYoyPct: 900, epsYoyPct: null },
      quality: quality({ netMarginPct: null, roePct: null }),
    })!;
    const text = sentences.join(" ");
    expect(text).not.toContain("Year-on-year growth");
    expect(text).not.toContain("margin");
  });

  describe("source attribution (per quoted field, never the row alone)", () => {
    // A Yahoo annual row whose revenue and NPAT Yahoo left NULL, filled by the
    // filings ingest: the row keeps source 'yahoo-timeseries' and records the
    // fill only in field_sources (contract §2.2, §3.6).
    function filled(
      fieldSources: Record<string, string>,
      extra: Partial<Parameters<typeof period>[0]> = {},
    ) {
      return {
        ...wesLike(),
        periods: [
          period({
            periodType: "annual",
            periodEnd: "2026-06-30",
            revenue: 510_000_000,
            netIncome: 42_000_000,
            fieldSources,
            ...extra,
          }),
        ],
        growth: null,
        quality: null,
      };
    }

    it("credits filing-filled revenue and NPAT to the filing, not the row's vendor", () => {
      const text = fundamentalsSummarySentences(
        "XYZ Ltd",
        "XYZ",
        filled({
          revenue: "asx-filing-extraction",
          net_income: "asx-filing-extraction",
        }),
      )!.join(" ");
      expect(text).toContain(
        "Figures are in AUD, the company's reporting currency; source: Company filing (extracted), as at 28 Sep 2026.",
      );
      expect(text).not.toContain("Yahoo Finance");
    });

    it("names each distinct source when the quoted figures come from different places", () => {
      const text = fundamentalsSummarySentences(
        "XYZ Ltd",
        "XYZ",
        filled({ revenue: "asx-filing-extraction" }),
      )!.join(" ");
      expect(text).toContain(
        "source: Company filing (extracted) and Yahoo Finance, as at",
      );
    });

    it("credits a Markit-filled year to Markit", () => {
      const text = fundamentalsSummarySentences(
        "Xero",
        "XRO",
        filled(
          { revenue: "markit-key-statistics", net_income: "markit-key-statistics" },
          { currency: "NZD" },
        ),
      )!.join(" ");
      expect(text).toContain("source: ASX (Markit), as at");
      expect(text).not.toContain("Yahoo Finance");
    });

    it("counts the prior year's quoted figures and a filing-based growth basis", () => {
      const f = wesLike();
      const periods = f.periods.map((p) =>
        p.periodType === "annual" && p.periodEnd === "2025-06-30"
          ? { ...p, fieldSources: { revenue: "markit-key-statistics" } }
          : p,
      );
      const text = fundamentalsSummarySentences("Wesfarmers", "WES", {
        ...f,
        periods,
        growth: { ...f.growth!, epsBasisSource: "filing" },
      })!.join(" ");
      expect(text).toContain(
        "source: Yahoo Finance, ASX (Markit) and Company filing (extracted), as at",
      );
    });

    it("credits the ratio sentence's inputs from the ratio basis period", () => {
      const f = wesLike();
      // The ratios read the TTM row; its NPAT came from a filing.
      const periods = f.periods.map((p) =>
        p.periodType === "ttm"
          ? { ...p, fieldSources: { net_income: "asx-filing-extraction" } }
          : p,
      );
      const text = fundamentalsSummarySentences("Wesfarmers", "WES", {
        ...f,
        periods,
        growth: null,
        quality: quality({ basisPeriodType: "ttm", basisPeriodEnd: "2026-06-30" }),
      })!.join(" ");
      expect(text).toContain("Net margin 9.1%, return on equity 18.4% (TTM).");
      expect(text).toContain(
        "source: Yahoo Finance and Company filing (extracted), as at",
      );
    });
  });

  it("is omitted without a held result", () => {
    expect(fundamentalsSummarySentences("X", "X", null)).toBeNull();
    expect(
      fundamentalsSummarySentences("X", "X", { ...wesLike(), periods: [] }),
    ).toBeNull();
    const { container } = render(
      <FundamentalsSummary
        stockCode="X"
        companyName="X"
        fundamentals={{
          ...wesLike(),
          periods: [period({ periodType: "quarter", periodEnd: "2026-06-30", totalAssets: 1 })],
        }}
      />,
    );
    expect(container).toBeEmptyDOMElement();
  });
});
