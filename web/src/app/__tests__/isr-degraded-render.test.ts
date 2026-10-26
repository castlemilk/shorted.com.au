/**
 * ISR caches whatever a regeneration renders, for the route's revalidate.
 *
 * A page that answers a failed read with an ordinary-looking render (a 404,
 * an empty list, the ticker where the company name goes) costs one response
 * while it renders per request. Under ISR that render replaces the cached page
 * for everyone. Next 14.2.13 stores a notFound() render like any other page,
 * with the route's revalidate (server/base-server.js), and when a regeneration
 * THROWS it re-sets the previous entry instead (server/response-cache).
 *
 * So an on-demand ISR page must answer a failed read in one of two ways. It can
 * fail the render, so the last good page stays (loadStockOrFail, used by
 * /compare). Or it can cap the render's lifetime with bailOnEmptyRender, so the
 * fallback stays a minute (/scans/[slug]).
 *
 * The actions return undefined (or null) for a failed read. That is the
 * withRetryAndNotFound contract, and getEditorialTake and getStock return it
 * for NotFound and for a dead backend alike, which is why these pages read
 * through their withRetryAndThrowNotFound siblings (NotFound throws
 * NotFoundError, undefined is only a failure). Each case makes one read come
 * back that way, renders the page and checks what a regeneration would cache.
 * isr-static-params.test.ts checks the other half: that the pages which can
 * be ISR are.
 */

import * as comparePage from "../compare/[pair]/page";
import * as insiderPage from "../insider-trading/[stockCode]/page";
import * as newsPage from "../news/[slug]/page";
import * as ownershipPage from "../ownership/[slug]/page";
import * as scanPage from "../scans/[slug]/page";

const getStock = jest.fn();
const getStockOrNotFound = jest.fn();
const getDirectorTrades = jest.fn();
const getEditorialTakeOrNotFound = jest.fn();
const getScanResults = jest.fn();
const getInstitutionOrNotFound = jest.fn();
const bailOnEmptyRender = jest.fn();

const NOT_FOUND = "NEXT_NOT_FOUND";

jest.mock("next/navigation", () => ({
  notFound: () => {
    throw new Error("NEXT_NOT_FOUND");
  },
  redirect: (to: string) => {
    throw new Error(`NEXT_REDIRECT ${to}`);
  },
}));
jest.mock("~/app/actions/config", () => ({
  ...jest.requireActual<Record<string, unknown>>("~/app/actions/config"),
  bailOnEmptyRender: (...args: unknown[]) => bailOnEmptyRender(...args),
}));
jest.mock("~/app/actions/getStock", () => ({
  getStock: (...args: unknown[]) => getStock(...args),
  getStockOrNotFound: (...args: unknown[]) => getStockOrNotFound(...args),
}));
jest.mock("~/app/actions/getDirectorTrades", () => ({
  getDirectorTrades: (...args: unknown[]) => getDirectorTrades(...args),
}));
// As for getOwnership below: a take page that went back to getEditorialTake
// (undefined for NotFound and for a failure alike) fails its case here.
jest.mock("~/app/actions/getEditorialTake", () => ({
  getEditorialTake: (...args: unknown[]) => getEditorialTakeOrNotFound(...args),
  getEditorialTakeOrNotFound: (...args: unknown[]) => getEditorialTakeOrNotFound(...args),
}));
jest.mock("~/app/actions/getScanResults", () => ({
  getScanResults: (...args: unknown[]) => getScanResults(...args),
}));
// Both reads answer alike, so a page that went back to getInstitution (which
// returns undefined for NotFound and for a failure) fails its case here rather
// than throwing for a missing mock.
jest.mock("~/app/actions/getOwnership", () => ({
  getInstitution: (...args: unknown[]) => getInstitutionOrNotFound(...args),
  getInstitutionOrNotFound: (...args: unknown[]) => getInstitutionOrNotFound(...args),
}));
// The pages are called, not rendered, so their components never run; these
// keep the imports out of jsdom.
jest.mock("~/@/components/layouts/dashboard-layout", () => ({ DashboardLayout: () => null }));
jest.mock("~/@/components/seo/breadcrumbs", () => ({
  Breadcrumbs: () => null,
  BreadcrumbStructuredData: () => null,
}));
jest.mock("~/@/components/seo/llm-meta", () => ({ LLMMeta: () => null }));
jest.mock("~/@/components/seo/enhanced-structured-data", () => ({
  BreadcrumbListSchema: () => null,
  DatasetStructuredData: () => null,
  ItemListStructuredData: () => null,
}));
jest.mock("~/@/components/shorts/short-interest-table", () => ({ ShortInterestTable: () => null }));
jest.mock("~/@/components/news/article-header", () => ({ ArticleHeader: () => null }));
jest.mock("~/@/components/news/editorial-markdown", () => ({ EditorialMarkdown: () => null }));
jest.mock("~/@/components/news/take-related", () => ({ TakeRelated: () => null }));
jest.mock("~/@/components/news/take-body", () => ({ TakeBody: () => null }));
jest.mock("~/@/components/news/mdx-take-body", () => ({ MdxTakeBody: () => null }));

/**
 * Pages kept per request because ISR would cache their degraded render. Each
 * must still degrade that way (checked below), so the list can only shrink:
 * once a page fails or caps the render, give it on-demand ISR (an empty
 * generateStaticParams with dynamicParams = true), then delete its line here
 * and its ALLOWED line in isr-static-params.test.ts.
 */
const PER_REQUEST: Record<string, string> = {};

const STOCKS: Record<string, { name: string; industry: string; percentageShorted: number; reportedShortPositions: number }> = {
  BHP: { name: "BHP Group", industry: "Materials", percentageShorted: 0.4, reportedShortPositions: 20_000_000 },
  DRO: { name: "DroneShield", industry: "Capital Goods", percentageShorted: 9.42, reportedShortPositions: 80_000_000 },
  LOT: { name: "Lotus Resources", industry: "Energy", percentageShorted: 7.1, reportedShortPositions: 150_000_000 },
};

const TRADE = {
  id: "t1",
  stockCode: "BHP",
  directorName: "A Director",
  tradeType: "buy",
  sharesTraded: 1_000,
  pricePerShare: 40,
  totalValue: 40_000,
  tradeDate: "2026-10-01",
};

const TAKE = {
  slug: "dro-shorts",
  headline: "Short sellers pile into DroneShield",
  bodyMd: "Short interest in DRO doubled in a month.\n\nMore detail.",
  bodyFormat: "markdown",
  stockCode: "DRO",
  publishedAt: { seconds: BigInt(1_760_918_400) },
  citations: [],
  inlineImages: [],
  layoutImages: [],
};

const INSTITUTION = {
  institution: {
    slug: "vanguard",
    name: "Vanguard Group",
    kind: "index_manager",
    description: "",
    website: "",
    substantialPositions: 1,
    notices: 1,
    latestNoticeDate: "2026-10-16",
    hasAum: false,
    hasFundsSize: false,
  },
  positions: [],
  fundHoldings: [],
  funds: [],
  notices: [],
};

interface Case {
  page: string;
  /** The page module, for its route-segment exports. */
  route: object;
  read: string;
  /** Make the read come back the way a failed read does. */
  fail: () => void;
  render: () => Promise<unknown>;
}

const CASES: Case[] = [
  {
    page: "compare/[pair]/page.tsx",
    route: comparePage,
    read: "one side's stock",
    fail: () =>
      getStockOrNotFound.mockImplementation(async (code: string) =>
        code === "LOT" ? undefined : STOCKS[code],
      ),
    render: () => comparePage.default({ params: Promise.resolve({ pair: "DRO-vs-LOT" }) }),
  },
  {
    page: "scans/[slug]/page.tsx",
    route: scanPage,
    read: "the scan results",
    fail: () => getScanResults.mockResolvedValue(null),
    render: () => scanPage.default({ params: Promise.resolve({ slug: "short-interest-rising" }) }),
  },
  {
    // It used to read through getEditorialTake (withRetryAndNotFound), so a
    // dead backend was a 404 and a noindex "Take not found" title.
    page: "news/[slug]/page.tsx",
    route: newsPage,
    read: "the take",
    fail: () => getEditorialTakeOrNotFound.mockResolvedValue(undefined),
    render: () => newsPage.default({ params: Promise.resolve({ slug: TAKE.slug }) }),
  },
  {
    // It used to render "No director trades recorded" with zero totals, and
    // (next case) the ticker as the company name for a failed stock read.
    page: "insider-trading/[stockCode]/page.tsx",
    route: insiderPage,
    read: "the director trades",
    fail: () => getDirectorTrades.mockResolvedValue(undefined),
    render: () => insiderPage.default({ params: Promise.resolve({ stockCode: "BHP" }) }),
  },
  {
    page: "insider-trading/[stockCode]/page.tsx",
    route: insiderPage,
    read: "the stock",
    fail: () => getStockOrNotFound.mockResolvedValue(undefined),
    render: () => insiderPage.default({ params: Promise.resolve({ stockCode: "BHP" }) }),
  },
  {
    // It used to read through getInstitution (withRetryAndNotFound), so a dead
    // backend was a 404 for the hour.
    page: "ownership/[slug]/page.tsx",
    route: ownershipPage,
    read: "the institution",
    fail: () => getInstitutionOrNotFound.mockResolvedValue(undefined),
    render: () => ownershipPage.default({ params: Promise.resolve({ slug: "vanguard" }) }),
  },
];

/** A dynamic page is statically optimised when it exports generateStaticParams. */
const isOnDemandIsr = (route: object): boolean =>
  typeof (route as { generateStaticParams?: unknown }).generateStaticParams === "function";

const DEGRADED_FOR_THE_REVALIDATE = "the degraded page, for the whole revalidate";

/** What a regeneration that ran this render would leave in the route cache. */
async function whatIsCached(render: () => Promise<unknown>): Promise<string> {
  bailOnEmptyRender.mockClear();
  try {
    await render();
  } catch (err) {
    // notFound() is control flow, not a failure: the 404 is cached.
    if (!(err instanceof Error && err.message === NOT_FOUND)) return "nothing: the render fails";
  }
  return bailOnEmptyRender.mock.calls.length > 0
    ? "the degraded page, for a minute"
    : DEGRADED_FOR_THE_REVALIDATE;
}

describe("a failed read in a dynamic page that ISR could cache", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    jest.spyOn(console, "error").mockImplementation(() => undefined);
    getStock.mockImplementation(async (code: string) => STOCKS[code]);
    getStockOrNotFound.mockImplementation(async (code: string) => STOCKS[code]);
    getDirectorTrades.mockResolvedValue({ trades: [TRADE], totalCount: 1 });
    getEditorialTakeOrNotFound.mockResolvedValue({ take: TAKE });
    getScanResults.mockResolvedValue({ asOfDate: "2026-10-15", rows: [], totalCount: 0 });
    getInstitutionOrNotFound.mockResolvedValue(INSTITUTION);
  });
  afterEach(() => jest.restoreAllMocks());

  describe.each(CASES)("$page, when $read cannot be read", ({ page, route, fail, render }) => {
    // Without this a broken harness would pass as "the render fails".
    it("renders the healthy page without capping it", async () => {
      await expect(render()).resolves.toBeTruthy();
      expect(bailOnEmptyRender).not.toHaveBeenCalled();
    });

    if (page in PER_REQUEST) {
      it("still caches the degraded page, so it stays per request", async () => {
        fail();
        expect(await whatIsCached(render)).toBe(DEGRADED_FOR_THE_REVALIDATE);
        expect(isOnDemandIsr(route)).toBe(false);
      });
    } else {
      it("is on-demand ISR and fails or caps the degraded render", async () => {
        fail();
        expect(isOnDemandIsr(route)).toBe(true);
        expect(await whatIsCached(render)).not.toBe(DEGRADED_FOR_THE_REVALIDATE);
      });
    }
  });

  it("lists only pages it checks", () => {
    const checked = new Set(CASES.map(({ page }) => page));
    expect(Object.keys(PER_REQUEST).filter((page) => !checked.has(page))).toEqual([]);
  });
});
