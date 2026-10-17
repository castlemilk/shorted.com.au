/// <reference types="jest" />
/**
 * The stubs the stock Overview's page tests share (page-old-api.test.tsx and
 * page-overview.test.tsx). Both render the real app/shorts/[stockCode]/page.tsx
 * and stub whatever it reads or composes that the test is not about.
 *
 * Not here, because the two files want different things: the chart island
 * (next/dynamic), the short-interest summary and its reader, the company
 * details read, the theme chips, and the sign-in gate and banner. The old-API
 * test stubs those as nothing; the Overview test uses the real summary and
 * stand-ins that show what the page handed them.
 *
 * Import this module FIRST, before ../page and before anything that loads
 * protobuf: it polyfills TextEncoder (the generated code needs it at import
 * time), and its jest.mock calls must be registered before the page is first
 * required.
 */

import { TextEncoder, TextDecoder } from "util";

if (!globalThis.TextEncoder) {
  globalThis.TextEncoder = TextEncoder;
}
if (!globalThis.TextDecoder) {
  // @ts-expect-error - TextDecoder type on Node differs from DOM lib
  globalThis.TextDecoder = TextDecoder;
}

// The connect client every action builds. Only the three rpcs the tests script
// exist on it.
export const mockGetStockFundamentals = jest.fn();
export const mockGetStockStrategyFit = jest.fn();
export const mockListStrategies = jest.fn();

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
jest.mock("~/@/components/seo/breadcrumbs", () => ({
  Breadcrumbs: () => null,
  BreadcrumbStructuredData: () => null,
}));
jest.mock("~/@/components/seo/llm-meta", () => ({
  LLMMeta: () => null,
  // A mock, so a test can read the industry the page hands it.
  StockLLMMeta: jest.fn(() => null),
}));
jest.mock("~/@/components/seo/related-stocks", () => ({ RelatedStocks: () => null }));
jest.mock("~/@/components/reports/latest-weekly-report-link", () => ({
  LatestWeeklyReportLink: () => null,
}));
jest.mock("~/@/components/economy/stock-state-exposure", () => ({
  StockStateExposure: () => null,
}));
