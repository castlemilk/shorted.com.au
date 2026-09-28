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
