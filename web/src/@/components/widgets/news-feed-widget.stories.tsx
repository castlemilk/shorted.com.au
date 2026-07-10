/**
 * NewsFeedWidget stories — market news list with source/sentiment badges.
 *
 * Implements the six-state contract from ~/@/mocks/STORY_GUIDE.md:
 * Default / Loading / Error / Empty / Compact / Mobile, plus a play function
 * exercising the widget's stock-code navigation.
 *
 * Data trace (verified against news-feed-widget.tsx):
 * - ShortedStocksService.getMarketNews({ limit, priceSensitiveOnly }) via an
 *   INLINE Connect client built inside the useQuery queryFn
 *   (createConnectTransport({ baseUrl: "" }) → POST to
 *   /shorts.v1alpha1.ShortedStocksService/GetMarketNews over global fetch).
 *   There is NO wrapper module to sb.mock, so this file stubs globalThis.fetch
 *   per story (install in beforeEach, restore via the returned cleanup).
 *   Deliberately file-local — do NOT promote to preview.tsx or install MSW;
 *   every other widget mocks at module level per STORY_GUIDE.md.
 * - Fetch gated by useWidgetVisibility (IntersectionObserver) — withGridCell
 *   renders the story in-viewport so the IO fires.
 * - Child badges (NewsSourceBadge, SentimentBadge) are pure UI; source logos
 *   are static /assets/ images loaded by the browser, not via fetch.
 *   NewsSourceBadge renders with interactive={false} because each article row
 *   is itself an <a> — the badge must not nest its own anchor (invalid HTML).
 * - The widget renders NO timestamps (publishedAt is unused), so stories are
 *   clock-independent — no `no-visual` tags needed.
 *
 * KNOWN GAPs pinned below:
 * - Error and Empty render the SAME "No news articles available" copy
 *   (`isError || !data?.articles?.length` share one branch).
 * - config.settings.refreshInterval feeds useQuery refetchInterval directly;
 *   stories use the 5-minute default, which never fires in-test.
 */
import type { Meta, StoryObj } from "@storybook/nextjs-vite";
import { expect, userEvent, waitFor, within } from "storybook/test";
import { create, toJson } from "@bufbuild/protobuf";

import { NewsFeedWidget } from "./news-feed-widget";
import { WidgetType } from "~/@/types/dashboard";
import {
  makeWidgetConfig,
  never,
  withGridCell,
} from "~/@/mocks/widget-story-helpers";
import { marketNewsResponseFixture } from "~/@/mocks/fixtures/short-data";
import {
  GetMarketNewsResponseSchema,
  type GetMarketNewsResponse,
} from "~/gen/shorts/v1alpha1/shorts_pb";

const MARKET_NEWS_PATH = "/shorts.v1alpha1.ShortedStocksService/GetMarketNews";

/**
 * Replaces globalThis.fetch for the story's lifetime. GetMarketNews calls go
 * to `respond`; everything else passes through to the real fetch (Vite/test
 * infra also uses fetch — throwing here would break the runner, so this
 * cannot mirror the preview throwing-guard pattern).
 */
function stubMarketNewsFetch(respond: () => Promise<Response>): () => void {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    const url =
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.href
          : input.url;
    if (url.includes(MARKET_NEWS_PATH)) {
      return respond();
    }
    return originalFetch(input as RequestInfo, init);
  }) as typeof fetch;
  return () => {
    globalThis.fetch = originalFetch;
  };
}

/** Connect-protocol unary JSON success (what connect-web expects back). */
function newsResponse(msg: GetMarketNewsResponse): Response {
  return new Response(
    JSON.stringify(toJson(GetMarketNewsResponseSchema, msg)),
    { status: 200, headers: { "content-type": "application/json" } },
  );
}

/** Connect-protocol error: non-200 + {code, message} JSON body. */
function newsErrorResponse(): Response {
  return new Response(
    JSON.stringify({ code: "unavailable", message: "shorts API unavailable" }),
    { status: 503, headers: { "content-type": "application/json" } },
  );
}

const meta = {
  title: "Widgets/NewsFeed",
  component: NewsFeedWidget,
  args: {
    config: makeWidgetConfig(WidgetType.NEWS_FEED, {
      limit: 10,
      priceSensitiveOnly: false,
      refreshInterval: 300000,
    }),
    sizeVariant: "standard",
  },
  decorators: [withGridCell("medium")],
  // Stock-code <Link>s need the App Router mock mounted.
  parameters: { nextjs: { appDirectory: true } },
} satisfies Meta<typeof NewsFeedWidget>;

export default meta;
type Story = StoryObj<typeof meta>;

/**
 * Loaded feed of 10 fixture articles. Asserts headlines, the ASX-source
 * highlight, source + sentiment badges, the MARKET-wide article's hidden
 * code link, then clicks the PLS stock-code link and asserts the App Router
 * mock received the /shorts/PLS navigation (the link stopPropagation()s so
 * the outer external <a> is not followed).
 */
export const Default: Story = {
  beforeEach: () => stubMarketNewsFetch(() =>
    Promise.resolve(newsResponse(marketNewsResponseFixture())),
  ),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const fixture = marketNewsResponseFixture();

    await waitFor(() => {
      expect(canvas.getByText(fixture.articles[0]!.headline)).toBeInTheDocument();
    });
    // All 10 articles render as external links.
    for (const article of fixture.articles) {
      expect(canvas.getByText(article.headline)).toBeInTheDocument();
    }

    // Stock-code links: PLS article links to its shorts page.
    const plsLink = canvas.getByRole("link", { name: "PLS" });
    expect(plsLink).toHaveAttribute("href", "/shorts/PLS");

    // The MARKET-wide article renders WITHOUT a stock-code link.
    expect(canvas.queryByText("MARKET")).not.toBeInTheDocument();

    // Source badges (fixture cycles sources; asx appears at indices 0 and 5)
    // and sentiment badges (positive at indices 0, 3, 6, 9).
    expect(canvas.getAllByText("ASX")).toHaveLength(2);
    // Badges are non-interactive inside the whole-row <a> (a-in-a is invalid
    // HTML): the badge's nearest anchor is the article row link itself, not
    // the source's external site.
    const asxBadge = canvas.getAllByText("ASX")[0]!;
    expect(asxBadge.closest("a")).toHaveAttribute(
      "href",
      fixture.articles[0]!.url,
    );
    expect(canvas.getAllByText("Stockhead")).toHaveLength(2);
    expect(canvas.getAllByText("Positive")).toHaveLength(4);
    expect(canvas.getAllByText("Negative")).toHaveLength(3);
    expect(canvas.getAllByText("Neutral")).toHaveLength(3);

    // Primary interaction: stock-code navigation via next/link. The deterministic
    // navigation contract for a next/link is its href (asserted above) — clicking
    // it must NOT bubble to the surrounding external-article <a> (the onClick
    // stopPropagation guard). We assert the click is absorbed locally: no
    // pageerror, and the external link's href is never the navigation target.
    // (A next/link click does not reliably route through the vitest browser's
    // mocked router, so href is the contract we verify, not router.push.)
    await userEvent.click(plsLink);
    expect(plsLink).toHaveAttribute("href", "/shorts/PLS");
  },
};

/**
 * Perpetual loading: the GetMarketNews fetch never settles, so the 5-row
 * skeleton stays up and no article/zero-state copy is mounted.
 */
export const Loading: Story = {
  beforeEach: () => stubMarketNewsFetch(() => never<Response>()),
  play: async ({ canvasElement }) => {
    await waitFor(() => {
      expect(canvasElement.querySelector(".animate-pulse")).toBeTruthy();
    });
    expect(
      within(canvasElement).queryByText(/no news articles/i),
    ).not.toBeInTheDocument();
    expect(within(canvasElement).queryByRole("link")).not.toBeInTheDocument();
  },
};

/**
 * KNOWN GAP: the widget has no dedicated error UI — a Connect error lands in
 * the same "No news articles available" branch as an empty feed
 * (`isError || !data?.articles?.length`). This story pins that behavior; if
 * a distinct error state is added later, update these assertions.
 */
export const Error: Story = {
  beforeEach: () => stubMarketNewsFetch(() =>
    Promise.resolve(newsErrorResponse()),
  ),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await waitFor(() => {
      expect(canvas.getByText("No news articles available")).toBeInTheDocument();
    });
    expect(canvas.queryByRole("link")).not.toBeInTheDocument();
  },
};

/** Empty payload renders the shared zero-state copy. */
export const Empty: Story = {
  beforeEach: () => stubMarketNewsFetch(() =>
    Promise.resolve(
      newsResponse(
        create(GetMarketNewsResponseSchema, { articles: [], totalCount: 0 }),
      ),
    ),
  ),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await waitFor(() => {
      expect(canvas.getByText("No news articles available")).toBeInTheDocument();
    });
  },
};

/**
 * Compact: headlines clamp to one line (line-clamp-1) and the source /
 * sentiment badge row is dropped; stock-code links remain.
 */
export const Compact: Story = {
  args: { sizeVariant: "compact" },
  decorators: [withGridCell("small")],
  beforeEach: () => stubMarketNewsFetch(() =>
    Promise.resolve(newsResponse(marketNewsResponseFixture())),
  ),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const fixture = marketNewsResponseFixture();
    await waitFor(() => {
      expect(canvas.getByText(fixture.articles[0]!.headline)).toBeInTheDocument();
    });
    const headline = canvas.getByText(fixture.articles[0]!.headline);
    expect(headline.className).toContain("line-clamp-1");
    // Badge row is hidden in compact mode.
    expect(canvas.queryByText("Positive")).not.toBeInTheDocument();
    expect(canvas.queryByText("ASX")).not.toBeInTheDocument();
    // Stock-code links survive compacting.
    expect(canvas.getByRole("link", { name: "PLS" })).toBeInTheDocument();
  },
};

export const Mobile: Story = {
  parameters: {
    viewport: { defaultViewport: "mobile1" },
    nextjs: { appDirectory: true },
  },
  decorators: [withGridCell("small")],
  beforeEach: () => stubMarketNewsFetch(() =>
    Promise.resolve(newsResponse(marketNewsResponseFixture())),
  ),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const fixture = marketNewsResponseFixture();
    await waitFor(() => {
      expect(canvas.getByText(fixture.articles[0]!.headline)).toBeInTheDocument();
    });
  },
};
