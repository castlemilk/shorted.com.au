// Scan registry — the single source of truth for the /scans pages.
//
// Each scan is a fixed-URL, SEO-indexable view over the screener MV
// (mv_screener_data via ScreenStocks): daily-fresh tables that answer one
// query each ("asx stocks with rising short interest", "short covering
// asx", …). The screener page serves the same data interactively; these
// exist because query-matching, stable, sitewide-linked URLs rank and
// ?preset= query params don't.
//
// Everything here must stay serializable (no functions) — the registry is
// imported by server pages AND the sitemap.

import {
  ScreenerSortField,
  SortDirection,
} from "~/gen/shorts/v1alpha1/shorts_pb";

export interface ScanRange {
  min?: number;
  max?: number;
}

export interface ScanDefinition {
  slug: string;
  /** <title> without the "| Shorted" suffix (layout template appends it). */
  title: string;
  h1: string;
  /** Meta description (~155 chars, query-targeted). */
  description: string;
  keywords: string[];
  /** Short visible dek under the H1. */
  dek: string;
  /** ~100-150 words of unique explanatory copy (server-rendered). */
  blurb: string;
  /** RangeFilter bounds keyed by ScreenerFilters field name. */
  filters: {
    shortPct?: ScanRange;
    shortPctChange?: ScanRange;
    priceChange1m?: ScanRange;
    daysToCover?: ScanRange;
    marketCap?: ScanRange;
  };
  sortField: ScreenerSortField;
  sortDirection: SortDirection;
  /** Slugs of related scans to cross-link. */
  related: string[];
}

export const SCANS: Record<string, ScanDefinition> = {
  "short-interest-rising": {
    slug: "short-interest-rising",
    title: "ASX Stocks With Rising Short Interest — Live Scan",
    h1: "ASX Stocks With Rising Short Interest",
    description:
      "ASX stocks where short sellers are building positions: every stock whose short interest rose at least 1 percentage point over the past four weeks. Official ASIC data, updated daily.",
    keywords: [
      "rising short interest asx",
      "asx stocks being shorted",
      "short interest increasing",
      "shorts building asx",
    ],
    dek: "Where short sellers are building — short interest up at least 1 percentage point over four weeks.",
    blurb:
      "A rising short position means professional investors are adding to bets against a company faster than others are closing theirs. Sustained builds often precede — or follow — earnings downgrades, broker target cuts, or structural doubts about a business. This scan lists every ASX stock whose ASIC-reported short interest has increased by at least one percentage point of issued capital over the past four weeks, ranked by the size of the build. A one-point move is a meaningful commitment: on a mid-cap it can represent tens of millions of dollars of new short exposure.",
    filters: { shortPctChange: { min: 1 } },
    sortField: ScreenerSortField.SHORT_PCT_CHANGE,
    sortDirection: SortDirection.DESC,
    related: ["shorts-covering", "heavily-shorted", "high-days-to-cover"],
  },
  "shorts-covering": {
    slug: "shorts-covering",
    title: "ASX Short Covering Scan — Where Shorts Are Closing",
    h1: "ASX Short Covering Scan",
    description:
      "ASX stocks where short sellers are closing out: short interest down at least 1 percentage point over four weeks. Covering can signal capitulation — or the end of a thesis. Updated daily from ASIC data.",
    keywords: [
      "short covering asx",
      "shorts closing positions asx",
      "short interest falling",
      "asx short covering rally",
    ],
    dek: "Where short sellers are closing out — short interest down at least 1 percentage point over four weeks.",
    blurb:
      "Short covering is the act of buying back borrowed shares to close a short position — and that buying is real demand for the stock. Heavy covering can mean the bears' thesis played out and they are taking profits, or that the trade is being abandoned because the stock refuses to fall. This scan lists every ASX stock whose ASIC-reported short interest has dropped by at least one percentage point of issued capital over the past four weeks, ranked by the size of the unwind. Pair it with the price column: covering into a rising price is the classic fuel of a squeeze.",
    filters: { shortPctChange: { max: -1 } },
    sortField: ScreenerSortField.SHORT_PCT_CHANGE,
    sortDirection: SortDirection.ASC,
    related: [
      "shorts-covering-into-strength",
      "short-interest-rising",
      "heavily-shorted",
    ],
  },
  "heavily-shorted": {
    slug: "heavily-shorted",
    title: "Heavily Shorted ASX Stocks — 10%+ Short Interest",
    h1: "Heavily Shorted ASX Stocks",
    description:
      "Every ASX stock with 10% or more of issued shares sold short — the market's highest-conviction bear cases. Official ASIC short position data, updated daily.",
    keywords: [
      "heavily shorted asx stocks",
      "most shorted stocks over 10%",
      "high short interest asx",
      "asx bearish stocks",
    ],
    dek: "The market's highest-conviction bear cases — 10% or more of issued shares sold short.",
    blurb:
      "Ten percent short interest is the informal threshold where a short position stops being a hedge and becomes a statement. Stocks on this list carry the market's most aggressive bear cases — but they are also the stocks with the most stored squeeze energy, because every short sold must eventually be bought back. This scan lists every ASX company with at least 10% of issued capital reported short to ASIC, ranked by short interest. Watch the days-to-cover column: high short interest plus thin trading volume is what turns a re-rating into a rout for the shorts.",
    filters: { shortPct: { min: 10 } },
    sortField: ScreenerSortField.SHORT_PCT,
    sortDirection: SortDirection.DESC,
    related: [
      "high-days-to-cover",
      "short-interest-rising",
      "shorted-and-falling",
    ],
  },
  "high-days-to-cover": {
    slug: "high-days-to-cover",
    title: "Highest Days to Cover on the ASX — Squeeze Fuel Scan",
    h1: "Highest Days to Cover on the ASX",
    description:
      "ASX stocks where shorts would need 10+ days of normal trading volume to exit. High days-to-cover is the fuel of short squeezes. Computed daily from ASIC short positions and 20-day volumes.",
    keywords: [
      "days to cover asx",
      "short interest ratio asx",
      "asx short squeeze fuel",
      "illiquid short positions",
    ],
    dek: "Shorts needing 10+ days of normal volume to exit — the squeeze-fuel metric.",
    blurb:
      "Days to cover divides a stock's reported short shares by its 20-day average trading volume: how long the entire short interest would take to buy back at normal turnover. When it stretches past ten days, shorts cannot exit quickly — any forced buying pushes the price into their own bids. This scan lists ASX stocks with at least ten days to cover and meaningful short interest (2%+ of issued capital, filtering out illiquid noise), ranked by the metric. It is the single best fuel gauge for squeeze potential; the squeeze radar combines it with momentum and crowding.",
    filters: { daysToCover: { min: 10 }, shortPct: { min: 2 } },
    sortField: ScreenerSortField.DAYS_TO_COVER,
    sortDirection: SortDirection.DESC,
    related: ["heavily-shorted", "shorts-covering", "short-interest-rising"],
  },
  "shorts-covering-into-strength": {
    slug: "shorts-covering-into-strength",
    title: "Shorts Covering Into Strength — ASX Momentum Scan",
    h1: "Shorts Covering Into Strength",
    description:
      "ASX stocks rising 5%+ over a month while short sellers close positions — the covering-into-strength setup that powers squeezes. Updated daily from ASIC data.",
    keywords: [
      "short covering rally asx",
      "shorts capitulating",
      "covering into strength",
      "asx squeeze in progress",
    ],
    dek: "Price up 5%+ over a month while shorts close out — the setup that powers squeezes.",
    blurb:
      "The most dangerous moment for a short position is when the price rises and other shorts start buying to exit — their covering adds fuel to the very rally hurting them. This scan isolates that setup: ASX stocks up at least 5% over the past month whose short interest has simultaneously fallen. It is effectively a squeeze-in-progress detector, complementary to the squeeze radar (which flags the preconditions before the move). Stocks appear here when the unwind has already started; the question the table answers is how much short interest remains to be covered.",
    filters: { shortPctChange: { max: -0.5 }, priceChange1m: { min: 5 } },
    sortField: ScreenerSortField.PRICE_CHANGE_1M,
    sortDirection: SortDirection.DESC,
    related: ["shorts-covering", "high-days-to-cover", "heavily-shorted"],
  },
  "shorted-and-falling": {
    slug: "shorted-and-falling",
    title: "Heavily Shorted & Falling — Where ASX Shorts Are Winning",
    h1: "Heavily Shorted & Falling ASX Stocks",
    description:
      "ASX stocks with 5%+ short interest that have dropped 10%+ in a month — where the bears are being paid. Official ASIC short data joined with price action, updated daily.",
    keywords: [
      "shorts winning asx",
      "shorted stocks falling",
      "asx stocks under pressure",
      "successful short positions",
    ],
    dek: "5%+ short interest and a 10%+ one-month price fall — where the bears are being paid.",
    blurb:
      "Short sellers are right more often than the folklore suggests, and this scan shows where: ASX stocks carrying at least 5% short interest whose price has fallen 10% or more over the past month. These are the positions currently paying the bears — and a useful contrarian watchlist, because a crowded, profitable short eventually has to take profits, which means buying. This scan ranks them by the depth of the one-month fall; cross-reference the 4-week change column to see whether shorts are pressing their bets or already quietly covering into the weakness.",
    filters: { shortPct: { min: 5 }, priceChange1m: { max: -10 } },
    sortField: ScreenerSortField.PRICE_CHANGE_1M,
    sortDirection: SortDirection.ASC,
    related: [
      "heavily-shorted",
      "short-interest-rising",
      "shorts-covering",
    ],
  },
};

export const SCAN_SLUGS = Object.keys(SCANS);

export function getScan(slug: string): ScanDefinition | undefined {
  return SCANS[slug];
}
