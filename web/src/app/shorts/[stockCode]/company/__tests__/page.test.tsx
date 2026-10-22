/// <reference types="jest" />
import "@testing-library/jest-dom";
import { render, screen, within } from "@testing-library/react";
import { renderToStaticMarkup } from "react-dom/server";

const mockGetStockOrNotFound = jest.fn();
const mockGetRelatedStocks = jest.fn();
const mockGetStateExposureIndex = jest.fn();
const mockGetDirectorTrades = jest.fn();
const mockMetadata = jest.fn().mockResolvedValue({ title: "t" });
const mockBreadcrumbs = jest.fn();
// The two client islands (director trades, connections) arrive through
// next/dynamic and are numbered in source order: island-1 is the directors
// table, island-2 the similar-companies card. The page renders the directors
// island only as the fallback for a server read that failed, so the numbers
// are the same whether or not it is on the page. What each was given to load
// it with (its `ssr` and `loading`) is kept, in the same order, for the tests
// that say how the page loads them.
const dynamicOptions: Array<{ ssr?: boolean; loading?: () => React.ReactNode } | undefined> = [];
jest.mock("next/navigation", () => ({ notFound: () => { throw new Error("NEXT_NOT_FOUND"); } }));
jest.mock(
  "next/dynamic",
  () => (_loader: unknown, options?: { ssr?: boolean; loading?: () => React.ReactNode }) => {
    const island = dynamicOptions.push(options);
    return () => <div data-testid={`island-${island}`} />;
  },
);
jest.mock("~/app/actions/getStock", () => ({ getStockOrNotFound: (...a: unknown[]) => mockGetStockOrNotFound(...a) }));
jest.mock("~/app/actions/getRelatedStocks", () => ({ getRelatedStocks: (...a: unknown[]) => mockGetRelatedStocks(...a) }));
jest.mock("~/app/actions/getEconomy", () => ({ getStateExposureIndex: (...a: unknown[]) => mockGetStateExposureIndex(...a) }));
jest.mock("~/app/actions/getDirectorTrades", () => ({ getDirectorTrades: (...a: unknown[]) => mockGetDirectorTrades(...a) }));
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
jest.mock("~/@/components/company/enriched-company-section", () => ({
  EnrichedCompanySection: ({ stockCode, companyName }: { stockCode: string; companyName?: string }) => (
    <div data-testid="enriched" data-code={stockCode} data-company-name={companyName ?? ""} />
  ),
}));
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
import { DirectorTradesSkeleton } from "~/@/components/company/director-trades-skeleton";
import { NotFoundError } from "~/app/actions/withRetry";
import { stockTabLabel } from "~/@/lib/stocks/stock-tabs";

const stock = { name: "BHP GROUP LIMITED", industry: "Materials", percentageShorted: 1.58 };
const related = { stocks: [], industry: "Materials", industrySlug: "materials" };
const trade = {
  id: "t1",
  tradeDate: "2026-09-30",
  directorName: "Jane Citizen",
  tradeType: "buy",
  sharesTraded: BigInt(12000),
  pricePerShare: 43.21,
  totalValue: 518520,
  announcementUrl: "https://announcements.example/t1.pdf",
};
const directorTrades = { trades: [trade], totalCount: 1 };

// The page's parts in document order: each stand-in by its test id, and the
// directors section by its aria-label.
const parts = (root: ParentNode) =>
  Array.from(root.querySelectorAll("[data-testid], section[aria-label]")).map(
    (node) => node.getAttribute("data-testid") ?? `section:${node.getAttribute("aria-label")}`,
  );

// Lets every promise that is ready run, and the page's first awaits with them.
const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

describe("/shorts/[stockCode]/company", () => {
  beforeEach(() => {
    mockGetStockOrNotFound.mockReset();
    mockGetStockOrNotFound.mockResolvedValue(stock);
    mockGetRelatedStocks.mockReset();
    mockGetRelatedStocks.mockResolvedValue(related);
    mockGetStateExposureIndex.mockReset();
    mockGetStateExposureIndex.mockResolvedValue({});
    mockGetDirectorTrades.mockReset();
    mockGetDirectorTrades.mockResolvedValue(directorTrades);
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
    expect(input.title("BHP Group")).toBe("BHP Company Profile: Directors & Insiders | BHP Group");
    expect(input.description("BHP Group")).toContain("BHP Group (ASX:BHP)");
  });

  it("renders research, directors, interests, exposure, connections, then the dossier; exposure degrades to empty", async () => {
    mockGetStateExposureIndex.mockRejectedValue(new Error("down"));
    const { container } = render(await Page({ params: Promise.resolve({ stockCode: "bhp" }) }));
    // The directors section holds the card the page drew from its own read, so
    // it has no island in it: island-1 is the fallback, island-2 the connections.
    expect(parts(container)).toEqual([
      "enriched",
      "section:Directors and insiders",
      "politicians",
      "exposure",
      "island-2",
      "dossier",
    ]);
    expect(container.querySelector("[data-testid=exposure]")).toHaveAttribute("data-count", "0");
    expect(container.querySelector("[data-testid=dossier]")).toHaveAttribute("data-slug", "materials");
  });

  // The card is in the page's HTML at the size it keeps. Drawn in the browser
  // behind a skeleton, a stock with no trades opened a card of 322px and then
  // collapsed it to about 92px, moving every card beneath it (a first-load
  // layout shift of 0.164 on desktop and 0.215 on a phone).
  describe("director trades", () => {
    it("draws the trades on the server: the rows are in the HTML, with no island and no skeleton", async () => {
      const html = renderToStaticMarkup(await Page({ params: Promise.resolve({ stockCode: "bhp" }) }));
      expect(html).toContain("1 trade recorded");
      expect(html).toContain("Jane Citizen");
      expect(html).toContain("2026-09-30");
      expect(html).toContain("12,000");
      expect(html).toContain("$43.210");
      expect(html).toContain("$518,520");
      expect(html).toContain('href="https://announcements.example/t1.pdf"');
      // The connections island is in this HTML (its stand-in), so the absence
      // of the directors island's is a finding and not an artefact of the render.
      expect(html).toContain('data-testid="island-2"');
      expect(html).not.toContain('data-testid="island-1"');
      expect(html).not.toContain("animate-pulse");
    });

    it("draws the empty card on the server for a stock with no director trades, and no island", async () => {
      mockGetDirectorTrades.mockResolvedValue({ trades: [], totalCount: 0 });
      const html = renderToStaticMarkup(await Page({ params: Promise.resolve({ stockCode: "bhp" }) }));
      expect(html).toContain("Director trades");
      expect(html).toContain("No director trades found");
      expect(html).not.toContain("<table");
      expect(html).toContain('data-testid="island-2"');
      expect(html).not.toContain('data-testid="island-1"');
      expect(html).not.toContain("animate-pulse");
    });

    it("puts the card inside the labelled section, where the island would have been", async () => {
      render(await Page({ params: Promise.resolve({ stockCode: "bhp" }) }));
      const section = screen.getByRole("region", { name: "Directors and insiders" });
      expect(within(section).getByRole("heading", { level: 3, name: "Director trades" })).toBeInTheDocument();
      expect(within(section).getByText("Jane Citizen")).toBeInTheDocument();
      expect(screen.queryByTestId("island-1")).toBeNull();
      expect(screen.getByTestId("island-2")).toBeInTheDocument();
    });

    it("falls back to the client island, in the same section, when the read has nothing", async () => {
      mockGetDirectorTrades.mockResolvedValue(undefined);
      const { container } = render(await Page({ params: Promise.resolve({ stockCode: "bhp" }) }));
      expect(parts(container)).toEqual([
        "enriched",
        "section:Directors and insiders",
        "island-1",
        "politicians",
        "exposure",
        "island-2",
        "dossier",
      ]);
      expect(
        within(screen.getByRole("region", { name: "Directors and insiders" })).getByTestId("island-1"),
      ).toBeInTheDocument();
      // A read that failed is not an answer: the page does not say there are none.
      expect(screen.queryByText("No director trades found")).toBeNull();
    });

    it("takes a rejected read as a failed one: the island, and the rest of the page renders", async () => {
      mockGetDirectorTrades.mockRejectedValue(new Error("down"));
      render(await Page({ params: Promise.resolve({ stockCode: "bhp" }) }));
      expect(screen.getByTestId("island-1")).toBeInTheDocument();
      expect(screen.getByTestId("enriched")).toBeInTheDocument();
      expect(screen.getByTestId("dossier")).toBeInTheDocument();
    });

    it("starts the read with the page's others, for the first 20 trades of the upper-cased code", async () => {
      let releaseStock!: (value: unknown) => void;
      mockGetStockOrNotFound.mockReturnValue(new Promise((resolve) => (releaseStock = resolve)));
      const rendering = Page({ params: Promise.resolve({ stockCode: "bhp" }) });
      await flush();
      // The stock read is still pending and the directors read is already out,
      // so the one does not wait for the other.
      expect(mockGetStockOrNotFound).toHaveBeenCalled();
      expect(mockGetDirectorTrades).toHaveBeenCalledTimes(1);
      expect(mockGetDirectorTrades).toHaveBeenCalledWith("BHP", 20);
      releaseStock(stock);
      await rendering;
    });

    it("waits for the read where the section renders, so the card is not added after the page", async () => {
      let release!: (value: unknown) => void;
      mockGetDirectorTrades.mockReturnValue(new Promise((resolve) => (release = resolve)));
      let settled = false;
      const rendering = Page({ params: Promise.resolve({ stockCode: "bhp" }) }).then((tree) => {
        settled = true;
        return tree;
      });
      await flush();
      expect(settled).toBe(false);
      release(directorTrades);
      render(await rendering);
      expect(screen.getByText("Jane Citizen")).toBeInTheDocument();
    });
  });

  // The card's subtitle read "research profile of Bhp Group" under a header that
  // reads "BHP Group": the page's cleaned name goes in, never the raw record's.
  it("gives the Company card the page's cleaned name, the one its own heading uses", async () => {
    render(await Page({ params: Promise.resolve({ stockCode: "bhp" }) }));
    const card = screen.getByTestId("enriched");
    expect(card).toHaveAttribute("data-code", "BHP");
    expect(card).toHaveAttribute("data-company-name", "BHP Group");
    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent("BHP Group (BHP) company profile");
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

  it("keeps the outline from jumping h1 to h3, and repeats no title the cards print", async () => {
    render(await Page({ params: Promise.resolve({ stockCode: "bhp" }) }));
    // The company card, director trades, declared interests and similar
    // companies each print their own title through CardTitle, an h3, and the
    // first of them follows the h1 directly. The one h2 is sr-only and names the
    // group, so nothing is said twice and no wrapper heading sits over a card.
    // The directors card is drawn by the page, so its h3 is the one that shows
    // here; the others are islands, which the stand-ins here do not print.
    const headings = screen.getAllByRole("heading");
    expect(headings.map((h) => [h.tagName, h.textContent])).toEqual([
      ["H1", "BHP Group (BHP) company profile"],
      ["H2", "Profile, insiders and operations"],
      ["H3", "Director trades"],
    ]);
    expect(headings[1]).toHaveClass("sr-only");
    // It leads the cards rather than following them.
    expect(
      headings[1]!.compareDocumentPosition(screen.getByTestId("enriched")) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });

  // Without a placeholder the directors card popped in after the page and shifted
  // what is below it (a first-load layout shift of 0.023 on desktop). Both
  // islands are client-only; the directors table, which the page renders only as
  // the fallback for a failed server read, holds its place with the card it draws
  // while it loads.
  it("loads both islands client-only, and holds the directors table's place with the skeleton card", () => {
    expect(dynamicOptions).toHaveLength(2);
    const [directors, connections] = dynamicOptions;
    expect(directors?.ssr).toBe(false);
    expect(connections?.ssr).toBe(false);
    expect(typeof directors?.loading).toBe("function");

    const placeholder = render(<>{directors!.loading!()}</>);
    const skeleton = render(<DirectorTradesSkeleton />);
    expect(placeholder.container.innerHTML).not.toBe("");
    expect(placeholder.container.innerHTML).toBe(skeleton.container.innerHTML);
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
    expect(mockGetDirectorTrades).not.toHaveBeenCalled();
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
