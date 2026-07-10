import { create, type MessageInitShape } from "@bufbuild/protobuf";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactElement } from "react";
import { createClient } from "@connectrpc/connect";
import {
  GetRelatedNewsResponseSchema,
  GetStockNewsResponseSchema,
  NewsArticleSchema,
} from "~/gen/shorts/v1alpha1/shorts_pb";
import { StockNewsTab } from "../stock-news-tab";

jest.mock("next/link", () => ({
  __esModule: true,
  default: ({ children, href, ...props }: any) => (
    <a href={href} {...props}>
      {children}
    </a>
  ),
}));

jest.mock("@connectrpc/connect-web", () => ({
  createConnectTransport: jest.fn(() => ({})),
}));

jest.mock("@connectrpc/connect", () => ({
  createClient: jest.fn(),
}));

const mockGetStockNews = jest.fn();
const mockGetRelatedNews = jest.fn();

(createClient as jest.Mock).mockReturnValue({
  getStockNews: mockGetStockNews,
  getRelatedNews: mockGetRelatedNews,
});

function renderWithQueryClient(ui: ReactElement) {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: {
        retry: false,
      },
    },
  });

  return render(
    <QueryClientProvider client={queryClient}>{ui}</QueryClientProvider>,
  );
}

type ArticleInit = MessageInitShape<typeof NewsArticleSchema>;

function article(overrides: ArticleInit = {}): ArticleInit {
  return {
    id: "a1",
    stockCode: "BHP",
    source: "afr",
    headline: "BHP shorts climb as iron ore slides",
    url: "https://example.com/a1",
    sentiment: "negative",
    summary: "Short interest in BHP rose for a third straight week.",
    imageUrl: "https://img.example.com/a1.jpg",
    publishedAt: {
      seconds: BigInt(Math.floor(Date.now() / 1000) - 5 * 60),
      nanos: 0,
    },
    syndicationCount: 3,
    syndicatedSources: ["smh", "theage"],
    ...overrides,
  };
}

function feedResponse(articles: ArticleInit[], totalCount?: number) {
  return create(GetStockNewsResponseSchema, {
    articles,
    totalCount: totalCount ?? articles.length,
  });
}

function relatedResponse(articles: ArticleInit[]) {
  return create(GetRelatedNewsResponseSchema, { articles });
}

function thumbnailsBySrc(container: HTMLElement, src: string) {
  return Array.from(container.querySelectorAll("img")).filter(
    (img) => img.getAttribute("src") === src,
  );
}

describe("StockNewsTab", () => {
  beforeEach(() => {
    mockGetStockNews.mockReset();
    mockGetRelatedNews.mockReset();
    mockGetRelatedNews.mockResolvedValue(relatedResponse([]));
  });

  it("renders feed rows with headline, summary, thumbnail, syndication and time", async () => {
    mockGetStockNews.mockResolvedValue(feedResponse([article()]));

    const { container } = renderWithQueryClient(
      <StockNewsTab stockCode="BHP" />,
    );

    expect(
      await screen.findByText("BHP shorts climb as iron ore slides"),
    ).toBeInTheDocument();
    expect(
      screen.getByText("Short interest in BHP rose for a third straight week."),
    ).toBeInTheDocument();

    const thumbs = thumbnailsBySrc(container, "https://img.example.com/a1.jpg");
    expect(thumbs).toHaveLength(1);
    expect(thumbs[0]).toHaveAttribute("loading", "lazy");
    expect(thumbs[0]).toHaveAttribute("decoding", "async");

    // syndication_count = 3 → "+2 outlets" (cluster size includes self)
    expect(screen.getByText("+2 outlets")).toBeInTheDocument();
    expect(screen.getByText("5m ago")).toBeInTheDocument();
    // negative sentiment IS rendered (capitalized display label)
    expect(screen.getByText("Negative")).toBeInTheDocument();
  });

  it("does not nest anchors inside the row link (source badge is non-interactive)", async () => {
    mockGetStockNews.mockResolvedValue(feedResponse([article()]));
    mockGetRelatedNews.mockResolvedValue(
      relatedResponse([
        article({
          id: "rel-1",
          url: "https://example.com/rel-1",
          headline: "Iron ore peers also heavily shorted",
        }),
      ]),
    );

    const { container } = renderWithQueryClient(
      <StockNewsTab stockCode="BHP" />,
    );

    await screen.findByText("BHP shorts climb as iron ore slides");
    await screen.findByText("Iron ore peers also heavily shorted");
    // Feed + related rows are whole-row <a> elements; the source badge must
    // render as a plain span inside them (a-in-a is invalid HTML / WCAG 4.1.2).
    expect(container.querySelector("a a")).toBeNull();
  });

  it("shows total_count when it exceeds the fetched page", async () => {
    mockGetStockNews.mockResolvedValue(
      feedResponse(
        [article(), article({ id: "a2", url: "https://example.com/a2" })],
        42,
      ),
    );

    renderWithQueryClient(<StockNewsTab stockCode="BHP" />);

    expect(await screen.findByText("42 articles")).toBeInTheDocument();
  });

  it("shows the page size when total_count equals the fetched page", async () => {
    mockGetStockNews.mockResolvedValue(feedResponse([article()], 1));

    renderWithQueryClient(<StockNewsTab stockCode="BHP" />);

    expect(await screen.findByText("1 recent article")).toBeInTheDocument();
  });

  it("hides the sentiment badge for neutral/empty sentiment", async () => {
    mockGetStockNews.mockResolvedValue(
      feedResponse([
        article({
          id: "n1",
          url: "https://example.com/n1",
          sentiment: "neutral",
        }),
        article({ id: "n2", url: "https://example.com/n2", sentiment: "" }),
      ]),
    );

    renderWithQueryClient(<StockNewsTab stockCode="BHP" />);

    await screen.findAllByText("BHP shorts climb as iron ore slides");
    expect(screen.queryByText("Neutral")).not.toBeInTheDocument();
  });

  it("renders a fallback tile (no img) when image_url is empty", async () => {
    mockGetStockNews.mockResolvedValue(feedResponse([article({ imageUrl: "" })]));

    const { container } = renderWithQueryClient(
      <StockNewsTab stockCode="BHP" />,
    );

    await screen.findByText("BHP shorts climb as iron ore slides");
    expect(
      thumbnailsBySrc(container, "https://img.example.com/a1.jpg"),
    ).toHaveLength(0);
  });

  it("shows an error state with a working Retry button", async () => {
    mockGetStockNews
      .mockRejectedValueOnce(new Error("boom"))
      .mockResolvedValueOnce(feedResponse([article()]));

    renderWithQueryClient(<StockNewsTab stockCode="BHP" />);

    expect(
      await screen.findByText(/Couldn't load news for BHP/),
    ).toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: /retry/i }));

    expect(
      await screen.findByText("BHP shorts climb as iron ore slides"),
    ).toBeInTheDocument();
    expect(mockGetStockNews).toHaveBeenCalledTimes(2);
  });

  it("shows an empty state with the View all link", async () => {
    mockGetStockNews.mockResolvedValue(feedResponse([]));

    renderWithQueryClient(<StockNewsTab stockCode="BHP" />);

    expect(
      await screen.findByText("No recent news for BHP"),
    ).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /view all/i })).toHaveAttribute(
      "href",
      "/shorts/BHP/news",
    );
  });

  it("dedupes related coverage against the feed by id and url", async () => {
    mockGetStockNews.mockResolvedValue(
      feedResponse([article({ id: "feed-1", url: "https://example.com/feed-1" })]),
    );
    mockGetRelatedNews.mockResolvedValue(
      relatedResponse([
        // duplicate id → dropped
        article({ id: "feed-1", url: "https://example.com/elsewhere" }),
        // duplicate url → dropped
        article({ id: "rel-1", url: "https://example.com/feed-1" }),
        // unique → kept
        article({
          id: "rel-2",
          url: "https://example.com/rel-2",
          headline: "Iron ore peers also heavily shorted",
          stockCode: "FMG",
        }),
      ]),
    );

    renderWithQueryClient(<StockNewsTab stockCode="BHP" />);

    expect(await screen.findByText("Related coverage")).toBeInTheDocument();
    expect(
      screen.getByText("Iron ore peers also heavily shorted"),
    ).toBeInTheDocument();
    expect(screen.getByText("FMG")).toBeInTheDocument();
    // the duplicate related rows are not rendered — only the feed copy remains
    expect(
      screen.getAllByText("BHP shorts climb as iron ore slides"),
    ).toHaveLength(1);
  });

  it("omits the related section entirely when everything is a duplicate", async () => {
    mockGetStockNews.mockResolvedValue(
      feedResponse([article({ id: "feed-1", url: "https://example.com/feed-1" })]),
    );
    mockGetRelatedNews.mockResolvedValue(
      relatedResponse([
        article({ id: "feed-1", url: "https://example.com/feed-1" }),
      ]),
    );

    renderWithQueryClient(<StockNewsTab stockCode="BHP" />);

    await screen.findByText("BHP shorts climb as iron ore slides");
    expect(screen.queryByText("Related coverage")).not.toBeInTheDocument();
  });

  it("still renders the feed when the related query fails", async () => {
    mockGetStockNews.mockResolvedValue(feedResponse([article()]));
    mockGetRelatedNews.mockRejectedValue(new Error("related boom"));

    renderWithQueryClient(<StockNewsTab stockCode="BHP" />);

    expect(
      await screen.findByText("BHP shorts climb as iron ore slides"),
    ).toBeInTheDocument();
    expect(screen.queryByText("Related coverage")).not.toBeInTheDocument();
  });

  it("skips the related query when relatedLimit is 0", async () => {
    mockGetStockNews.mockResolvedValue(feedResponse([article()]));

    renderWithQueryClient(<StockNewsTab stockCode="BHP" relatedLimit={0} />);

    await screen.findByText("BHP shorts climb as iron ore slides");
    expect(mockGetRelatedNews).not.toHaveBeenCalled();
  });
});
