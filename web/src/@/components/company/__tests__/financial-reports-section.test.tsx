import { Suspense, isValidElement, type ReactElement } from "react";
import { render, screen } from "@testing-library/react";
import type { FinancialReport } from "~/@/types/company-metadata";

const mockGetEnrichedCompanyMetadata = jest.fn();
jest.mock("~/app/actions/company-metadata", () => ({
  getEnrichedCompanyMetadata: (...args: unknown[]) =>
    mockGetEnrichedCompanyMetadata(...args),
}));

import {
  FilingsListedNote,
  FilingsListedNoteData,
  FinancialReportsData,
  FinancialReportsSection,
} from "../financial-reports-section";
import { SOURCE_DOCUMENT_MARK } from "../financial-reports";
import { FILINGS_LISTED_BELOW } from "~/@/components/stocks/financials-tab";

// The Financials tab's filings stream in async server components so the
// company details read (getStockDetails, with retries) never holds the page.
// A client render cannot resolve an async component, so the data components
// are awaited directly and their output rendered.

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
  report({
    title: "Appendix 4E",
    date: "2026-08-19",
    type: "annual_report",
    url: "https://www.asx.com.au/4e.pdf",
  }),
  report({
    title: "Half year report",
    date: "2026-02-17",
    type: "half_year_report",
    url: "https://www.asx.com.au/h1.pdf",
  }),
];

describe("FinancialReportsSection", () => {
  beforeEach(() => mockGetEnrichedCompanyMetadata.mockReset());

  it("wraps the read in its own Suspense boundary, with serializable props only", () => {
    const section = FinancialReportsSection({
      stockCode: "WES",
      sourceDocumentUrl: "https://www.asx.com.au/4e.pdf",
    }) as ReactElement<{ children: ReactElement }>;
    expect(section.type).toBe(Suspense);
    const child = section.props.children;
    expect(isValidElement(child)).toBe(true);
    expect(child.type).toBe(FinancialReportsData);
    expect(child.props).toEqual({
      stockCode: "WES",
      sourceDocumentUrl: "https://www.asx.com.au/4e.pdf",
    });
    // Nothing is read until the boundary renders.
    expect(mockGetEnrichedCompanyMetadata).not.toHaveBeenCalled();

    const note = FilingsListedNote({ stockCode: "WES" }) as ReactElement<{
      children: ReactElement;
    }>;
    expect(note.type).toBe(Suspense);
    expect(note.props.children.type).toBe(FilingsListedNoteData);
  });

  it("lists the filings and marks the Latest result's source document", async () => {
    mockGetEnrichedCompanyMetadata.mockResolvedValue({
      financial_reports: REPORTS,
    });
    render(
      await FinancialReportsData({
        stockCode: "WES",
        sourceDocumentUrl: "https://www.asx.com.au/4e.pdf",
      }),
    );
    expect(mockGetEnrichedCompanyMetadata).toHaveBeenCalledWith("WES");
    expect(
      screen.getByRole("region", { name: "Financial reports" }),
    ).toBeInTheDocument();
    expect(screen.getByText("Appendix 4E")).toBeInTheDocument();
    expect(screen.getAllByText(SOURCE_DOCUMENT_MARK)).toHaveLength(1);
  });

  it("renders nothing when the details read fails or holds no filings", async () => {
    mockGetEnrichedCompanyMetadata.mockRejectedValue(new Error("unavailable"));
    const failed = render(
      await FinancialReportsData({ stockCode: "WES", sourceDocumentUrl: "" }),
    );
    expect(failed.container).toBeEmptyDOMElement();
    failed.unmount();

    mockGetEnrichedCompanyMetadata.mockResolvedValue(null);
    const none = render(
      await FinancialReportsData({ stockCode: "WES", sourceDocumentUrl: "" }),
    );
    expect(none.container).toBeEmptyDOMElement();
  });
});

describe("FilingsListedNote", () => {
  beforeEach(() => mockGetEnrichedCompanyMetadata.mockReset());

  it("says the filings are listed below only when one is listed", async () => {
    mockGetEnrichedCompanyMetadata.mockResolvedValue({
      financial_reports: REPORTS,
    });
    const { container, unmount } = render(
      <p>{await FilingsListedNoteData({ stockCode: "WES" })}</p>,
    );
    expect(container.textContent).toBe(FILINGS_LISTED_BELOW);
    unmount();

    // A filing without a usable link is not listed, so it is not pointed at.
    mockGetEnrichedCompanyMetadata.mockResolvedValue({
      financial_reports: [report({ url: "" })],
    });
    expect(await FilingsListedNoteData({ stockCode: "WES" })).toBeNull();

    mockGetEnrichedCompanyMetadata.mockRejectedValue(new Error("unavailable"));
    expect(await FilingsListedNoteData({ stockCode: "WES" })).toBeNull();
  });
});
