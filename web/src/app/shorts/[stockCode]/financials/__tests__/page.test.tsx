/// <reference types="jest" />
import "@testing-library/jest-dom";
import { render, screen } from "@testing-library/react";

const mockGetStockOrNotFound = jest.fn();
const mockGetStockFundamentals = jest.fn();
const mockMetadata = jest.fn().mockResolvedValue({ title: "t" });
const mockBreadcrumbs = jest.fn();
jest.mock("next/navigation", () => ({ notFound: () => { throw new Error("NEXT_NOT_FOUND"); } }));
jest.mock("next/dynamic", () => () => () => <div data-testid="dividends" />);
jest.mock("~/app/actions/getStock", () => ({ getStockOrNotFound: (...a: unknown[]) => mockGetStockOrNotFound(...a) }));
jest.mock("~/app/actions/getStockFundamentals", () => ({ getStockFundamentals: (...a: unknown[]) => mockGetStockFundamentals(...a) }));
jest.mock("~/@/lib/seo/stock-tab-metadata", () => ({ stockTabMetadata: (...a: unknown[]) => mockMetadata(...a) }));
jest.mock("~/@/components/seo/breadcrumbs", () => ({
  BreadcrumbStructuredData: (props: unknown) => {
    mockBreadcrumbs(props);
    return null;
  },
}));
jest.mock("~/@/components/stocks/financials-tab", () => ({
  FinancialsTab: ({ stockCode, fundamentals, reports, taxCard, filingsNote }: { stockCode: string; fundamentals: unknown; reports: React.ReactNode; taxCard: React.ReactNode; filingsNote: React.ReactNode }) => (
    <div data-testid="financials-tab" data-code={stockCode} data-has-fundamentals={fundamentals ? "yes" : "no"}>
      {filingsNote}{reports}{taxCard}
    </div>
  ),
}));
jest.mock("~/@/components/company/financial-reports-section", () => ({
  FinancialReportsSection: ({ stockCode, sourceDocumentUrl }: { stockCode: string; sourceDocumentUrl: string }) => (
    <div data-testid="reports-section" data-code={stockCode} data-source-document-url={sourceDocumentUrl} />
  ),
  FilingsListedNote: ({ stockCode }: { stockCode: string }) => <span data-testid="filings-note" data-code={stockCode} />,
}));
jest.mock("~/@/components/company/company-tax-card", () => ({ CompanyTaxCard: () => <div data-testid="tax-card" /> }));

import Page, { generateMetadata, generateStaticParams, revalidate, dynamicParams } from "../page";
import { NotFoundError } from "~/app/actions/withRetry";
import { period, wesLike } from "~/@/components/stocks/__tests__/fixtures";

const stock = { name: "BHP GROUP LIMITED", industry: "Materials", percentageShorted: 1.58 };

describe("/shorts/[stockCode]/financials", () => {
  beforeEach(() => {
    mockGetStockOrNotFound.mockReset();
    mockGetStockOrNotFound.mockResolvedValue(stock);
    mockGetStockFundamentals.mockReset();
    mockGetStockFundamentals.mockResolvedValue(null);
    mockMetadata.mockClear();
    mockBreadcrumbs.mockClear();
  });

  it("is on-demand ISR", () => {
    expect(revalidate).toBe(3600);
    expect(dynamicParams).toBe(true);
    expect(generateStaticParams()).toEqual([]);
  });

  it("builds its metadata through the shared builder with the tab's title", async () => {
    await generateMetadata({ params: Promise.resolve({ stockCode: "bhp" }) });
    const input = mockMetadata.mock.calls[0]![0] as { code: string; tab: string; title: (c: string) => string };
    expect(input.code).toBe("BHP");
    expect(input.tab).toBe("financials");
    expect(input.title("BHP Group")).toBe("BHP Financials: Results, Ratios & Statements | BHP Group");
  });

  it("renders the filings and the tax card even without fundamentals, dividends before tax", async () => {
    mockGetStockFundamentals.mockRejectedValue(new Error("older API"));
    const { container } = render(await Page({ params: Promise.resolve({ stockCode: "bhp" }) }));
    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent("BHP Group (BHP) financials");
    expect(screen.getByTestId("financials-tab")).toHaveAttribute("data-has-fundamentals", "no");
    expect(screen.getByTestId("reports-section")).toHaveAttribute("data-code", "BHP");
    expect(screen.getByTestId("reports-section")).toHaveAttribute("data-source-document-url", "");
    expect(screen.getByTestId("filings-note")).toHaveAttribute("data-code", "BHP");
    const order = Array.from(container.querySelectorAll("[data-testid]")).map((n) => n.getAttribute("data-testid"));
    expect(order.indexOf("dividends")).toBeLessThan(order.indexOf("tax-card"));
  });

  it("passes the latest result's source filing url through when fundamentals hold one", async () => {
    // latestResultSourceDocument reads the PERIOD the Latest result is drawn
    // from (source_document_url), so the fixture needs a flow period with a
    // headline figure for latestResultPeriod to select.
    mockGetStockFundamentals.mockResolvedValue({
      ...wesLike(),
      stockCode: "BHP",
      periods: [
        period({
          periodType: "annual",
          periodEnd: "2026-06-30",
          fiscalYear: 2026,
          revenue: 51_300_000_000,
          source: "asx-filing-extraction",
          sourceDocumentUrl: "https://example.test/fy26.pdf",
          sourceDocumentDate: "2026-08-19",
        }),
      ],
    });
    render(await Page({ params: Promise.resolve({ stockCode: "BHP" }) }));
    expect(screen.getByTestId("financials-tab")).toHaveAttribute("data-has-fundamentals", "yes");
    expect(screen.getByTestId("reports-section")).toHaveAttribute("data-source-document-url", "https://example.test/fy26.pdf");
  });

  it("takes no url from the latest filing summary, only from the latest result's own period", async () => {
    mockGetStockFundamentals.mockResolvedValue({
      ...wesLike(),
      stockCode: "BHP",
      periods: [period({ periodType: "annual", periodEnd: "2026-06-30", fiscalYear: 2026, revenue: 51_300_000_000 })],
      latestFiling: {
        reportUrl: "https://example.test/other.pdf",
        reportTitle: "FY26 results",
        reportDate: "2026-08-19",
        periodEnd: "2026-06-30",
        periodType: "annual",
        digest: "",
        digestConfidence: 0.9,
      },
    });
    render(await Page({ params: Promise.resolve({ stockCode: "BHP" }) }));
    expect(screen.getByTestId("reports-section")).toHaveAttribute("data-source-document-url", "");
  });

  it("emits breadcrumb structured data with the tab as the last item", async () => {
    render(await Page({ params: Promise.resolve({ stockCode: "bhp" }) }));
    expect(mockBreadcrumbs).toHaveBeenCalledWith({
      items: [
        { label: "Stocks", href: "/stocks" },
        { label: "BHP", href: "/shorts/BHP" },
        { label: "Financials", href: "/shorts/BHP/financials" },
      ],
    });
  });

  it("404s a malformed code before any fetch", async () => {
    await expect(Page({ params: Promise.resolve({ stockCode: "not-a-code" }) })).rejects.toThrow("NEXT_NOT_FOUND");
    expect(mockGetStockOrNotFound).not.toHaveBeenCalled();
    expect(mockGetStockFundamentals).not.toHaveBeenCalled();
  });

  it("404s a code the API does not know", async () => {
    mockGetStockOrNotFound.mockRejectedValue(new NotFoundError("ZZZZ"));
    await expect(Page({ params: Promise.resolve({ stockCode: "ZZZZ" }) })).rejects.toThrow("NEXT_NOT_FOUND");
  });

  it("fails the ISR render on a transient read instead of caching a degraded page", async () => {
    mockGetStockOrNotFound.mockResolvedValue(undefined);
    await expect(Page({ params: Promise.resolve({ stockCode: "BHP" }) })).rejects.toThrow(/transiently unavailable/);
  });
});
