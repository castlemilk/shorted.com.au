// Strategy SEO registry: the single source of truth for the /picks URL set.
//
// One entry per strategy id in docs/plans/stock-picker.md §1 plus
// quality-compounders (docs/plans/fundamentals-coverage.md §5.4); the ids are
// binding across the data, API, MCP and web streams. This file holds ONLY
// what a search result and the page chrome need before any data arrives:
// <title>, meta description, keywords, the H1, a short dek and cross-links.
//
// It deliberately carries NO prose about the rules. The method, every rule in
// the author's terms, how we test it, the caveats and the sources all come
// from the API (ListStrategies / GetStrategyPicks), whose Go registry
// (services/shorts/internal/strategies/registry.go) is the one place that
// prose lives. Duplicating it here would let the page and the API disagree
// about what a rule means, which is the one thing a rules-shown product
// cannot do.
//
// Everything here must stay serialisable (no functions): the registry is
// imported by server pages, the sitemap, the OG images and client islands.
// registry.test.ts enforces the structural rules.

export interface StrategySeo {
  /** Strategy id, identical to StrategyService's strategy_id. */
  slug: string;
  /** Short label for the strategy switcher and cross-links. */
  label: string;
  /** <title> without the "| Shorted" suffix (the layout template appends it). */
  title: string;
  h1: string;
  /** Meta description (~155 chars, query-targeted). */
  description: string;
  keywords: string[];
  /** Short visible dek under the H1. */
  dek: string;
  /** Slugs of related strategies to cross-link, in display order. */
  related: string[];
}

export const STRATEGIES: Record<string, StrategySeo> = {
  "zanger-breakout": {
    slug: "zanger-breakout",
    label: "Zanger Breakout",
    title: "Dan Zanger Breakout Strategy for ASX Stocks",
    h1: "Zanger Breakout Strategy",
    description:
      "Dan Zanger's breakout strategy applied to ASX stocks: fast growers clearing a tight base on heavy volume, with every rule shown pass or fail. Updated daily.",
    keywords: [
      "dan zanger strategy",
      "zanger breakout",
      "asx breakout stocks",
      "cup and handle asx",
      "breakout stocks on volume",
    ],
    dek: "Fast-growing companies clearing a tight base on heavy volume, checked against each of Zanger's rules, with the market trend read first.",
    related: [
      "canslim",
      "minervini-trend-template",
      "crowded-short-breakout",
      "quality-compounders",
    ],
  },

  canslim: {
    slug: "canslim",
    label: "CAN SLIM",
    title: "CAN SLIM Stocks on the ASX: William O'Neil Screen",
    h1: "CAN SLIM Strategy",
    description:
      "William O'Neil's CAN SLIM method applied to ASX stocks: surging earnings, new highs and market leadership in a confirmed uptrend. Every rule shown, daily.",
    keywords: [
      "can slim asx",
      "canslim stocks",
      "william o'neil strategy",
      "asx growth stocks",
      "can slim screener",
    ],
    dek: "Accelerating earnings, a price near its high, leadership against the index, and a market in a confirmed uptrend.",
    related: [
      "zanger-breakout",
      "minervini-trend-template",
      "quality-compounders",
      "crowded-short-breakout",
    ],
  },

  "minervini-trend-template": {
    slug: "minervini-trend-template",
    label: "Minervini Trend Template",
    title: "Minervini Trend Template: ASX Stage 2 Stocks",
    h1: "Minervini Trend Template",
    description:
      "Mark Minervini's Trend Template applied to ASX stocks: Stage 2 uptrends above rising moving averages, near 52-week highs and leading the index. Daily.",
    keywords: [
      "minervini trend template",
      "stage 2 stocks asx",
      "mark minervini screener",
      "asx uptrend stocks",
      "trend template screener",
    ],
    dek: "Stocks already in a Stage 2 uptrend: stacked moving averages, well off their lows, close to their highs and leading the market.",
    related: [
      "zanger-breakout",
      "canslim",
      "quality-compounders",
      "crowded-short-breakout",
    ],
  },

  "crowded-short-breakout": {
    slug: "crowded-short-breakout",
    label: "Crowded-Short Breakout",
    title: "Crowded-Short Breakouts: ASX Short Squeeze Setups",
    h1: "Crowded-Short Breakout",
    description:
      "Heavily shorted ASX stocks breaking out on volume: 5%+ short interest, five or more days to cover and a fresh breakout. Official ASIC short data, daily.",
    keywords: [
      "short squeeze asx",
      "crowded shorts asx",
      "heavily shorted stocks breaking out",
      "days to cover asx",
      "short squeeze candidates",
    ],
    dek: "Heavily shorted stocks clearing resistance on heavy volume, where short sellers may be forced to buy back.",
    related: [
      "zanger-breakout",
      "canslim",
      "minervini-trend-template",
      "quality-compounders",
    ],
  },

  // Our own strategy, not an author's: the display name is the API's
  // (registry.go names it "Quality compounders", sentence case), and the label
  // and H1 use it verbatim so the switcher, the hub card and the page agree.
  "quality-compounders": {
    slug: "quality-compounders",
    label: "Quality compounders",
    title: "Quality Compounders: High-ROE, Low-Debt ASX Stocks",
    h1: "Quality compounders",
    description:
      "ASX companies with a 15%+ return on equity, healthy margins, profit backed by cash and little debt, in a long-term uptrend. Every rule shown, updated daily.",
    keywords: [
      "quality stocks asx",
      "high roe stocks asx",
      "asx compounders",
      "low debt asx stocks",
      "quality investing screener",
    ],
    dek: "Profitable businesses that earn a high return on equity, turn their profit into cash and carry little debt, while the share price holds a long-term uptrend.",
    related: [
      "canslim",
      "minervini-trend-template",
      "zanger-breakout",
      "crowded-short-breakout",
    ],
  },
};

/**
 * Registry order is display order: Zanger first (plan §1), then the API's own
 * Registry() order, which appends quality-compounders
 * (docs/plans/fundamentals-coverage.md §5.4).
 */
export const STRATEGY_SLUGS = Object.keys(STRATEGIES);

export function getStrategy(slug: string): StrategySeo | undefined {
  return Object.prototype.hasOwnProperty.call(STRATEGIES, slug)
    ? STRATEGIES[slug]
    : undefined;
}
