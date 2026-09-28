// Shared plain-data fixtures for the stock picker tests. Shapes are the
// serialisable rows from ~/@/lib/strategies/types, never protobuf objects.

import type {
  MarketRegimeView,
  PickRow,
  StrategyDef,
  StrategyPicksResult,
} from "~/@/lib/strategies/types";

export const ZANGER: StrategyDef = {
  id: "zanger-breakout",
  name: "Zanger Breakout",
  author: "Dan Zanger",
  tagline:
    "Buy fast-growing companies as they break out of a tight base on heavy volume.",
  descriptionParagraphs: [
    "Dan Zanger turned a small account into millions by buying breakouts.",
    "We test his rules daily against ASX prices and reported fundamentals.",
  ],
  rules: [
    {
      id: "growth",
      title: "Explosive growth",
      ruleText: "Look for explosive earnings and revenue growth.",
      evaluation: "Revenue YoY or EPS YoY of at least 25% in the latest period.",
      core: true,
      dataSource: "stock_fundamentals",
    },
    {
      id: "base",
      title: "A recognisable base",
      ruleText: "Buy only out of a proper base.",
      evaluation: "A 20 to 120 session consolidation no deeper than 25%.",
      core: true,
      dataSource: "stock_prices",
    },
    {
      id: "breakout",
      title: "Breakout on volume",
      ruleText: "Buy the breakout on heavy volume.",
      evaluation: "Close above the prior 40-session high on 1.5x average volume.",
      core: true,
      dataSource: "stock_prices",
    },
    {
      id: "rs",
      title: "Relative strength",
      ruleText: "Let winners run.",
      evaluation: "3-month return ahead of the S&P/ASX 200.",
      core: false,
      dataSource: "index_prices",
    },
  ],
  metadata: {
    style: "momentum-breakout",
    holdingPeriod: "weeks to months",
    riskPosture: "cut on a failed breakout (back inside the base)",
    universe: "ASX equities with at least A$250k daily turnover",
    refreshCadence: "daily after the price sweep",
    ruleCount: 4,
  },
  caveats: ["We do not classify the base shape; we only detect that one exists."],
  sources: ["Fortune, 2000: profile of Dan Zanger's 29,233% year."],
};

export const UPTREND: MarketRegimeView = {
  indexCode: "XJO",
  asOf: "2026-09-25",
  regime: "uptrend",
  close: 8812.3,
  sma50: 8600,
  sma200: 8200,
  pctOff52wHigh: -1.5,
  verdict:
    "Green light: XJO is above its 50-day and 200-day averages, the backdrop Zanger wants before buying breakouts.",
};

export function pick(overrides: Partial<PickRow> & Pick<PickRow, "code">): PickRow {
  return {
    rank: 1,
    name: `${overrides.code} Limited`,
    industry: "Materials",
    status: "watch",
    score: 50,
    rules: [],
    close: 12.34,
    asOf: "2026-09-25",
    pivot: 11.9,
    baseDepthPct: 14.2,
    baseLengthDays: 38,
    volumeRatio: 2.1,
    revenueYoyPct: 41.2,
    epsYoyPct: 22.5,
    rs3mPct: 8.4,
    shortPct: 3.21,
    marketCap: 1.2e9,
    logoUrl: "",
    ...overrides,
  };
}

export const TRIGGERED = pick({
  code: "BHP",
  rank: 1,
  status: "triggered",
  score: 88,
  // Full-year revenue from the vendor; half-year EPS from a company filing.
  fundamentals: {
    revenueBasis: "annual",
    revenueEnd: "2026-06-30",
    epsBasis: "half",
    epsEnd: "2025-12-31",
    epsFiling: true,
    fetchedOn: "2026-09-27",
    netMarginPct: 18.2,
    roePct: 21.4,
    fcfMarginPct: 9.1,
    netDebtToEbitda: 0.4,
    peRatio: 14.2,
  },
  rules: [
    { ruleId: "growth", status: "pass", detail: "Revenue +41.2% YoY" },
    { ruleId: "base", status: "pass", detail: "38-session base, 14.2% deep" },
    { ruleId: "breakout", status: "pass", detail: "Broke out on 2.1x volume" },
    { ruleId: "rs", status: "pass", detail: "Beat the index by 8.4 points" },
  ],
});

export const SETUP = pick({
  code: "PLS",
  rank: 2,
  status: "setup",
  score: 71,
  revenueYoyPct: null,
  epsYoyPct: null,
  shortPct: null,
  rules: [
    { ruleId: "growth", status: "pass", detail: "Swung from a loss to a profit" },
    { ruleId: "base", status: "pass", detail: "44-session base, 18.0% deep" },
    { ruleId: "breakout", status: "fail", detail: "Still inside the base" },
    { ruleId: "rs", status: "unknown", detail: "Not enough history" },
  ],
});

export const WATCH = pick({
  code: "LTR",
  rank: 3,
  status: "watch",
  score: 32,
  // A US-dollar reporter: no P/E, and the row says why.
  fundamentals: {
    revenueBasis: "ttm",
    revenueEnd: "2026-06-30",
    epsBasis: "annual",
    epsEnd: "2026-06-30",
    currency: "USD",
    fetchedOn: "2026-09-27",
    netMarginPct: -4.3,
  },
  rules: [
    { ruleId: "growth", status: "unknown", detail: "No fundamentals yet" },
    { ruleId: "base", status: "pass", detail: "25-session base" },
    { ruleId: "breakout", status: "fail", detail: "No breakout" },
    { ruleId: "rs", status: "fail", detail: "Lagged the index" },
  ],
});

export const PICKS: StrategyPicksResult = {
  strategy: ZANGER,
  regime: UPTREND,
  picks: [TRIGGERED, SETUP, WATCH],
  totalCount: 3,
  universeCount: 1904,
  fundamentalsCoverageCount: 812,
  fundamentalsRowsCount: 1203,
  asOf: "2026-09-25",
};

/**
 * GetStrategyPicks as Connect's protojson carries it to a browser: camelCase
 * names, every default-valued field OMITTED (a false has_* flag, an empty
 * string, a zero). The server action receives the same message as a
 * protobuf-es object; the parity test feeds this one fixture through both.
 */
export const PROTOJSON_PICKS = {
  strategy: {
    id: "zanger-breakout",
    name: "Zanger Breakout",
    author: "Dan Zanger",
    tagline: ZANGER.tagline,
    descriptionParagraphs: ZANGER.descriptionParagraphs,
    rules: ZANGER.rules,
    metadata: { ...ZANGER.metadata, ruleCount: 4 },
    caveats: ZANGER.caveats,
    sources: ZANGER.sources,
  },
  regime: {
    indexCode: "XJO",
    asOf: "2026-09-25",
    regime: "uptrend",
    close: 8812.3,
    sma50: 8600,
    sma200: 8200,
    pctOff52wHigh: -1.5,
    verdict: UPTREND.verdict,
  },
  picks: [
    {
      rank: 1,
      stockCode: "BHP",
      companyName: "BHP Group",
      industry: "Materials",
      status: "triggered",
      score: 88.4,
      rules: [
        { ruleId: "growth", status: "pass", detail: "Revenue +41.2% YoY", value: 41.2, hasValue: true },
        { ruleId: "base", status: "pass", detail: "38-session base, 14.2% deep" },
      ],
      close: 45.1,
      asOf: "2026-09-25",
      pctOff52wHigh: -2,
      volumeRatio50d: 2.1,
      baseDepthPct: 14.2,
      baseLengthDays: 38,
      pivot: 44.2,
      revenueYoyPct: 41.2,
      hasRevenueYoy: true,
      epsYoyPct: 22.5,
      hasEpsYoy: true,
      rs3mPct: 8.4,
      marketCap: 230000000000,
      logoUrl: "https://example.test/bhp.png",
      hasRs3mPct: true,
      hasMarketCap: true,
      hasClose: true,
      fundamentals: {
        revenueBasisPeriodType: "annual",
        revenuePeriodEnd: "2026-06-30",
        epsBasisPeriodType: "half",
        epsPeriodEnd: "2025-12-31",
        currency: "USD",
        fetchedAt: "2026-09-27T01:00:00Z",
        revenueBasisSource: "vendor",
        epsBasisSource: "filing",
        netMarginPct: 18.24,
        hasNetMarginPct: true,
        roePct: 21.43,
        hasRoePct: true,
        netDebtToEbitda: 0.41,
        hasNetDebtToEbitda: true,
        netIncomePositive: true,
      },
    },
    {
      rank: 2,
      stockCode: "PLS",
      companyName: "Pilbara Minerals",
      industry: "Materials",
      status: "setup",
      score: 71,
      rules: [{ ruleId: "breakout", status: "fail", detail: "Still inside the base" }],
      close: 3.2,
      asOf: "2026-09-25",
      baseLengthDays: 44,
      baseDepthPct: 18,
      // A measured zero short position survives on its flag.
      hasShortPct: true,
      hasClose: true,
    },
  ],
  totalCount: 57,
  universeCount: 1904,
  fundamentalsCoverageCount: 812,
  fundamentalsRowsCount: 1203,
  asOf: "2026-09-25",
};
