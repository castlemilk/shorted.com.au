import { render, screen, within } from "@testing-library/react";
import type { FinancialReport } from "~/@/types/company-metadata";
import {
  FinancialReports,
  SOURCE_DOCUMENT_MARK,
  hasListedReports,
  listedReports,
} from "../financial-reports";

const NOW = new Date("2026-09-28T02:00:00Z"); // 28 Sep 2026, noon in Sydney

function report(overrides: Partial<FinancialReport>): FinancialReport {
  return {
    title: "Report",
    date: "2026-01-01",
    type: "financial_report",
    url: "https://www.asx.com.au/asxpdf/x.pdf",
    source: "ASX",
    gcs_url: null,
    ...overrides,
  };
}

const REPORTS: FinancialReport[] = [
  report({ title: "Half year report", date: "2026-02-17", type: "half_year_report", url: "https://www.asx.com.au/h1.pdf" }),
  report({ title: "Appendix 4E", date: "2026-08-19", type: "annual_report", url: "https://www.asx.com.au/4e.pdf" }),
  report({ title: "AGM notice", date: "2026-10-30", type: "other", url: "https://www.asx.com.au/agm.pdf" }),
  report({ title: "Undated", date: null, url: "https://www.asx.com.au/undated.pdf" }),
  report({ title: "No link", url: "" }),
];

describe("FinancialReports", () => {
  it("lists linkable filings newest first and drops future-dated rows", () => {
    render(<FinancialReports reports={REPORTS} stockCode="WES" now={NOW} />);
    const titles = within(screen.getByRole("list"))
      .getAllByRole("link")
      .map((a) => a.querySelector("span")?.textContent);
    expect(titles).toEqual(["Appendix 4E", "Half year report", "Undated"]);
    expect(screen.queryByText("AGM notice")).not.toBeInTheDocument();
    expect(screen.getByText("19 Aug 2026")).toBeInTheDocument();
  });

  it("marks the filing the Latest result's figures come from", () => {
    render(
      <FinancialReports
        reports={REPORTS}
        stockCode="WES"
        now={NOW}
        sourceDocumentUrl="https://www.asx.com.au/4e.pdf/"
      />,
    );
    const marked = screen.getByText(SOURCE_DOCUMENT_MARK).closest("a")!;
    expect(marked).toHaveAttribute("href", "https://www.asx.com.au/4e.pdf");
    expect(screen.getAllByText(SOURCE_DOCUMENT_MARK)).toHaveLength(1);
    expect(SOURCE_DOCUMENT_MARK.toLowerCase()).toBe("figures above come from this filing");
  });

  it("draws type pills from the design tokens, never raw palette colours", () => {
    render(<FinancialReports reports={REPORTS} stockCode="WES" now={NOW} />);
    const pill = screen.getByText("Annual Report");
    expect(pill.className).toContain("text-primary");
    const all = Array.from(document.querySelectorAll("span")).map((s) => s.className).join(" ");
    expect(all).not.toMatch(/orange-|lime-|emerald-|amber-\d/);
  });

  it("never drops the marked filing past the first ten", () => {
    const many = Array.from({ length: 14 }, (_, i) =>
      report({
        title: `Report ${i}`,
        date: `2025-0${(i % 9) + 1}-01`,
        url: `https://www.asx.com.au/r${i}.pdf`,
      }),
    );
    const oldest = report({ title: "Oldest", date: "2019-01-01", url: "https://www.asx.com.au/old.pdf" });
    const { shown, total } = listedReports([...many, oldest], "https://www.asx.com.au/old.pdf", NOW);
    expect(total).toBe(15);
    expect(shown).toHaveLength(11);
    expect(shown[shown.length - 1]!.isSourceDocument).toBe(true);
  });

  it("knows when there is nothing to list", () => {
    expect(hasListedReports([], NOW)).toBe(false);
    expect(hasListedReports([report({ date: "2027-01-01" })], NOW)).toBe(false);
    expect(hasListedReports(REPORTS, NOW)).toBe(true);
    const { container } = render(<FinancialReports reports={[]} stockCode="WES" now={NOW} />);
    expect(container).toBeEmptyDOMElement();
  });
});
