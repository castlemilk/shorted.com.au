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
 * a mocked connect client; everything else on the page is stubbed, except the
 * Overview's own blocks (the chart section's heading, the About card and the
 * short-interest prose in it), which are real. The chart panel and the sources
 * the About card reads (company details, the short-interest series) are mocked.
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
// The page loads one island, the chart panel. The stand-in shows what the page
// handed it (the panel itself is a client-only Connect island).
jest.mock("next/dynamic", () => () => (props: {
  stockCode: string;
  prefsKey?: string;
  defaultView?: string;
  height?: number;
}) => (
  <div
    data-testid="chart-panel"
    data-code={props.stockCode}
    data-prefs-key={props.prefsKey}
    data-default-view={props.defaultView}
    data-height={props.height === undefined ? "css" : String(props.height)}
  />
));
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
// The About card's prose is the real component; only its reader is mocked.
jest.mock("../short-interest-summary", () => ({
  ...jest.requireActual<typeof import("../short-interest-summary")>(
    "../short-interest-summary",
  ),
  getShortInterestDeltas: jest.fn(async () => ({
    change7d: null,
    change30d: 0.42,
    change90d: null,
    peakPct: null,
    peakDate: null,
  })),
}));
// The About card's description. The real action reads through the edge and the
// data cache; here it answers with a company that has both summaries.
jest.mock("~/app/actions/getStockDetails", () => ({
  getStockDetails: jest.fn(async () => ({
    productCode: "BHP",
    companyName: "BHP GROUP LIMITED",
    enhancedSummary: "BHP is the world's largest listed miner, with iron ore, copper and coal.",
    summary: "BHP Group is a resources company.",
    enrichmentStatus: "completed",
  })),
}));
jest.mock("../short-interest-history", () => ({ ShortInterestHistory: () => null }));

// Everything else on the page is out of scope.
jest.mock("~/@/components/layouts/dashboard-layout", () => ({
  DashboardLayout: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
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
jest.mock("~/@/components/ui/login-prompt-banner", () => ({
  LoginPromptBanner: () => <div data-testid="login-banner" />,
}));
jest.mock("~/@/components/ui/session-gates", () => ({
  SignedOutOnly: ({ children }: { children: React.ReactNode }) => (
    <div data-testid="signed-out-only">{children}</div>
  ),
}));
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
jest.mock("~/@/components/themes/theme-chips", () => ({
  StockThemeChips: ({ stockCode, className }: { stockCode: string; className?: string }) => (
    <nav data-testid="theme-chips" data-code={stockCode} className={className} />
  ),
}));
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

  // The Overview's own blocks (spec D4): the chart first, then the About card
  // (the description, the short-interest prose, the themes), then the sign-in
  // slot, then the grid the page already had.
  describe("the chart, the About card and the sign-in slot", () => {
    const mockDetails = () =>
      jest.requireMock<{ getStockDetails: jest.Mock }>("~/app/actions/getStockDetails")
        .getStockDetails;
    const mockDeltas = () =>
      jest.requireMock<{ getShortInterestDeltas: jest.Mock }>("../short-interest-summary")
        .getShortInterestDeltas;

    async function renderOverview(stockCode = "bhp") {
      mockGetStockFundamentals.mockResolvedValue(oldProtoResponse());
      mockGetStockStrategyFit.mockRejectedValue(new Error("unavailable"));
      mockListStrategies.mockRejectedValue(new Error("unavailable"));
      return render(await Page({ params: Promise.resolve({ stockCode }) }));
    }
    const aboutCard = () => screen.getByRole("region", { name: "About BHP Group" });

    it("opens on the chart, set up for this tab: its own settings key, the combined view, a CSS-sized box", async () => {
      await renderOverview();
      const chart = screen.getByRole("region", { name: "Price & short interest" });
      expect(chart).toHaveClass("mb-4", "min-w-0");
      expect(within(chart).getByRole("heading", { level: 2 })).toHaveAttribute(
        "id",
        "stock-chart-heading",
      );
      const panel = within(chart).getByTestId("chart-panel");
      expect(panel).toHaveAttribute("data-code", "BHP");
      expect(panel).toHaveAttribute("data-prefs-key", "BHP:overview");
      expect(panel).toHaveAttribute("data-default-view", "combined");
      // No height prop: the box is 360px on a phone and 420px from sm, from CSS.
      expect(panel).toHaveAttribute("data-height", "css");
    });

    it("lays the blocks out in order: crawler summary, chart, About card, sign-in slot, then the grid", async () => {
      const { container } = await renderOverview();
      const blocks = [
        container.querySelector("section.sr-only"),
        container.querySelector("#stock-chart-heading"),
        container.querySelector("#overview-about-heading"),
        container.querySelector(".login-slot"),
        container.querySelector("#overview-short-interest-heading"),
      ];
      blocks.forEach((block) => expect(block).not.toBeNull());
      for (let i = 0; i < blocks.length - 1; i++) {
        expect(
          blocks[i]!.compareDocumentPosition(blocks[i + 1]!) & Node.DOCUMENT_POSITION_FOLLOWING,
        ).toBeTruthy();
      }
    });

    it("keeps the crawler's h1 and structured data ahead of everything it shows", async () => {
      const { container } = await renderOverview();
      const first = Array.from(container.children).slice(0, 3);
      expect(first.map((el) => el.tagName)).toEqual(["SCRIPT", "SCRIPT", "SECTION"]);
      expect(first[2]).toHaveClass("sr-only");
      expect(within(first[2] as HTMLElement).getByRole("heading", { level: 1 })).toHaveTextContent(
        "BHP Group (BHP) Short Interest",
      );
    });

    it("renders an About card with the company's description, a way to the Company tab, the prose and the themes", async () => {
      await renderOverview();
      const card = aboutCard();
      expect(card).toHaveClass("mb-4", "rounded-lg", "border", "bg-card", "px-4", "py-3");
      expect(within(card).getByRole("heading", { level: 2 })).toHaveTextContent("About BHP Group");

      // The enriched summary, clamped to three lines.
      const description = within(card).getByText(/world's largest listed miner/);
      expect(description.tagName).toBe("P");
      expect(description).toHaveClass("mt-1", "line-clamp-3", "text-sm", "text-foreground");
      expect(within(card).queryByText(/BHP Group is a resources company/)).not.toBeInTheDocument();

      expect(within(card).getByRole("link", { name: "Company profile →" })).toHaveAttribute(
        "href",
        "/shorts/BHP/company",
      );

      // The short-interest prose, in the card and without a card of its own.
      const prose = within(card).getByRole("region", { name: "BHP short interest summary" });
      expect(prose).not.toHaveAttribute("class");
      expect(prose).toHaveTextContent(
        "BHP Group (ASX:BHP) has 1.20% of its shares on issue reported as short positions in the latest ASIC report, or about 60,000,000 shares.",
      );
      expect(prose).toHaveTextContent(
        "Over the past 30 days that figure has risen 0.42 percentage points.",
      );
      expect(prose).toHaveTextContent("BHP is classified in the Materials industry.");

      const chips = within(card).getByTestId("theme-chips");
      expect(chips).toHaveAttribute("data-code", "BHP");
      expect(chips).toHaveClass("mt-3");
    });

    it("leaves the short-interest sentences that need a move out when the series has none", async () => {
      mockDeltas().mockResolvedValueOnce({
        change7d: null,
        change30d: null,
        change90d: null,
        peakPct: null,
        peakDate: null,
      });
      await renderOverview();
      const prose = within(aboutCard()).getByRole("region", { name: "BHP short interest summary" });
      expect(prose).toHaveTextContent("has 1.20% of its shares on issue");
      expect(prose).not.toHaveTextContent("Over the past");
    });

    it("falls back to the plain summary when there is no enriched one", async () => {
      mockDetails().mockResolvedValueOnce({
        companyName: "BHP GROUP LIMITED",
        enhancedSummary: "",
        summary: "BHP Group is a resources company.",
      });
      await renderOverview();
      expect(within(aboutCard()).getByText("BHP Group is a resources company.")).toHaveClass(
        "line-clamp-3",
      );
    });

    it.each([
      ["no summary of either kind", { enhancedSummary: "", summary: "" }],
      ["whitespace for a summary", { enhancedSummary: "  ", summary: "\n" }],
      ["no details at all", undefined],
      ["null details", null],
    ])("leaves the description out, and keeps the rest of the card, with %s", async (_name, details) => {
      mockDetails().mockResolvedValueOnce(details);
      await renderOverview();
      const card = aboutCard();
      expect(card.querySelector("p.line-clamp-3")).toBeNull();
      expect(within(card).getByRole("link", { name: "Company profile →" })).toBeInTheDocument();
      expect(
        within(card).getByRole("region", { name: "BHP short interest summary" }),
      ).toBeInTheDocument();
    });

    it("does not fail the render when the details read throws", async () => {
      mockDetails().mockRejectedValueOnce(new Error("details down"));
      await renderOverview();
      const card = aboutCard();
      expect(card.querySelector("p.line-clamp-3")).toBeNull();
      expect(within(card).getByRole("link", { name: "Company profile →" })).toBeInTheDocument();
    });

    it("moves the sign-in slot here from the layout, inside the gate and the slot's frame", async () => {
      const { container } = await renderOverview();
      const slot = container.querySelector(".login-slot") as HTMLElement;
      expect(slot).not.toBeNull();
      const gate = within(slot).getByTestId("signed-out-only");
      const frame = gate.firstElementChild as HTMLElement;
      expect(frame).toHaveClass("overflow-hidden", "rounded-lg", "border", "border-primary/20");
      expect(within(frame).getByTestId("login-banner")).toBeInTheDocument();
      // One banner on the page: the dossier teaser's gate is a different block.
      expect(screen.getAllByTestId("login-banner")).toHaveLength(1);
    });
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
    // The About card's two reads are started with the page's other reads, but
    // never inside the critical Promise.all: the details (cached, retried) are
    // caught into null, so a failure drops the description, not the page, and
    // the deltas reader returns all-nulls on its own.
    expect(critical).not.toContain("getStockDetails");
    expect(critical).not.toContain("getShortInterestDeltas");
    expect(source).toMatch(/getStockDetails\(stockCode\)\.catch\(/);
    expect(source).toContain("getShortInterestDeltas(stockCode)");
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
