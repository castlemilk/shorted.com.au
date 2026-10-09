/// <reference types="jest" />
import "@testing-library/jest-dom";
import { render, screen } from "@testing-library/react";
import { type Metadata } from "next";
import { siteConfig } from "~/@/config/site";

const mockGetStock = jest.fn();
const mockGetStockOrNotFound = jest.fn();
const mockGetStockNews = jest.fn();
const mockBreadcrumbs = jest.fn();
jest.mock("next/navigation", () => ({ notFound: () => { throw new Error("NEXT_NOT_FOUND"); } }));
// The event timeline is the page's one island and arrives through next/dynamic.
jest.mock("next/dynamic", () => () => ({ stockCode }: { stockCode: string }) => (
  <div data-testid="event-timeline" data-code={stockCode} />
));
jest.mock("~/app/actions/getStock", () => ({
  getStock: (...a: unknown[]) => mockGetStock(...a),
  getStockOrNotFound: (...a: unknown[]) => mockGetStockOrNotFound(...a),
}));
jest.mock("~/app/actions/getStockNews", () => ({ getStockNews: (...a: unknown[]) => mockGetStockNews(...a) }));
jest.mock("~/@/components/news/news-card", () => ({
  NewsCard: ({ article, variant }: { article: { headline: string }; variant?: string }) => (
    <article data-testid="news-card" data-variant={variant ?? "default"}>
      {article.headline}
    </article>
  ),
}));
jest.mock("~/@/components/seo/llm-meta", () => ({ LLMMeta: () => null }));
// The stock layout renders the dashboard shell and the visible breadcrumb
// trail; these stand-ins make a page that renders either again fail loudly.
jest.mock("~/@/components/layouts/dashboard-layout", () => ({
  DashboardLayout: ({ children }: { children: React.ReactNode }) => <div data-testid="dashboard-layout">{children}</div>,
}));
jest.mock("~/@/components/seo/breadcrumbs", () => ({
  Breadcrumbs: () => <nav aria-label="Breadcrumb" data-testid="visible-breadcrumbs" />,
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

import Page, { generateMetadata, generateStaticParams, revalidate, dynamicParams } from "../page";
import { stockTabLabel } from "~/@/lib/stocks/stock-tabs";

const article = (id: string) => ({
  id,
  headline: `Headline ${id}`,
  url: `https://example.com/${id}`,
  source: "Stockhead",
  publishedAt: "2026-10-01T00:00:00.000Z",
  sentiment: "positive",
});
const stock = { name: "BHP Group", industry: "Materials", percentageShorted: 1.58 };
const params = (stockCode: string) => ({ params: Promise.resolve({ stockCode }) });

type Card = { url: string; width: number; height: number; alt: string };
const socialCards = (md: Metadata) => ({
  openGraph: (md.openGraph as unknown as { images?: Card[] } | undefined)?.images,
  twitter: (md.twitter as unknown as { images?: Card[] } | undefined)?.images,
});

describe("/shorts/[stockCode]/news", () => {
  beforeEach(() => {
    mockGetStock.mockReset();
    mockGetStock.mockResolvedValue(stock);
    mockGetStockOrNotFound.mockReset();
    mockGetStockOrNotFound.mockResolvedValue(stock);
    mockGetStockNews.mockReset();
    mockGetStockNews.mockResolvedValue({ articles: [article("a"), article("b"), article("c")] });
    mockBreadcrumbs.mockClear();
    (stockTabLabel as jest.Mock).mockClear();
  });

  it("is on-demand ISR, on the news page's own ten-minute clock", () => {
    // Without the empty generateStaticParams the segment renders on every
    // request and revalidate is inert.
    expect(revalidate).toBe(600);
    expect(dynamicParams).toBe(true);
    expect(generateStaticParams()).toEqual([]);
  });

  it("renders under the stock layout without a dashboard shell, a breadcrumb trail or a back link of its own", async () => {
    render(await Page(params("bhp")));
    expect(screen.queryByTestId("dashboard-layout")).toBeNull();
    expect(screen.queryByTestId("visible-breadcrumbs")).toBeNull();
    expect(screen.queryByRole("link", { name: /back to/i })).toBeNull();
    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent("BHP Group (BHP) News");
  });

  // stock.name is the raw ASIC PRODUCT string, SHOUTED and with a security-type
  // descriptor. Every other tab, and the profile card above this one, print the
  // cleaned name; this h1 sat directly under them reading "BHP GROUP LIMITED
  // ORDINARY (BHP) News".
  describe("the company name", () => {
    const shouted = { name: "BHP GROUP LIMITED ORDINARY", industry: "Materials", percentageShorted: 1.58 };

    it("is the cleaned name in the h1", async () => {
      mockGetStockOrNotFound.mockResolvedValue(shouted);
      render(await Page(params("bhp")));
      expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent("BHP Group (BHP) News");
      expect(screen.queryByText(/ORDINARY/)).toBeNull();
    });

    it("is the cleaned name in the structured data too", async () => {
      mockGetStockOrNotFound.mockResolvedValue(shouted);
      const { container } = render(await Page(params("bhp")));
      const schemas = Array.from(container.querySelectorAll('script[type="application/ld+json"]')).map(
        (script) => JSON.parse(script.textContent ?? "{}") as { "@type": string; about?: { name?: string } },
      );
      const itemList = schemas.find((s) => s["@type"] === "ItemList");
      const newsArticle = schemas.find((s) => s["@type"] === "NewsArticle");
      expect(itemList?.about?.name).toBe("BHP Group");
      expect(newsArticle?.about?.name).toBe("BHP Group");
      expect(JSON.stringify(schemas)).not.toContain("ORDINARY");
    });

    it("falls back to the code when the stock cannot be read or has no name", async () => {
      for (const unread of [() => mockGetStockOrNotFound.mockRejectedValue(new Error("down")), () => mockGetStockOrNotFound.mockResolvedValue({ ...shouted, name: "" })]) {
        unread();
        const { unmount } = render(await Page(params("bhp")));
        expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent(/^BHP \(BHP\) News$/);
        unmount();
      }
    });
  });

  it("renders the hero, then the rest of the articles, then the event timeline for the upper-cased code", async () => {
    render(await Page(params("bhp")));
    const cards = screen.getAllByTestId("news-card");
    expect(cards.map((c) => c.getAttribute("data-variant"))).toEqual(["hero", "default", "default"]);
    const timeline = screen.getByTestId("event-timeline");
    expect(timeline).toHaveAttribute("data-code", "BHP");
    expect(cards[cards.length - 1]!.compareDocumentPosition(timeline) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("still shows the event timeline when there are no articles", async () => {
    mockGetStockNews.mockResolvedValue({ articles: [] });
    render(await Page(params("bhp")));
    expect(screen.getByText(/No news found for BHP yet/)).toBeInTheDocument();
    expect(screen.queryAllByTestId("news-card")).toHaveLength(0);
    expect(screen.getByTestId("event-timeline")).toBeInTheDocument();
  });

  // The page is ISR (600 s). getStockNews goes through withRetryAndNotFound, so
  // `undefined` is a FAILED read (its retries are spent). It is not an empty
  // feed: the Go handler answers a stock with no news with an empty Articles
  // list and a store error with CodeInternal, and never with NotFound
  // (services/shorts/internal/services/shorts/news.go). Rendering "No news
  // found" for a failed read would bake that sentence into the cache for ten
  // minutes and replace the last good page; throwing keeps ISR serving it.
  describe("a failed news read", () => {
    it("fails the render instead of caching 'No news found'", async () => {
      mockGetStockNews.mockResolvedValue(undefined);
      await expect(Page(params("bhp"))).rejects.toThrow(/news unavailable for BHP/);
    });

    it("is told apart from an empty feed, which keeps the copy", async () => {
      mockGetStockNews.mockResolvedValue({ articles: [] });
      render(await Page(params("bhp")));
      expect(screen.getByText(/No news found for BHP yet/)).toBeInTheDocument();
    });

    it("reads a response with no articles key as an empty feed too (proto3 JSON omits an empty list)", async () => {
      mockGetStockNews.mockResolvedValue({});
      render(await Page(params("bhp")));
      expect(screen.getByText(/No news found for BHP yet/)).toBeInTheDocument();
    });
  });

  it("adds no heading over the timeline, which prints its own title; the section is named with an aria-label", async () => {
    render(await Page(params("bhp")));
    // The h1 is the only heading the page writes: the timeline's own
    // "Event timeline" title (a CardTitle h3) is the section's visible heading.
    expect(screen.getAllByRole("heading")).toHaveLength(1);
    expect(screen.queryByRole("heading", { name: /^events$/i })).toBeNull();
    expect(screen.getByRole("region", { name: "Events" })).toContainElement(screen.getByTestId("event-timeline"));
  });

  it("keeps the ItemList and NewsArticle schema", async () => {
    const { container } = render(await Page(params("bhp")));
    const scripts = Array.from(container.querySelectorAll('script[type="application/ld+json"]'));
    // One ItemList, then one NewsArticle per article (the breadcrumb schema is
    // its own component).
    expect(scripts).toHaveLength(1 + 3);
    expect(JSON.parse(scripts[0]!.textContent ?? "{}")["@type"]).toBe("ItemList");
    expect(JSON.parse(scripts[1]!.textContent ?? "{}")["@type"]).toBe("NewsArticle");
  });

  it("emits breadcrumb structured data under /stocks with the tab as the last item, labelled by the tab registry", async () => {
    render(await Page(params("bhp")));
    expect(stockTabLabel).toHaveBeenCalledWith("news");
    expect(mockBreadcrumbs).toHaveBeenCalledWith({
      items: [
        { label: "Stocks", href: "/stocks" },
        { label: "BHP", href: "/shorts/BHP" },
        { label: "News", href: "/shorts/BHP/news" },
      ],
    });
  });

  it("404s a malformed code before any fetch", async () => {
    await expect(Page(params("nope!"))).rejects.toThrow("NEXT_NOT_FOUND");
    expect(mockGetStockNews).not.toHaveBeenCalled();
    expect(mockGetStockOrNotFound).not.toHaveBeenCalled();
  });

  describe("generateMetadata", () => {
    it("names the stock's social card on both Open Graph and Twitter, versioned by the short percentage", async () => {
      const cards = socialCards(await generateMetadata(params("bhp")));
      const expected = [
        expect.objectContaining({
          url: `${siteConfig.url}/shorts/BHP/opengraph-image?p=1.58`,
          width: 1200,
          height: 630,
        }),
      ];
      expect(cards.openGraph).toEqual(expected);
      expect(cards.twitter).toEqual(expected);
    });

    it("keeps its own title, description and canonical", async () => {
      const md = await generateMetadata(params("bhp"));
      expect(md.title).toBe("BHP News & Sentiment | Latest ASX Articles");
      expect(md.description).toContain("Latest news and sentiment analysis for BHP");
      expect(md.alternates?.canonical).toBe(`${siteConfig.url}/shorts/BHP/news`);
      // No key at all, not `robots: undefined`: Next 14.2 resolves an own key
      // holding undefined to null and drops the root layout's robots.
      expect(Object.keys(md)).not.toContain("robots");
    });

    it("noindexes a thin stock without losing its card", async () => {
      // Thin = no industry and a short position under the indexing floor.
      mockGetStock.mockResolvedValue({ name: "TINY LTD", industry: "", percentageShorted: 0.01 });
      const md = await generateMetadata(params("tny"));
      expect(md.robots).toMatchObject({ index: false, follow: true });
      expect(socialCards(md).openGraph?.[0]?.url).toBe(`${siteConfig.url}/shorts/TNY/opengraph-image?p=0.01`);
    });

    it("fails open on a transient read: default robots and the default card version", async () => {
      mockGetStock.mockRejectedValue(new Error("down"));
      const md = await generateMetadata(params("bhp"));
      expect(Object.keys(md)).not.toContain("robots");
      const cards = socialCards(md);
      expect(cards.openGraph?.[0]?.url).toBe(`${siteConfig.url}/shorts/BHP/opengraph-image?p=default`);
      expect(cards.twitter?.[0]?.url).toBe(`${siteConfig.url}/shorts/BHP/opengraph-image?p=default`);
    });
  });
});
