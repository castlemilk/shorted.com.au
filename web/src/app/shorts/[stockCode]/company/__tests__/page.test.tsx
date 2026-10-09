/// <reference types="jest" />
import "@testing-library/jest-dom";
import { render, screen } from "@testing-library/react";

const mockGetStockOrNotFound = jest.fn();
const mockGetRelatedStocks = jest.fn();
const mockGetStateExposureIndex = jest.fn();
const mockMetadata = jest.fn().mockResolvedValue({ title: "t" });
const mockBreadcrumbs = jest.fn();
// The two client islands (director trades, connections) arrive through
// next/dynamic and are numbered in render order: island-1 is the directors
// table, island-2 the similar-companies card.
let islands = 0;
jest.mock("next/navigation", () => ({ notFound: () => { throw new Error("NEXT_NOT_FOUND"); } }));
jest.mock("next/dynamic", () => () => () => <div data-testid={`island-${++islands}`} />);
jest.mock("~/app/actions/getStock", () => ({ getStockOrNotFound: (...a: unknown[]) => mockGetStockOrNotFound(...a) }));
jest.mock("~/app/actions/getRelatedStocks", () => ({ getRelatedStocks: (...a: unknown[]) => mockGetRelatedStocks(...a) }));
jest.mock("~/app/actions/getEconomy", () => ({ getStateExposureIndex: (...a: unknown[]) => mockGetStateExposureIndex(...a) }));
jest.mock("~/@/lib/seo/stock-tab-metadata", () => ({ stockTabMetadata: (...a: unknown[]) => mockMetadata(...a) }));
jest.mock("~/@/components/seo/breadcrumbs", () => ({
  BreadcrumbStructuredData: (props: unknown) => {
    mockBreadcrumbs(props);
    return null;
  },
}));
// The registry is the one source of a tab's label (the visible breadcrumb reads
// it too): spy on it and keep the real implementation.
jest.mock("~/@/lib/stocks/stock-tabs", () => {
  const actual = jest.requireActual<typeof import("~/@/lib/stocks/stock-tabs")>("~/@/lib/stocks/stock-tabs");
  return { ...actual, stockTabLabel: jest.fn(actual.stockTabLabel) };
});
jest.mock("~/@/components/company/enriched-company-section", () => ({ EnrichedCompanySection: () => <div data-testid="enriched" /> }));
jest.mock("~/@/components/company/politician-interests-card-loader", () => ({ PoliticianInterestsCard: () => <div data-testid="politicians" /> }));
jest.mock("~/@/components/economy/stock-state-exposure", () => ({
  StockStateExposure: ({ exposures, className }: { exposures: unknown[]; className?: string }) => (
    <div data-testid="exposure" data-count={exposures.length} data-class-name={className ?? ""} />
  ),
}));
jest.mock("~/@/components/company/stock-evidence-panel-client", () => ({
  StockEvidencePanelClient: ({ stockCode, industry, industrySlug, callbackUrl }: { stockCode: string; industry: string | null; industrySlug: string | null; callbackUrl?: string }) => (
    <div data-testid="dossier" data-code={stockCode} data-industry={industry ?? ""} data-slug={industrySlug ?? ""} data-callback-url={callbackUrl ?? ""} />
  ),
}));

import Page, { generateMetadata, generateStaticParams, revalidate, dynamicParams } from "../page";
import { NotFoundError } from "~/app/actions/withRetry";
import { stockTabLabel } from "~/@/lib/stocks/stock-tabs";

const stock = { name: "BHP GROUP LIMITED", industry: "Materials", percentageShorted: 1.58 };
const related = { stocks: [], industry: "Materials", industrySlug: "materials" };

describe("/shorts/[stockCode]/company", () => {
  beforeEach(() => {
    islands = 0;
    mockGetStockOrNotFound.mockReset();
    mockGetStockOrNotFound.mockResolvedValue(stock);
    mockGetRelatedStocks.mockReset();
    mockGetRelatedStocks.mockResolvedValue(related);
    mockGetStateExposureIndex.mockReset();
    mockGetStateExposureIndex.mockResolvedValue({});
    mockMetadata.mockClear();
    mockBreadcrumbs.mockClear();
    (stockTabLabel as jest.Mock).mockClear();
  });

  it("is on-demand ISR", () => {
    expect(revalidate).toBe(3600);
    expect(dynamicParams).toBe(true);
    expect(generateStaticParams()).toEqual([]);
  });

  it("builds its metadata through the shared builder with the tab's title", async () => {
    await generateMetadata({ params: Promise.resolve({ stockCode: "bhp" }) });
    const input = mockMetadata.mock.calls[0]![0] as {
      code: string;
      tab: string;
      title: (c: string) => string;
      description: (c: string) => string;
    };
    expect(input.code).toBe("BHP");
    expect(input.tab).toBe("company");
    expect(input.title("BHP Group")).toBe("BHP Company Profile: Directors, Insiders & Operations | BHP Group");
    expect(input.description("BHP Group")).toContain("BHP Group (ASX:BHP)");
  });

  it("renders research, directors, interests, exposure, connections, then the dossier; exposure degrades to empty", async () => {
    mockGetStateExposureIndex.mockRejectedValue(new Error("down"));
    const { container } = render(await Page({ params: Promise.resolve({ stockCode: "bhp" }) }));
    const order = Array.from(container.querySelectorAll("[data-testid]")).map((n) => n.getAttribute("data-testid"));
    expect(order).toEqual(["enriched", "island-1", "politicians", "exposure", "island-2", "dossier"]);
    expect(container.querySelector("[data-testid=exposure]")).toHaveAttribute("data-count", "0");
    expect(container.querySelector("[data-testid=dossier]")).toHaveAttribute("data-slug", "materials");
  });

  it("hands the exposure block the stock's own entries, found by the upper-cased code", async () => {
    mockGetStateExposureIndex.mockResolvedValue({
      BHP: [{ state: "wa" }],
      RIO: [{ state: "nsw" }, { state: "vic" }],
    });
    render(await Page({ params: Promise.resolve({ stockCode: "bhp" }) }));
    expect(screen.getByTestId("exposure")).toHaveAttribute("data-count", "1");
  });

  it("drops the exposure block's own margins, so the column's gap sets the spacing", async () => {
    // StockStateExposure ships `-mt-3 mb-6` to tuck under the theme chips. In a
    // flex column those margins stack on the gap: 4px above it and 40px below
    // on a phone (gap-4), 12px and 48px from md up (gap-6).
    render(await Page({ params: Promise.resolve({ stockCode: "bhp" }) }));
    expect(screen.getByTestId("exposure")).toHaveAttribute("data-class-name", "m-0");
  });

  it("gives the dossier the code and the stock's industry", async () => {
    render(await Page({ params: Promise.resolve({ stockCode: "bhp" }) }));
    const dossier = screen.getByTestId("dossier");
    expect(dossier).toHaveAttribute("data-code", "BHP");
    expect(dossier).toHaveAttribute("data-industry", "Materials");
    expect(dossier).toHaveAttribute("data-slug", "materials");
  });

  it("sends the dossier's sign-in back to this tab, not the Overview", async () => {
    // The dossier belongs to this tab, so the lock card a signed-out visitor
    // follows must return them here after they sign in.
    render(await Page({ params: Promise.resolve({ stockCode: "bhp" }) }));
    expect(screen.getByTestId("dossier")).toHaveAttribute("data-callback-url", "/shorts/BHP/company");
  });

  it("still renders the dossier, with no industry, when the related-stocks read comes back empty", async () => {
    mockGetRelatedStocks.mockResolvedValue({ stocks: [], industry: null, industrySlug: null });
    render(await Page({ params: Promise.resolve({ stockCode: "bhp" }) }));
    expect(screen.getByTestId("dossier")).toHaveAttribute("data-industry", "");
    expect(screen.getByTestId("dossier")).toHaveAttribute("data-slug", "");
  });

  it("keeps the outline from jumping h1 to h3, and repeats no title the islands print", async () => {
    render(await Page({ params: Promise.resolve({ stockCode: "bhp" }) }));
    // The company card, director trades, declared interests and similar
    // companies each print their own title through CardTitle, an h3, and the
    // first of them follows the h1 directly. The one h2 is sr-only and names the
    // group, so nothing is said twice and no wrapper heading sits over an island.
    const headings = screen.getAllByRole("heading");
    expect(headings.map((h) => [h.tagName, h.textContent])).toEqual([
      ["H1", "BHP Group (BHP) company profile"],
      ["H2", "Profile, insiders and operations"],
    ]);
    expect(headings[1]).toHaveClass("sr-only");
    // It leads the cards rather than following them.
    expect(
      headings[1]!.compareDocumentPosition(screen.getByTestId("enriched")) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });

  it("names the directors section with an aria-label around the directors island", async () => {
    render(await Page({ params: Promise.resolve({ stockCode: "bhp" }) }));
    expect(screen.getByRole("region", { name: "Directors and insiders" })).toContainElement(screen.getByTestId("island-1"));
  });

  it("emits breadcrumb structured data with the tab as the last item, labelled by the tab registry", async () => {
    render(await Page({ params: Promise.resolve({ stockCode: "bhp" }) }));
    expect(stockTabLabel).toHaveBeenCalledWith("company");
    expect(mockBreadcrumbs).toHaveBeenCalledWith({
      items: [
        { label: "Stocks", href: "/stocks" },
        { label: "BHP", href: "/shorts/BHP" },
        { label: "Company", href: "/shorts/BHP/company" },
      ],
    });
  });

  it("404s a malformed code before any fetch", async () => {
    await expect(Page({ params: Promise.resolve({ stockCode: "not-a-code" }) })).rejects.toThrow("NEXT_NOT_FOUND");
    expect(mockGetStockOrNotFound).not.toHaveBeenCalled();
    expect(mockGetRelatedStocks).not.toHaveBeenCalled();
    expect(mockGetStateExposureIndex).not.toHaveBeenCalled();
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
