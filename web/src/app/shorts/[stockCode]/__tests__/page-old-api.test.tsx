/// <reference types="jest" />
import "@testing-library/jest-dom";
import { TextEncoder, TextDecoder } from "util";

if (!globalThis.TextEncoder) {
  globalThis.TextEncoder = TextEncoder;
}
if (!globalThis.TextDecoder) {
  // @ts-expect-error - TextDecoder type on Node differs from DOM lib
  globalThis.TextDecoder = TextDecoder;
}

/**
 * The stock page against an OLDER API (docs/plans/fundamentals-coverage.md
 * §1 "Absent is not a status", §7.1 "old-API jest case").
 *
 * The web deploys independently of the API, and migration 000132 can block the
 * API swap while Vercel still ships. So the page must render an old-proto
 * GetStockFundamentals response (no coverage, no quality, no latest filing)
 * exactly as today: no empty state (an absent coverage is "unknown", never
 * "not collected"), no ratios card, and no Strategy fit card when the fit rpc
 * rejects (it does not exist on that API). The fit failure must not fail the
 * render.
 *
 * The real getStockFundamentals and getStockStrategyFit actions run here, over
 * a mocked connect client; everything else on the page is stubbed.
 */

import { describe, it, expect } from "@jest/globals";
import { create } from "@bufbuild/protobuf";
import { render, screen, within } from "@testing-library/react";
import {
  FundamentalsGrowthSchema,
  FundamentalsPeriodSchema,
  GetStockFundamentalsResponseSchema,
} from "~/gen/shorts/v1alpha1/stock_pb";

const mockGetStockFundamentals = jest.fn();
const mockGetStockStrategyFit = jest.fn();
const mockListStrategies = jest.fn();

jest.mock("@connectrpc/connect-web", () => ({
  createConnectTransport: jest.fn(() => ({})),
}));
jest.mock("@connectrpc/connect", () => ({
  createClient: jest.fn(() => ({
    getStockFundamentals: (...args: unknown[]) => mockGetStockFundamentals(...args),
    getStockStrategyFit: (...args: unknown[]) => mockGetStockStrategyFit(...args),
    listStrategies: (...args: unknown[]) => mockListStrategies(...args),
  })),
}));
jest.mock("next/cache", () => ({
  unstable_cache: (loader: () => Promise<unknown>) => loader,
}));
jest.mock("next/dynamic", () => () => () => null);
jest.mock("next/navigation", () => ({
  notFound: () => {
    throw new Error("NEXT_NOT_FOUND");
  },
  usePathname: () => "/shorts/BHP",
}));
jest.mock("next/link", () => ({
  __esModule: true,
  default: ({ children, href }: { children: React.ReactNode; href: string }) => (
    <a href={href}>{children}</a>
  ),
}));

// Page-level data other than fundamentals.
jest.mock("~/app/actions/getStock", () => ({
  getStockOrNotFound: jest.fn(async () => ({
    productCode: "BHP",
    name: "BHP GROUP LIMITED ORDINARY",
    industry: "Materials",
    percentageShorted: 1.2,
    reportedShortPositions: 60_000_000,
  })),
}));
jest.mock("~/app/actions/getRelatedStocks", () => ({
  getRelatedStocks: jest.fn(async () => ({ stocks: [], industry: null, industrySlug: null })),
}));
jest.mock("~/app/actions/getStockNews", () => ({
  getStockHeadlines: jest.fn(async () => []),
}));
jest.mock("~/app/actions/getLatestShortDate", () => ({
  getLatestShortDate: jest.fn(async () => null),
}));
jest.mock("~/app/actions/getEconomy", () => ({
  getStateExposureIndex: jest.fn(async () => ({})),
}));
jest.mock("~/app/actions/company-metadata", () => ({
  getEnrichedCompanyMetadata: jest.fn(async () => null),
}));
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
jest.mock("../short-interest-history", () => ({ ShortInterestHistory: () => null }));

// The tabs shell renders EVERY slot here, so the Financials tab is visible to
// the assertions (the real shell only renders the active panel).
jest.mock("~/@/components/company/stock-tabs", () => ({
  StockTabs: ({
    overviewMain,
    financialsContent,
  }: {
    overviewMain?: React.ReactNode;
    financialsContent?: React.ReactNode;
  }) => (
    <div>
      <section data-testid="overview">{overviewMain}</section>
      <section data-testid="financials">{financialsContent}</section>
    </div>
  ),
}));

// Everything else on the page is out of scope.
jest.mock("~/@/components/layouts/dashboard-layout", () => ({
  DashboardLayout: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));
jest.mock("~/@/components/ui/companyProfile", () => ({
  __esModule: true,
  default: () => null,
  CompanyProfilePlaceholder: () => null,
}));
jest.mock("~/@/components/ui/companyStats", () => ({
  __esModule: true,
  default: () => null,
  CompanyStatsPlaceholder: () => null,
}));
jest.mock("~/@/components/ui/companyInfo", () => ({
  __esModule: true,
  default: () => null,
  CompanyInfoPlaceholder: () => null,
}));
jest.mock("~/@/components/company/enriched-company-section", () => ({
  EnrichedCompanySection: () => null,
}));
jest.mock("~/@/components/company/company-tax-card", () => ({
  CompanyTaxCard: () => <div data-testid="tax-card" />,
}));
// The filings stream in async server components under Suspense, which a
// client render cannot resolve; their own test (financial-reports-section)
// covers them. The stubs expose the props the page passes.
jest.mock("~/@/components/company/financial-reports-section", () => ({
  FinancialReportsSection: ({
    stockCode,
    sourceDocumentUrl,
  }: {
    stockCode: string;
    sourceDocumentUrl: string;
  }) => (
    <div
      data-testid="reports-section"
      data-code={stockCode}
      data-source-document-url={sourceDocumentUrl}
    />
  ),
  FilingsListedNote: ({ stockCode }: { stockCode: string }) => (
    <span data-testid="filings-note" data-code={stockCode} />
  ),
}));
jest.mock("~/@/components/company/politician-interests-card-loader", () => ({
  PoliticianInterestsCard: () => null,
}));
jest.mock("~/@/components/company/community/community-overview-teaser", () => ({
  CommunityOverviewTeaser: () => null,
}));
jest.mock("~/@/components/company/community/community-tab", () => ({
  CommunityTab: () => null,
}));
jest.mock("~/@/components/company/stock-evidence-panel-client", () => ({
  StockEvidencePanelClient: () => null,
}));
jest.mock("~/@/components/ui/login-prompt-banner", () => ({ LoginPromptBanner: () => null }));
jest.mock("~/@/components/ui/session-gates", () => ({ SignedOutOnly: () => null }));
jest.mock("~/@/components/seo/breadcrumbs", () => ({
  Breadcrumbs: () => null,
  BreadcrumbStructuredData: () => null,
}));
jest.mock("~/@/components/seo/llm-meta", () => ({
  LLMMeta: () => null,
  StockLLMMeta: () => null,
}));
jest.mock("~/@/components/seo/related-stocks", () => ({ RelatedStocks: () => null }));
jest.mock("~/@/components/reports/latest-weekly-report-link", () => ({
  LatestWeeklyReportLink: () => null,
}));
jest.mock("~/@/components/themes/theme-chips", () => ({ StockThemeChips: () => null }));
jest.mock("~/@/components/economy/stock-state-exposure", () => ({
  StockStateExposure: () => null,
}));

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

  it("renders an old-proto response as today: no empty state, no fit card, no failed render", async () => {
    mockGetStockFundamentals.mockResolvedValue(oldProtoResponse());
    // The older API has no GetStockStrategyFit: the rpc rejects.
    const unimplemented = Object.assign(new Error("unimplemented"), { code: 12 });
    mockGetStockStrategyFit.mockRejectedValue(unimplemented);
    mockListStrategies.mockResolvedValue({ strategies: [] });

    const element = await Page({ params: Promise.resolve({ stockCode: "bhp" }) });
    render(element);

    const financials = screen.getByTestId("financials");
    const overview = screen.getByTestId("overview");

    // The held figures still render.
    const latest = within(financials).getByRole("region", { name: "Latest result" });
    expect(within(latest).getByText("51.26B")).toBeInTheDocument();
    expect(
      within(financials).getByRole("region", { name: "Financial statements" }),
    ).toBeInTheDocument();
    expect(within(financials).getByTestId("tax-card")).toBeInTheDocument();
    // The filings list is the streamed section, given the code and the
    // Latest result's (here absent) source document as plain strings.
    const reports = within(financials).getByTestId("reports-section");
    expect(reports).toHaveAttribute("data-code", "BHP");
    expect(reports).toHaveAttribute("data-source-document-url", "");
    // Absent is not a status: no empty state, no "0 of M", no ratios card.
    expect(screen.queryByText(EMPTY_STATE)).not.toBeInTheDocument();
    expect(within(financials).queryByRole("region", { name: "Key ratios" })).not.toBeInTheDocument();
    // The fit rpc failed: no card, and the render did not fail.
    expect(screen.queryByRole("region", { name: "Strategy fit" })).not.toBeInTheDocument();
    // The crawlable summary is built from what is held.
    expect(within(overview).getByText(/recorded revenue of US\$51\.3B/)).toBeInTheDocument();
    // The stale Key metrics card and the raw extraction tiles are gone.
    expect(screen.queryByText("Key metrics")).not.toBeInTheDocument();
    expect(screen.queryByText("Results summary")).not.toBeInTheDocument();
  });

  it("renders the Strategy fit card in the Overview when the fit rpc answers", async () => {
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

    const card = within(screen.getByTestId("overview")).getByRole("region", {
      name: "Strategy fit",
    });
    expect(within(card).getByRole("link", { name: "CAN SLIM" })).toHaveAttribute(
      "href",
      "/picks/canslim",
    );
    expect(within(card).getByText("rank 18 of 40")).toBeInTheDocument();
    expect(within(card).getByText("1. Market direction: pass. XJO uptrend")).toBeInTheDocument();
  });

  it("keeps the fit fetch out of the page's critical Promise.all", () => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const fs = require("node:fs") as typeof import("node:fs");
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const path = require("node:path") as typeof import("node:path");
    const source = fs.readFileSync(path.resolve(__dirname, "../page.tsx"), "utf8");
    const critical = /await Promise\.all\(\[([\s\S]*?)\]\)/.exec(source)?.[1] ?? "";
    expect(critical).toContain("getStockOrNotFound");
    expect(critical).not.toContain("getStockStrategyFit");
    expect(source).toMatch(/getStockStrategyFit\(stockCode\)\.catch\(/);
    // The company details read (getStockDetails, with retries) is not awaited
    // by the page: the filings stream under their own Suspense boundary.
    expect(source).not.toContain("getEnrichedCompanyMetadata");
    expect(source).not.toMatch(/getStockDetails\(/);
    expect(source).toContain("<FinancialReportsSection");
    // The stale snapshot card and the extraction tiles left the page.
    expect(source).not.toContain("CompanyFinancials");
    expect(source).not.toContain("FinancialDigest");
    expect(source).not.toContain("getStockFinancialHighlights");
  });

  it("returns the page without waiting on the company details read", async () => {
    // getStockDetails retries three times with backoff and has no request
    // timeout: a slow read must cost the Financials tab's filings list, never
    // the page's first byte.
    mockGetStockFundamentals.mockResolvedValue(oldProtoResponse());
    mockGetStockStrategyFit.mockRejectedValue(new Error("unavailable"));
    mockListStrategies.mockRejectedValue(new Error("unavailable"));
    const { getEnrichedCompanyMetadata } = jest.requireMock<{
      getEnrichedCompanyMetadata: jest.Mock;
    }>("~/app/actions/company-metadata");
    getEnrichedCompanyMetadata.mockImplementation(() => new Promise(() => undefined));

    let timer: ReturnType<typeof setTimeout> | undefined;
    const stalled = new Promise<never>((_, reject) => {
      timer = setTimeout(
        () => reject(new Error("the page awaited the company details read")),
        2000,
      );
    });
    try {
      const element = await Promise.race([
        Page({ params: Promise.resolve({ stockCode: "BHP" }) }),
        stalled,
      ]);
      expect(element).toBeTruthy();
    } finally {
      clearTimeout(timer);
      getEnrichedCompanyMetadata.mockImplementation(async () => null);
    }
  });

  it("renders without any fundamentals when that rpc fails too", async () => {
    mockGetStockFundamentals.mockRejectedValue(new Error("unavailable"));
    mockGetStockStrategyFit.mockRejectedValue(new Error("unavailable"));
    mockListStrategies.mockRejectedValue(new Error("unavailable"));

    const element = await Page({ params: Promise.resolve({ stockCode: "BHP" }) });
    render(element);

    const financials = screen.getByTestId("financials");
    expect(screen.queryByText(EMPTY_STATE)).not.toBeInTheDocument();
    expect(within(financials).queryByRole("region", { name: "Latest result" })).not.toBeInTheDocument();
    expect(within(financials).getByTestId("tax-card")).toBeInTheDocument();
    expect(screen.queryByRole("region", { name: "Strategy fit" })).not.toBeInTheDocument();
  });
});
