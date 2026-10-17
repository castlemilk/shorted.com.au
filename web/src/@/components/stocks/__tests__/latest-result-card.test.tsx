import { render, screen, within } from "@testing-library/react";
import {
  basisLabel,
  formatGrowthPct,
} from "~/@/lib/fundamentals/format";
import { LatestResultCard, isEpsTurnaround } from "../latest-result-card";
import {
  EPS_GROWTH_LABEL,
  GrowthFigureView,
  REVENUE_GROWTH_LABEL,
  growthFigures,
} from "../growth-figures";
import { growth, period, wesLike } from "./fixtures";

describe("LatestResultCard", () => {
  it("shows the newest flow period against the prior corresponding period, with source and as-at", () => {
    render(<LatestResultCard fundamentals={wesLike()} />);
    const card = screen.getByRole("region", { name: "Latest result" });
    // The annual wins over a TTM row at the same period end.
    expect(within(card).getByText(/Year to 30 Jun 2026 \(FY26\) vs FY25/)).toBeInTheDocument();
    expect(within(card).getByText("$44.00B")).toBeInTheDocument();
    expect(within(card).getByText(/vs \$43\.00B/)).toBeInTheDocument();
    expect(within(card).getByText("$2.90B")).toBeInTheDocument();
    // Diluted EPS when present.
    expect(within(card).getByText("EPS (diluted)")).toBeInTheDocument();
    expect(within(card).getByText("$2.54")).toBeInTheDocument();
    // Source and as-at per figure (a 20:00 UTC fetch is the next day in Sydney).
    expect(within(card).getAllByText("Yahoo Finance, as at 28 Sep 2026")).toHaveLength(3);
  });

  it("uses basic EPS when diluted is absent, on both sides", () => {
    const f = wesLike();
    const basicOnly = {
      ...f,
      periods: f.periods.map((p) => ({ ...p, epsDiluted: null })),
    };
    render(<LatestResultCard fundamentals={basicOnly} />);
    expect(screen.getByText("EPS (basic)")).toBeInTheDocument();
    expect(screen.getByText("$2.55")).toBeInTheDocument();
    expect(screen.getByText(/vs \$2\.45/)).toBeInTheDocument();
  });

  it("links the filing ONLY from source_document_url", () => {
    const f = wesLike();
    const { rerender } = render(
      <LatestResultCard
        fundamentals={{
          ...f,
          latestFiling: {
            reportUrl: "https://www.asx.com.au/summary-only.pdf",
            reportTitle: "Appendix 4E and Annual Report",
            reportDate: "2026-08-28",
            periodEnd: "2026-06-30",
            periodType: "annual",
            digest: "Revenue rose on Bunnings.",
            digestConfidence: 0.9,
          },
        }}
      />,
    );
    // No source_document_url: no filing link, even with a summary present.
    expect(screen.queryByRole("link")).not.toBeInTheDocument();
    expect(
      screen.getByText("Summary of Appendix 4E and Annual Report, 28 Aug 2026"),
    ).toBeInTheDocument();
    expect(screen.getByText("Revenue rose on Bunnings.")).toBeInTheDocument();

    const filed = {
      ...f,
      periods: f.periods.map((p, i) =>
        i === 1
          ? {
              ...p,
              sourceDocumentUrl: "https://www.asx.com.au/asxpdf/20260828/pdf/abc.pdf",
              sourceDocumentDate: "2026-08-28",
            }
          : p,
      ),
    };
    rerender(<LatestResultCard fundamentals={filed} />);
    const link = screen.getByRole("link", { name: /Company filing, 28 Aug 2026/ });
    expect(link).toHaveAttribute(
      "href",
      "https://www.asx.com.au/asxpdf/20260828/pdf/abc.pdf",
    );
  });

  it("never renders the old raw extraction tiles", () => {
    const { container } = render(<LatestResultCard fundamentals={wesLike()} />);
    expect(screen.queryByText("Results summary")).not.toBeInTheDocument();
    expect(container.textContent).not.toMatch(/value_millions|H1 FY2025/);
  });

  it("marks a filing-extracted figure and explains the mark", () => {
    const f = wesLike();
    const marked = {
      ...f,
      periods: f.periods.map((p, i) =>
        i === 1 ? { ...p, fieldSources: { revenue: "asx-filing-extraction" } } : p,
      ),
    };
    render(<LatestResultCard fundamentals={marked} />);
    expect(screen.getByText(/Company filing \(extracted\), as at/)).toBeInTheDocument();
    expect(
      within(screen.getByRole("list", { name: "Source marks" })).getByText(
        "Company filing (extracted)",
      ),
    ).toBeInTheDocument();
  });

  it("renders nothing without a result, a growth row or a filing summary", () => {
    const { container } = render(
      <LatestResultCard
        fundamentals={{ ...wesLike(), periods: [], growth: null, latestFiling: null }}
      />,
    );
    expect(container).toBeEmptyDOMElement();
  });
});

describe("growth row: the picker's labels and figures", () => {
  // The picker's growth cells read the same shared vocabulary
  // (lib/fundamentals/format.ts). One fixture through this row must produce
  // exactly what that vocabulary produces for the picker.
  const fixture = growth({
    revenueBasisPeriodType: "ttm",
    revenueYoyPct: 812.4,
    revenueLatestPeriodEnd: "2025-12-31",
    basisPeriodType: "half",
    latestPeriodEnd: "2025-12-31",
    epsYoyPct: -17.26,
    epsBasisSource: "filing",
  });

  it("states each figure as formatGrowthPct + basisLabel", () => {
    const [revenue, eps] = growthFigures(fixture);
    expect(revenue).toMatchObject({
      label: REVENUE_GROWTH_LABEL,
      text: formatGrowthPct(812.4).text,
      basis: basisLabel("ttm"),
      fromFiling: false,
    });
    expect(revenue!.text).toBe("n/m");
    expect(revenue!.title).toContain("12 months to 31 Dec 2025");
    expect(revenue!.title).toContain(formatGrowthPct(812.4).title!);
    expect(eps).toMatchObject({
      label: EPS_GROWTH_LABEL,
      text: formatGrowthPct(-17.26).text,
      basis: "HY",
      fromFiling: true,
    });
    expect(REVENUE_GROWTH_LABEL).toBe("Rev YoY");
    expect(EPS_GROWTH_LABEL).toBe("EPS YoY");
  });

  it("renders the figure, the basis tag and the filing mark", () => {
    const [, eps] = growthFigures(fixture);
    render(
      <dl>
        <GrowthFigureView figure={eps!} />
      </dl>,
    );
    expect(screen.getByText("EPS YoY")).toBeInTheDocument();
    expect(screen.getByText("−17.3%")).toBeInTheDocument();
    expect(screen.getByText("HY")).toBeInTheDocument();
    expect(screen.getByText(/\(source: Company filing \(extracted\)\)/)).toBeInTheDocument();
  });

  it("reads an older API's empty revenue basis as FY", () => {
    const [revenue] = growthFigures(growth({ revenueBasisPeriodType: "" }));
    expect(revenue!.basis).toBe("FY");
  });
});

describe("isEpsTurnaround", () => {
  it("is judged on the EPS basis, only when the growth figure is unknown", () => {
    const periods = [
      period({ periodType: "half", periodEnd: "2025-12-31", epsBasic: 0.12 }),
      period({ periodType: "half", periodEnd: "2024-12-31", epsBasic: -0.05 }),
    ];
    const g = growth({ basisPeriodType: "half", latestPeriodEnd: "2025-12-31", epsYoyPct: null });
    expect(isEpsTurnaround(periods, g)).toBe(true);
    expect(isEpsTurnaround(periods, { ...g, epsYoyPct: 40 })).toBe(false);
    // A different basis (annual) holds no such pair: not a turnaround claim.
    expect(isEpsTurnaround(periods, { ...g, basisPeriodType: "annual" })).toBe(false);
  });
});
