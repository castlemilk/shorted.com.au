/**
 * NewsCard stories — market/editorial news card with source + sentiment badges
 * and an optional external publisher thumbnail.
 *
 * NewsCard is a pure presentational component (takes a fully-formed `article`
 * prop, no fetch), so these stories need no network stubbing — unlike
 * NewsFeedWidget, which mocks GetMarketNews.
 *
 * Coverage focus (guards the perf/a11y batch that added NewsImage):
 * - The thumbnail is wrapped in its OWN <a>. That link must carry an
 *   accessible name (aria-label = headline) or it reads as an empty link
 *   ("Links must have discernible text"). The Default play() asserts it.
 * - $TICKER chips use stockChipPalette().onCard, whose light-mode text was
 *   darkened to -700 for WCAG AA on white cards; WithTicker renders one.
 */
import type { Meta, StoryObj } from "@storybook/nextjs-vite";
import { expect, within } from "storybook/test";

import { NewsCard, type NewsCardArticle } from "./news-card";

const baseArticle: NewsCardArticle = {
  id: "1",
  headline:
    "StockTake: Solar technology leader joins ClearVue's expanding glass empire",
  url: "https://stockhead.com.au/stockhead-tv/stocktake/example",
  source: "Stockhead",
  publishedAt: new Date("2026-07-16T09:30:00+10:00").toISOString(),
  sentiment: "neutral",
  summary:
    "The building-integrated solar player has signed a fresh partnership that widens its addressable market across commercial glazing.",
  // A representative allowlisted publisher URL — in the app this flows through
  // next/image; Storybook's next/image mock renders it unoptimized.
  imageUrl: "https://stockhead.com.au/wp-content/uploads/2026/07/CPV-1200x675-1.jpg",
  stockCode: "CPV",
  isPriceSensitive: false,
};

const meta: Meta<typeof NewsCard> = {
  title: "News/NewsCard",
  component: NewsCard,
  parameters: { layout: "padded" },
  decorators: [
    (Story) => (
      <div style={{ maxWidth: 640 }}>
        <Story />
      </div>
    ),
  ],
};
export default meta;

type Story = StoryObj<typeof NewsCard>;

export const Default: Story = {
  args: { article: baseArticle },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    // No link may be nameless ("Links must have discernible text"). The
    // thumbnail <a> wraps a decorative image, so it draws its name from
    // aria-label — assert every link resolves to a non-empty name.
    const links = canvas.getAllByRole("link");
    for (const link of links) {
      const name = (
        link.getAttribute("aria-label") ??
        link.textContent ??
        ""
      ).trim();
      await expect(name.length).toBeGreaterThan(0);
    }
    // Two links now resolve to the headline — the heading anchor (text) AND
    // the thumbnail anchor (aria-label). Pre-fix only the heading matched, so
    // ">= 2" proves the thumbnail link gained its accessible name.
    const named = canvas.getAllByRole("link", { name: baseArticle.headline });
    await expect(named.length).toBeGreaterThanOrEqual(2);
  },
};

export const Hero: Story = {
  args: { article: baseArticle, variant: "hero" },
  decorators: [
    (Story) => (
      <div style={{ maxWidth: 880 }}>
        <Story />
      </div>
    ),
  ],
};

export const Compact: Story = {
  args: { article: { ...baseArticle, imageUrl: undefined }, variant: "compact" },
};

export const WithTickerChip: Story = {
  args: {
    article: {
      ...baseArticle,
      stockCode: "TNE",
      isPriceSensitive: true,
      sentiment: "positive",
    },
  },
};

export const PositiveSentiment: Story = {
  args: { article: { ...baseArticle, sentiment: "positive", stockCode: "AGN" } },
};

export const Syndicated: Story = {
  args: {
    article: {
      ...baseArticle,
      syndicationCount: 3,
      syndicatedSources: ["Small Caps", "Motley Fool"],
    },
  },
};
