/// <reference types="jest" />
import "@testing-library/jest-dom";
import {
  mockGetStockFundamentals,
  mockGetStockStrategyFit,
  mockListStrategies,
} from "./overview-page-mocks";

/**
 * The stock Overview against an OLDER API (docs/plans/fundamentals-coverage.md
 * §1 "Absent is not a status", §7.1 "old-API jest case").
 *
 * The web deploys independently of the API, and migration 000132 can block the
 * API swap while Vercel still ships. So the page must render an old-proto
 * GetStockFundamentals response (no coverage, no quality, no latest filing)
 * exactly as today: no empty state (an absent coverage is "unknown", never
 * "not collected") and no Strategy fit strip when the fit rpc rejects (it does
 * not exist on that API). The fit failure must not fail the render. The
 * Financials tab's own old-API case (no ratios card) is in
 * components/stocks/__tests__/financials-tab.test.tsx.
 *
 * The real getStockFundamentals and getStockStrategyFit actions run here, over
 * a mocked connect client; everything else on the page is stubbed (the shared
 * stubs in overview-page-mocks.tsx, and the chart island, the About card's
 * readers and the sign-in gate below). The Overview's own blocks, the chart, the
 * About card and the sign-in slot, are page-overview.test.tsx's.
 */

import { describe, it, expect } from "@jest/globals";
import { create } from "@bufbuild/protobuf";
import { render, screen, within } from "@testing-library/react";
import {
  FundamentalsGrowthSchema,
  FundamentalsPeriodSchema,
  GetStockFundamentalsResponseSchema,
} from "~/gen/shorts/v1alpha1/stock_pb";

// The page loads one island, the chart panel. Nothing here is about it.
jest.mock("next/dynamic", () => () => () => null);
// The About card's readers and the blocks around it. Nothing here is about them,
// so the summary renders nothing, the series has no moves, the company has no
// details, and the chips, the gate and the banner render nothing.
jest.mock("../short-interest-summary", () => ({
  getShortInterestDeltas: jest.fn(async () => ({
    change7d: null,
    change30d: null,
    change90d: null,
    peakPct: null,
    peakDate: null,
  })),
  ShortInterestSummary: () => null,
}));
jest.mock("~/app/actions/getStockDetails", () => ({
  getStockDetails: jest.fn(async () => null),
}));
jest.mock("~/@/components/ui/login-prompt-banner", () => ({ LoginPromptBanner: () => null }));
jest.mock("~/@/components/ui/session-gates", () => ({ SignedOutOnly: () => null }));
jest.mock("~/@/components/themes/theme-chips", () => ({ StockThemeChips: () => null }));

import Page from "../page";

/** A GetStockFundamentals response built from the pre-000132 proto's fields only. */
function oldProtoResponse() {
  return create(GetStockFundamentalsResponseSchema, {
    stockCode: "BHP",
    periods: [
      create(FundamentalsPeriodSchema, {
        periodType: "annual",
        periodEnd: "2025-06-30",
        fiscalYear: 2025,
        currency: "USD",
        revenue: 51_262_000_000,
        hasRevenue: true,
        netIncome: 9_019_000_000,
        hasNetIncome: true,
        epsDiluted: 1.77,
        hasEpsDiluted: true,
        source: "yahoo-timeseries",
        fetchedAt: "2026-09-20T20:00:00Z",
      }),
      create(FundamentalsPeriodSchema, {
        periodType: "annual",
        periodEnd: "2024-06-30",
        fiscalYear: 2024,
        currency: "USD",
        revenue: 55_658_000_000,
        hasRevenue: true,
        netIncome: 7_897_000_000,
        hasNetIncome: true,
        source: "yahoo-timeseries",
      }),
    ],
    growth: create(FundamentalsGrowthSchema, {
      basisPeriodType: "annual",
      latestPeriodEnd: "2025-06-30",
      revenueYoyPct: -7.9,
      hasRevenueYoy: true,
    }),
    hasGrowth: true,
  });
}

const EMPTY_STATE = /Our data providers hold no|not yet collected|could not be collected/;

describe("stock page against an older API", () => {
  beforeEach(() => {
    mockGetStockFundamentals.mockReset();
    mockGetStockStrategyFit.mockReset();
    mockListStrategies.mockReset();
    jest.spyOn(console, "warn").mockImplementation(() => undefined);
    jest.spyOn(console, "error").mockImplementation(() => undefined);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it("renders an old-proto response as today: no empty state, no fit strip, no failed render", async () => {
    mockGetStockFundamentals.mockResolvedValue(oldProtoResponse());
    // The older API has no GetStockStrategyFit: the rpc rejects.
    const unimplemented = Object.assign(new Error("unimplemented"), { code: 12 });
    mockGetStockStrategyFit.mockRejectedValue(unimplemented);
    mockListStrategies.mockResolvedValue({ strategies: [] });

    const element = await Page({ params: Promise.resolve({ stockCode: "bhp" }) });
    render(element);

    // Absent is not a status: no empty state, no "0 of M".
    expect(screen.queryByText(EMPTY_STATE)).not.toBeInTheDocument();
    // The fit rpc failed: no strip, and the render did not fail.
    expect(screen.queryByRole("region", { name: "Strategy fit" })).not.toBeInTheDocument();
    // The crawlable summary is built from what is held.
    expect(screen.getByText(/recorded revenue of US\$51\.3B/)).toBeInTheDocument();
    // The stale Key metrics card and the raw extraction tiles are gone.
    expect(screen.queryByText("Key metrics")).not.toBeInTheDocument();
    expect(screen.queryByText("Results summary")).not.toBeInTheDocument();
  });

  // The Dataset and Corporation schema read the page's cleaned company name (the
  // raw ASIC string shouts): pinned so tidying the block that builds them cannot
  // change what crawlers read.
  it("emits the Dataset and Corporation JSON-LD under the cleaned company name", async () => {
    mockGetStockFundamentals.mockResolvedValue(oldProtoResponse());
    mockGetStockStrategyFit.mockRejectedValue(new Error("unavailable"));
    mockListStrategies.mockRejectedValue(new Error("unavailable"));

    const { container } = render(await Page({ params: Promise.resolve({ stockCode: "bhp" }) }));

    const schemas = Array.from(container.querySelectorAll('script[type="application/ld+json"]')).map(
      (script) => JSON.parse(script.textContent ?? "{}") as Record<string, unknown>,
    );
    expect(schemas.map((s) => s["@type"])).toEqual(["Dataset", "Corporation"]);
    expect(schemas[0]).toMatchObject({
      name: "BHP Group (BHP) Short Position History",
      about: { name: "BHP Group", tickerSymbol: "BHP" },
    });
    expect(schemas[1]).toMatchObject({ name: "BHP Group", legalName: "BHP Group", tickerSymbol: "BHP" });
  });

  it("renders the Strategy fit strip in the Overview when the fit rpc answers", async () => {
    mockGetStockFundamentals.mockResolvedValue(oldProtoResponse());
    mockGetStockStrategyFit.mockResolvedValue({
      stockCode: "BHP",
      asOf: "2026-09-25",
      inUniverse: true,
      fits: [
        {
          strategyId: "canslim",
          strategyName: "CAN SLIM",
          status: "watch",
          score: 41,
          rank: 18,
          totalCount: 40,
          rules: [{ ruleId: "market", status: "pass", detail: "XJO uptrend" }],
        },
      ],
    });
    mockListStrategies.mockResolvedValue({
      strategies: [{ id: "canslim", rules: [{ id: "market", title: "Market direction" }] }],
    });

    const element = await Page({ params: Promise.resolve({ stockCode: "BHP" }) });
    render(element);

    const card = screen.getByRole("region", { name: "Strategy fit" });
    expect(within(card).getByRole("link", { name: "CAN SLIM" })).toHaveAttribute(
      "href",
      "/picks/canslim",
    );
    expect(within(card).getByText("rank 18 of 40")).toBeInTheDocument();
    expect(
      within(card).getByRole("link", { name: /Full strategy readings/ }),
    ).toHaveAttribute("href", "/shorts/BHP/strategy");
  });

  it("links each digest into its tab and asks for three headlines", async () => {
    mockGetStockFundamentals.mockResolvedValue(oldProtoResponse());
    mockGetStockStrategyFit.mockRejectedValue(new Error("unavailable"));
    mockListStrategies.mockRejectedValue(new Error("unavailable"));
    const { getStockHeadlines } = jest.requireMock<{ getStockHeadlines: jest.Mock }>(
      "~/app/actions/getStockNews",
    );
    getStockHeadlines.mockClear();
    getStockHeadlines.mockResolvedValueOnce([
      {
        id: "n1",
        headline: "BHP lifts iron ore guidance",
        url: "https://example.test/n1",
        source: "Example Wire",
        publishedAtIso: "2026-10-07T01:00:00Z",
      },
    ]);

    render(await Page({ params: Promise.resolve({ stockCode: "bhp" }) }));

    // Three headlines are the digest; the full feed is the News tab.
    expect(getStockHeadlines).toHaveBeenCalledWith("BHP", 3);
    expect(screen.getByRole("link", { name: /History & FAQ/ })).toHaveAttribute(
      "href",
      "/shorts/BHP/short-interest",
    );
    expect(screen.getByRole("link", { name: /Full financials/ })).toHaveAttribute(
      "href",
      "/shorts/BHP/financials",
    );
    expect(screen.getByRole("link", { name: "All news" })).toHaveAttribute(
      "href",
      "/shorts/BHP/news",
    );
    expect(
      screen.getByRole("link", { name: "BHP lifts iron ore guidance" }),
    ).toHaveAttribute("href", "https://example.test/n1");
  });

  it("keeps the fit fetch out of the page's critical Promise.all", () => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const fs = require("node:fs") as typeof import("node:fs");
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const path = require("node:path") as typeof import("node:path");
    const source = fs.readFileSync(path.resolve(__dirname, "../page.tsx"), "utf8");
    const financialsSource = fs.readFileSync(
      path.resolve(__dirname, "../financials/page.tsx"),
      "utf8",
    );
    // The Overview reads the stock through the shared loader (404 on unknown,
    // a failed render on a transient read) alongside the related stocks.
    const critical = /await Promise\.all\(\[([\s\S]*?)\]\)/.exec(source)?.[1] ?? "";
    expect(critical).toContain("loadStockOrFail");
    expect(critical).not.toContain("getStockStrategyFit");
    expect(source).toMatch(/getStockStrategyFit\(stockCode\)\.catch\(/);
    // The enriched-metadata read (the Company tab's) is not the Overview's, and
    // the filings stream under their own Suspense boundary in the Financials
    // page, which reads no company details either.
    expect(source).not.toContain("getEnrichedCompanyMetadata");
    expect(financialsSource).toContain("<FinancialReportsSection");
    expect(financialsSource).not.toContain("getEnrichedCompanyMetadata");
    expect(financialsSource).not.toMatch(/getStockDetails\(/);
    // The stale snapshot card and the extraction tiles left both pages.
    for (const text of [source, financialsSource]) {
      expect(text).not.toContain("CompanyFinancials");
      expect(text).not.toContain("FinancialDigest");
      expect(text).not.toContain("getStockFinancialHighlights");
    }
  });

  it("renders without any fundamentals when that rpc fails too", async () => {
    mockGetStockFundamentals.mockRejectedValue(new Error("unavailable"));
    mockGetStockStrategyFit.mockRejectedValue(new Error("unavailable"));
    mockListStrategies.mockRejectedValue(new Error("unavailable"));

    const element = await Page({ params: Promise.resolve({ stockCode: "BHP" }) });
    render(element);

    expect(screen.queryByText(EMPTY_STATE)).not.toBeInTheDocument();
    expect(screen.queryByRole("region", { name: "Strategy fit" })).not.toBeInTheDocument();
  });
});
