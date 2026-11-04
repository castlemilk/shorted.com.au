/// <reference types="jest" />

/**
 * Structural guard for the sitemap index restructure (August 2026).
 *
 * /sitemap.xml is a sitemapindex over the SITEMAP_CHILDREN. The invariants
 * that matter, and that no runtime check can recover from once broken, are:
 *
 *  1. every child produces URLs (an empty child is a silently vanished section)
 *  2. no URL appears in TWO children (duplicate <loc> across a sitemap set)
 *  3. the union still covers every section the old flat sitemap covered
 *  4. lastmod is never one shared constant sprayed across the document
 */

const stockFixture = Array.from({ length: 60 }, (_, i) => ({
  productCode: `S${i.toString().padStart(3, "0")}`.slice(0, 4),
  name: `Company ${i}`,
  industry: "Materials",
  latestShortPosition: 1 + i / 100,
}));

const marketDatesFixture = ["2026-08-13", "2026-08-12", "2026-08-11"];

jest.mock("@connectrpc/connect-web", () => ({
  createConnectTransport: () => ({}),
}));

jest.mock("~/gen/shorts/v1alpha1/housing_pb", () => ({ HousingService: { typeName: "housing" } }));
jest.mock("~/gen/shorts/v1alpha1/market_pb", () => ({ MarketService: { typeName: "market" } }));
jest.mock("~/gen/shorts/v1alpha1/news_pb", () => ({ NewsService: { typeName: "news" } }));

jest.mock("@connectrpc/connect", () => ({
  createClient: () => ({
    getAvailableDates: async () => ({ dates: marketDatesFixture }),
    listEditorialTakes: async () => ({
      takes: [
        { slug: "take-one", publishedAt: { seconds: BigInt(1_750_000_000) } },
        { slug: "take-two", publishedAt: { seconds: BigInt(1_752_000_000) } },
      ],
    }),
    listCouncils: async ({ stateCode }: { stateCode: string }) => ({
      councils: stateCode === "ACT"
        ? [{ slug: "unincorporated-act", kind: "unincorporated", dataThrough: "2026-07-31" }]
        : [
            { slug: `${stateCode.toLowerCase()}-city`, kind: "council", dataThrough: "2026-06-30" },
            { slug: `${stateCode.toLowerCase()}-shire`, kind: "council", dataThrough: "" },
            // Pseudo areas have no page and must never be advertised.
            { slug: "no-usual-address", kind: "pseudo", dataThrough: "2026-06-30" },
          ],
    }),
    getPriceDropsOverview: async () => ({
      asOf: { seconds: BigInt(1_757_901_600), nanos: 0 },
    }),
    listStateSuburbs: async ({ stateCode }: { stateCode: string }) => ({
      suburbs: Array.from({ length: 5 }, (_, i) => ({
        salCode: `${stateCode}${i}`,
        salName: `Suburb ${stateCode} ${i}`,
        postcode: `${2000 + i}`,
        // Half priced, half unpriced, exercises both lastmod branches.
        latestMedianPrice: i % 2 === 0 ? 1_000_000 : 0,
        population: 5_000,
        latestPeriod:
          i % 2 === 0 ? { seconds: BigInt(1_748_000_000 + i * 86_400) } : undefined,
      })),
    }),
  }),
}));

jest.mock("~/app/actions/config", () => {
  const serverFetch = async (input: string) => {
    const url = String(input);
    if (url.includes("GetTopShorts")) {
      return {
        ok: true,
        status: 200,
        json: async () => ({ timeSeries: stockFixture }),
      };
    }
    if (url.includes("GetIndustryTreeMap")) {
      return {
        ok: true,
        status: 200,
        json: async () => ({
          stocks: [{ industry: "Materials" }, { industry: "Energy" }, { industry: "" }],
        }),
      };
    }
    return { ok: false, status: 404, json: async () => ({}) };
  };
  return {
    skipForBuild: () => false,
    getServerShortsApiUrl: () => "https://api.example.test",
    buildApiUrl: (base: string, path: string) => `${base}${path}`,
    serverFetchWithUserAgent: serverFetch,
    // The sitemap's plain-JSON reads go through sharedRead and this fetch.
    serverFetchOutsideNextCache: serverFetch,
  };
});

// sharedRead is pass-through here: this file tests the sitemap's content. The
// shared entry has its own tests (shared-read.test.ts).
jest.mock("~/app/actions/shared-read", () => ({
  sharedRead: (
    _keyParts: unknown,
    _revalidate: unknown,
    read: () => Promise<unknown>,
  ) => read(),
}));

jest.mock("~/app/actions/reports/getReportData", () => ({
  getReportsList: async (type: string) => {
    if (type === "weekly") return [{ slug: "2026-W25" }, { slug: "2026-W24" }];
    if (type === "monthly") return [{ slug: "2026-06" }];
    return [{ slug: "2025" }];
  },
}));

jest.mock("~/app/actions/getPoliticians", () => ({
  getPoliticianSlugs: async () => [
    { slug: "jane-citizen", hasInterests: true },
    { slug: "john-citizen", hasInterests: true },
    { slug: "no-interests", hasInterests: false },
  ],
}));

// ListInstitutions' order (current stakes, most first) and its fields: the
// stake count and the newest notice, never the holdings files.
const institutionsFixture = [
  { slug: "vanguard", name: "Vanguard", substantialPositions: 88, latestNoticeDate: "2026-10-16" },
  { slug: "argo", name: "Argo Investments", substantialPositions: 1, latestNoticeDate: "" },
  // Holdings files only: the page indexes it, ListInstitutions cannot say so.
  { slug: "hesta", name: "HESTA", substantialPositions: 0, latestNoticeDate: "" },
  // Every stake ceased: an empty page, noindexed.
  { slug: "ophir", name: "Ophir Asset Management", substantialPositions: 0, latestNoticeDate: "2025-03-02" },
];
const getOwnershipOverview = jest.fn();
const listInstitutions = jest.fn();
const getInstitution = jest.fn();
const getStockOwnership = jest.fn();
jest.mock("~/app/actions/getOwnership", () => ({
  getOwnershipOverview: () => getOwnershipOverview(),
  listInstitutions: (...args: unknown[]) => listInstitutions(...args),
  getInstitution: (slug: string) => getInstitution(slug),
  // The institution page reads through the NotFound-aware twin.
  getInstitutionOrNotFound: (slug: string) => getInstitution(slug),
  // The register page's metadata reads through the same call its page does.
  getStockOwnership: (code: string) => getStockOwnership(code),
}));
// The register list, read a page at a time, as the sitemap reads it.
const loadStockRegisters = jest.fn();
jest.mock("~/app/actions/ownershipExplorer", () => ({
  loadStockRegisters: (...args: unknown[]) => loadStockRegisters(...args),
}));
// The fund list, read once, as the sitemap reads it: the key, the file date and the holdings.
const fundsFixture = [
  { key: "asx:VAS", ticker: "VAS", name: "Vanguard Australian Shares Index ETF", asAt: "2026-10-20", holdings: 300 },
  {
    key: "vanguard/Vanguard Australian Shares Index Fund",
    ticker: "VAN",
    name: "Vanguard Australian Shares Index Fund",
    asAt: "2026-09-30",
    holdings: 290,
  },
];
const loadFunds = jest.fn();
jest.mock("~/app/actions/ownershipFunds", () => ({
  loadFunds: (...args: unknown[]) => loadFunds(...args),
}));
// The institution page's metadata is read below; its layout never renders.
jest.mock("~/@/components/layouts/dashboard-layout", () => ({ DashboardLayout: () => null }));

// The register list's rows, as the action maps them: the sitemap reads the code,
// the interests (a count, as text) and the newest notice. `holders` is the count the
// register page's own summary reports for the stock. The list does not carry it, so
// the strict-subset check below feeds the page that count, not the interests.
const registerRowsFixture = [
  { code: "BHP", interests: "3", holders: "3", latestNotice: "2026-10-16" },
  { code: "PLS", interests: "1", holders: "1", latestNotice: "" },
  // Every holder ceased: no current holder, so no page is listed.
  { code: "GONE", interests: "0", holders: "0", latestNotice: "2025-03-02" },
  // A code the register route does not accept.
  { code: "A-B", interests: "2", holders: "2", latestNotice: "2026-10-01" },
];
// One page of the list, as the action answers it for a query.
const pageOf = (rows: Array<Record<string, string>>, { limit = 50, offset = 0 }: { limit?: number; offset?: number }) => ({
  ok: true,
  rows: rows.slice(offset, offset + limit),
  asOf: "2026-10-20",
});
// The institution pages only: /ownership/<slug>, not the hub, the explorer's and the workspace's
// static pages (/ownership/notices, /ownership/stocks, /ownership/map, ...), a register
// (/ownership/stocks/<code>) or a fund (/ownership/funds/<key>).
const isInstitutionUrl = (url: string) =>
  /\/ownership\/[^/]+$/.test(url) &&
  !/\/ownership\/(notices|stocks|map|connections|activity|funds|holders|changes)$/.test(url);
beforeEach(() => {
  getOwnershipOverview.mockResolvedValue({ asOf: "2026-10-20", noticesParsed: 6367 });
  listInstitutions.mockResolvedValue({ institutions: institutionsFixture, total: institutionsFixture.length });
  loadStockRegisters.mockImplementation(async (query) => pageOf(registerRowsFixture, query));
  loadFunds.mockResolvedValue({ ok: true, error: "", funds: fundsFixture });
});

jest.mock("~/lib/openapi/parser", () => ({
  parseOpenAPISpec: async () => ({
    info: { title: "t", version: "1" },
    endpoints: [{ id: "get-top-shorts" }, { id: "get-stock-data" }],
    groups: [],
    components: { schemas: {} },
  }),
}));

jest.mock("~/@/lib/api", () => ({
  getAllPosts: () => [
    { slug: "post-one", date: "2026-05-01T00:00:00.000Z", category: "guides" },
    {
      slug: "post-two",
      date: "2026-06-01T00:00:00.000Z",
      updated: "2026-07-15T00:00:00.000Z",
      category: "guides",
    },
    { slug: "post-three", date: "2026-04-01T00:00:00.000Z", category: "housing" },
  ],
}));

import {
  buildCoreSitemap,
  buildHousingSitemap,
  buildOwnershipSitemap,
  buildPoliticiansSitemap,
  buildReportsSitemap,
  buildShortsSitemap,
} from "../sitemap-sections";
import { generateMetadata as institutionMetadata } from "~/app/ownership/[slug]/page";
import { generateMetadata as registerMetadata } from "~/app/ownership/stocks/[code]/page";
import {
  SITEMAP_CHILDREN,
  dedupeEntries,
  renderSitemapIndex,
  renderUrlset,
} from "../sitemap-xml";
import { THEME_SLUGS } from "~/@/lib/themes/registry";
import { STRATEGY_SLUGS } from "~/@/lib/strategies/registry";
import {
  HOUSING_RANKINGS,
  HOUSING_RANKING_SLUGS,
} from "~/@/lib/housing-rankings/registry";
import { CAPITALS, CAPITAL_SLUGS } from "~/@/lib/housing/capitals";
import { PUBLISHED_ECONOMY_TOPIC_PAIRS } from "~/@/lib/economy/topics";
import { STOCK_TABS } from "~/@/lib/stocks/stock-tabs";

type Section = { name: string; entries: Awaited<ReturnType<typeof buildCoreSitemap>> };

async function buildAll(): Promise<Section[]> {
  const [core, shorts, reports, housing, politicians, ownership] = await Promise.all([
    buildCoreSitemap(),
    buildShortsSitemap(),
    buildReportsSitemap(),
    buildHousingSitemap(),
    buildPoliticiansSitemap(),
    buildOwnershipSitemap(),
  ]);
  return [
    { name: "sitemap-core.xml", entries: core },
    { name: "sitemap-shorts.xml", entries: shorts },
    { name: "sitemap-reports.xml", entries: reports },
    { name: "sitemap-housing.xml", entries: housing },
    { name: "sitemap-politicians.xml", entries: politicians },
    { name: "sitemap-ownership.xml", entries: ownership },
  ];
}

describe("sitemap children", () => {
  it("has one builder per child listed in the index", async () => {
    const sections = await buildAll();
    expect(sections.map((s) => s.name)).toEqual([...SITEMAP_CHILDREN]);
  });

  it("never emits an empty child", async () => {
    for (const section of await buildAll()) {
      expect(section.entries.length).toBeGreaterThan(0);
    }
  });

  it("never lists the same URL in two children", async () => {
    // Within a document, renderUrlset dedupes (the glossary term list has a
    // repeated slug). ACROSS documents there is no safety net, so assert it.
    const seen = new Map<string, string>();
    const duplicates: string[] = [];
    for (const section of await buildAll()) {
      for (const entry of dedupeEntries(section.entries)) {
        const prior = seen.get(entry.url);
        if (prior) duplicates.push(`${entry.url} (${prior} + ${section.name})`);
        else seen.set(entry.url, section.name);
      }
    }
    expect(duplicates).toEqual([]);
  });

  it("covers every section of the old flat sitemap, each in exactly one child", async () => {
    const sections = await buildAll();
    const where = (needle: string): string[] =>
      sections
        .filter((s) => s.entries.some((e) => e.url.includes(needle)))
        .map((s) => s.name);

    // [prefix, expected child]
    const expectations: Array<[string, string]> = [
      ["/about", "sitemap-core.xml"],
      ["/learn/", "sitemap-core.xml"],
      ["/blog/", "sitemap-core.xml"],
      ["/glossary/", "sitemap-core.xml"],
      ["/authors/", "sitemap-core.xml"],
      ["/scans/", "sitemap-core.xml"],
      ["/themes/", "sitemap-core.xml"],
      ["/strategies/", "sitemap-core.xml"],
      ["/directory/", "sitemap-core.xml"],
      ["/market/", "sitemap-core.xml"],
      ["/industry/", "sitemap-core.xml"],
      ["/economy/", "sitemap-core.xml"],
      ["/docs/api/", "sitemap-core.xml"],
      ["/news/", "sitemap-core.xml"],
      ["/shorts/", "sitemap-shorts.xml"],
      ["/insider-trading/", "sitemap-shorts.xml"],
      ["/compare/", "sitemap-shorts.xml"],
      ["/reports/", "sitemap-reports.xml"],
      ["/housing/", "sitemap-housing.xml"],
      ["/price-drops", "sitemap-housing.xml"],
      ["/politicians/", "sitemap-politicians.xml"],
      ["/ownership", "sitemap-ownership.xml"],
    ];

    for (const [needle, child] of expectations) {
      expect({ needle, in: where(needle) }).toEqual({ needle, in: [child] });
    }
  });

  // The theme URLs come from the registry, so a new theme reaches the sitemap
  // without anyone remembering to hand-edit a list.
  it("dates the blog hub and each category hub from their newest post, honouring revisions", async () => {
    const core = await buildCoreSitemap();
    const lastmod = (path: string) =>
      core.find((e) => e.url === `https://shorted.com.au${path}`)?.lastModified;

    // A revision moves the post, its shelf and the hub forward together.
    expect(lastmod("/blog/post-two")).toBe("2026-07-15T00:00:00.000Z");
    expect(lastmod("/blog/category/guides")).toBe("2026-07-15T00:00:00.000Z");
    expect(lastmod("/blog")).toBe("2026-07-15T00:00:00.000Z");
    expect(lastmod("/blog/category/housing")).toBe("2026-04-01T00:00:00.000Z");
    // Empty shelves are not advertised.
    expect(core.some((e) => e.url.endsWith("/blog/category/product"))).toBe(false);
    expect(core.some((e) => e.url.endsWith("/blog/category/analysis"))).toBe(false);
  });

  it("lists the themes hub and every registry theme, dated like the other ASIC pages", async () => {
    const core = await buildCoreSitemap();
    const hub = core.find((e) => e.url === "https://shorted.com.au/themes");
    expect(hub).toBeDefined();
    for (const slug of THEME_SLUGS) {
      const entry = core.find(
        (e) => e.url === `https://shorted.com.au/themes/${slug}`,
      );
      expect(entry).toBeDefined();
      expect(entry!.lastModified).toBe(hub!.lastModified);
    }
    // ASIC-derived, so it carries a real data date rather than no lastmod.
    expect(hub!.lastModified).toBeTruthy();
  });

  // Picks are driven by the daily price sweep, not the ASIC date this builder
  // fetches, so they carry no lastmod rather than a borrowed one.
  it("lists the stock picker hub and every registry strategy without a fabricated lastmod", async () => {
    const core = await buildCoreSitemap();
    const urls = [
      "/strategies",
      ...STRATEGY_SLUGS.map((slug) => `/strategies/${slug}`),
      "/strategies/changelog",
    ];
    for (const path of urls) {
      const entry = core.find((e) => e.url === `https://shorted.com.au${path}`);
      expect(entry).toBeDefined();
      expect(entry!.lastModified).toBeUndefined();
    }
  });

  it("lists every published economy topic pair in the core sitemap without a fabricated lastmod", async () => {
    const core = await buildCoreSitemap();
    const topicEntries = core.filter((entry) =>
      /\/economy\/[a-z]+\/[a-z-]+$/.test(entry.url),
    );

    expect(topicEntries).toHaveLength(PUBLISHED_ECONOMY_TOPIC_PAIRS.length);
    for (const pair of PUBLISHED_ECONOMY_TOPIC_PAIRS) {
      const entry = topicEntries.find(
        (candidate) =>
          candidate.url ===
          `https://shorted.com.au/economy/${pair.state}/${pair.topic}`,
      );
      expect(entry).toBeDefined();
      expect(entry!.lastModified).toBeUndefined();
    }
    expect(
      topicEntries.some((entry) => entry.url.endsWith("/economy/act/labour")),
    ).toBe(false);
    expect(
      topicEntries.some((entry) => entry.url.endsWith("/economy/nt/labour")),
    ).toBe(false);
  });

  it("drops the auth-gated /developer stub and lists the API docs index and client guides", async () => {
    const all = (await buildAll()).flatMap((s) => s.entries.map((e) => e.url));
    expect(all.filter((u) => u.endsWith("/developer"))).toEqual([]);
    expect(all).toContain("https://shorted.com.au/docs/api");
    expect(
      all.filter((u) => u.startsWith("https://shorted.com.au/docs/api/")).sort(),
    ).toEqual(
      ["curl", "go", "java", "javascript", "python", "typescript"].map(
        (language) => `https://shorted.com.au/docs/api/clients/${language}`,
      ),
    );
  });

  // The endpoint pages are thin per-RPC stubs that the docs sidebar links from
  // every docs page; the sitemap listed all 87 (two of them parser artefacts,
  // /docs/api/servers--feed.xml), SEO review 2026-10-21. The parser mock above
  // still serves endpoints, so listing them again fails here.
  it("lists no per-endpoint API reference page", async () => {
    const all = (await buildAll()).flatMap((s) => s.entries.map((e) => e.url));
    expect(all).not.toContain("https://shorted.com.au/docs/api/get-top-shorts");
    expect(all).not.toContain("https://shorted.com.au/docs/api/get-stock-data");
  });

  it("caps compare pairs at 80 and only pairs indexable codes", async () => {
    const shorts = await buildShortsSitemap();
    const pairs = shorts.filter((e) => e.url.includes("/compare/"));
    expect(pairs.length).toBe(80);
    for (const pair of pairs) {
      const slug = pair.url.split("/compare/")[1]!;
      const [a, b] = slug.split("-vs-");
      expect(a! < b!).toBe(true); // canonical ordering, never the redirecting form
      expect(stockFixture.some((s) => s.productCode === a)).toBe(true);
      expect(stockFixture.some((s) => s.productCode === b)).toBe(true);
    }
  });

  // The short-interest, financials and company tabs are indexable pages in
  // their own right, beside news. Strategy stays out (most stocks read "not a
  // candidate") and community is noindex, so neither is advertised.
  it("lists the indexable stock tabs for every qualified code, and never strategy or community", async () => {
    const shorts = (await buildAll()).find((s) => s.name === "sitemap-shorts.xml")!;
    const urls = shorts.entries.map((e) => e.url);
    for (const { productCode } of stockFixture) {
      for (const tab of ["short-interest", "financials", "company", "news"]) {
        expect(urls).toContain(`https://shorted.com.au/shorts/${productCode}/${tab}`);
      }
    }
    expect(urls.some((u) => /\/shorts\/[A-Z0-9]+\/strategy$/.test(u))).toBe(false);
    expect(urls.some((u) => /\/shorts\/[A-Z0-9]+\/community$/.test(u))).toBe(false);
  });

  // The segment strings are the registry's, not a copy kept here: rename one in
  // STOCK_TABS and the sitemap follows. (The route directory is the other half
  // of that change and has its own guards.) The registry is swapped for one
  // whose Financials tab lives at /results, in an isolated module registry so
  // the rest of this file keeps the real one.
  it("takes each listed tab's segment from the STOCK_TABS registry", async () => {
    const code = stockFixture[0]!.productCode;
    try {
      await jest.isolateModulesAsync(async () => {
        jest.doMock("~/@/lib/stocks/stock-tabs", () => {
          const actual = jest.requireActual<typeof import("~/@/lib/stocks/stock-tabs")>(
            "~/@/lib/stocks/stock-tabs",
          );
          return {
            ...actual,
            STOCK_TABS: actual.STOCK_TABS.map((tab) =>
              tab.id === "financials" ? { ...tab, segment: "results" } : tab,
            ),
          };
        });
        const { buildShortsSitemap: buildWithRenamedTab } = await import("../sitemap-sections");
        const urls = (await buildWithRenamedTab()).map((e) => e.url);
        expect(urls).toContain(`https://shorted.com.au/shorts/${code}/results`);
        expect(urls).not.toContain(`https://shorted.com.au/shorts/${code}/financials`);
        // The tabs that were not renamed are untouched, and the policy is
        // still per tab, not per segment string.
        expect(urls).toContain(`https://shorted.com.au/shorts/${code}/short-interest`);
        expect(urls).not.toContain(`https://shorted.com.au/shorts/${code}/strategy`);
      });
    } finally {
      jest.dontMock("~/@/lib/stocks/stock-tabs");
    }
  });

  // Every URL the sitemap emits under a stock is the stock itself, a registry
  // tab, or one of the stock's other families (insider-trading, compare): a
  // segment that is none of them is a hand-typed route that nothing guards.
  it("lists, for each qualified code, only the stock and registry tabs under /shorts/<code>", async () => {
    const shorts = await buildShortsSitemap();
    const registrySegments = new Set(STOCK_TABS.map((tab) => tab.segment).filter(Boolean));
    const underStock = shorts
      .map((e) => /^https:\/\/shorted\.com\.au\/shorts\/([A-Z0-9]+)(?:\/(.+))?$/.exec(e.url))
      .filter((m): m is RegExpExecArray => m !== null);
    expect(underStock.length).toBeGreaterThan(stockFixture.length);
    for (const [, , segment] of underStock) {
      if (segment !== undefined) expect(registrySegments.has(segment)).toBe(true);
    }
  });

  it("does not stamp one shared constant on every lastmod", async () => {
    const sections = await buildAll();
    const lastmods = sections
      .flatMap((s) => s.entries.map((e) => e.lastModified))
      .filter((v): v is string => Boolean(v));
    // Many distinct real dates: report slugs, blog dates, market snapshot
    // dates, take publish times, suburb price periods.
    expect(new Set(lastmods).size).toBeGreaterThan(8);

    // Static marketing pages omit lastmod rather than fabricate one.
    const core = sections.find((s) => s.name === "sitemap-core.xml")!;
    for (const path of ["/about", "/terms", "/privacy", "/faq", "/economy"]) {
      const entry = core.entries.find((e) => e.url.endsWith(path))!;
      expect(entry.lastModified).toBeUndefined();
    }

    // Reports derive lastmod from their slug, not from render time.
    const reports = await buildReportsSitemap();
    const yearly = reports.find((e) => e.url.endsWith("/reports/yearly/2025"))!;
    expect(yearly.lastModified).toBe("2026-01-01T00:00:00.000Z");
  });

  // The price-drops board used to carry no lastmod because no read path had a
  // data date. It now follows the view refresh the page's JSON-LD reports.
  it("dates /price-drops from the price-drops view refresh", async () => {
    const housing = await buildHousingSitemap();
    const drops = housing.find((e) => e.url === "https://shorted.com.au/price-drops");
    expect(drops?.lastModified).toBe(new Date(1_757_901_600 * 1000).toISOString());
  });

  it("gives priced suburbs their own period and leaves unpriced ones bare", async () => {
    const housing = await buildHousingSitemap();
    const suburbs = housing.filter((e) => /\/housing\/[a-z]+\/suburb-/.test(e.url));
    expect(suburbs.length).toBeGreaterThan(0);
    expect(suburbs.some((s) => Boolean(s.lastModified))).toBe(true);
    expect(suburbs.some((s) => !s.lastModified)).toBe(true);
  });

  it("lists the housing rankings hub and every registry slug in the housing sitemap", async () => {
    const housing = await buildHousingSitemap();
    const hub = housing.find(
      (entry) => entry.url === "https://shorted.com.au/housing/rankings",
    );
    const housingHub = housing.find(
      (entry) => entry.url === "https://shorted.com.au/housing",
    );
    expect(hub).toBeDefined();
    expect(hub!.lastModified).toBe(housingHub!.lastModified);

    for (const slug of HOUSING_RANKING_SLUGS) {
      const ranking = HOUSING_RANKINGS[slug]!;
      const entry = housing.find(
        (candidate) =>
          candidate.url === `https://shorted.com.au/housing/rankings/${slug}`,
      );
      const state = housing.find(
        (candidate) =>
          candidate.url ===
          `https://shorted.com.au/housing/${ranking.stateCode.toLowerCase()}`,
      );
      expect(entry).toBeDefined();
      expect(entry!.lastModified).toBe(state!.lastModified);
    }
  });

  it("lists every council page and a council index per state, dated from their data", async () => {
    const housing = await buildHousingSitemap();
    const byUrl = new Map(housing.map((e) => [e.url, e]));
    for (const st of ["nsw", "vic", "qld", "sa", "wa", "tas", "nt"]) {
      expect(byUrl.get(`https://shorted.com.au/housing/${st}/council`)?.lastModified).toBe("2026-06-30T00:00:00.000Z");
      expect(byUrl.get(`https://shorted.com.au/housing/${st}/council/${st}-city`)?.lastModified).toBe("2026-06-30T00:00:00.000Z");
      // No data date: listed, but with no invented lastmod.
      expect(byUrl.has(`https://shorted.com.au/housing/${st}/council/${st}-shire`)).toBe(true);
      expect(byUrl.get(`https://shorted.com.au/housing/${st}/council/${st}-shire`)?.lastModified).toBeUndefined();
    }
    expect(byUrl.has("https://shorted.com.au/housing/act/council/unincorporated-act")).toBe(true);
    expect(housing.some((e) => e.url.endsWith("/council/no-usual-address"))).toBe(false);
  });

  // The institution pages were linked 145 times from /ownership and listed in
  // no sitemap, and the empty ones were indexable (SEO review F09).
  it("lists only the institution pages the page itself indexes, dated by their newest notice", async () => {
    const ownership = await buildOwnershipSitemap();
    const listed = ownership.filter((e) => isInstitutionUrl(e.url));
    expect(listed.map((e) => e.url)).toEqual([
      "https://shorted.com.au/ownership/vanguard",
      "https://shorted.com.au/ownership/argo",
    ]);
    expect(listed[0]!.lastModified).toBe("2026-10-16T00:00:00.000Z");
    // No notice date: listed, with no invented lastmod.
    expect(listed[1]!.lastModified).toBeUndefined();
    expect(listInstitutions).toHaveBeenCalledWith("", "", 200, 0);
  });

  // Strict subset, asked of the page itself rather than of the predicate the
  // builder already applied: each listed slug's own metadata sets no robots
  // key when GetInstitution returns only what ListInstitutions showed the
  // sitemap (its stakes) and no holdings files at all.
  it("lists no institution page that the page's own metadata noindexes", async () => {
    const listed = (await buildOwnershipSitemap()).filter((e) => isInstitutionUrl(e.url));
    expect(listed).toHaveLength(2);
    for (const entry of listed) {
      const inst = institutionsFixture.find((i) => entry.url.endsWith(`/ownership/${i.slug}`))!;
      getInstitution.mockResolvedValue({
        institution: { ...inst, kind: "index_manager", notices: 0 },
        positions: Array.from({ length: inst.substantialPositions }, (_, n) => ({ stockCode: `S${n}` })),
        fundHoldings: [],
        notices: [],
        funds: [],
      });
      const meta = await institutionMetadata({ params: Promise.resolve({ slug: inst.slug }) });
      expect(meta.alternates?.canonical).toBe(entry.url);
      expect(Object.keys(meta)).not.toContain("robots");
    }
  });

  it("dates /ownership from the ownership data's asOf, not the ASIC date, and only in its own child", async () => {
    const [ownership, core] = await Promise.all([buildOwnershipSitemap(), buildCoreSitemap()]);
    expect(ownership[0]).toEqual({ url: "https://shorted.com.au/ownership", lastModified: "2026-10-20T00:00:00.000Z" });
    expect(core.some((e) => e.url === "https://shorted.com.au/ownership")).toBe(false);
  });

  it("keeps /ownership and the explorer pages listed, with no lastmod, while the ownership reads fail", async () => {
    getOwnershipOverview.mockResolvedValue(undefined);
    listInstitutions.mockResolvedValue(undefined);
    loadStockRegisters.mockResolvedValue({ ok: false, rows: [], asOf: "" });
    const logged = jest.spyOn(console, "error").mockImplementation(() => undefined);
    expect(await buildOwnershipSitemap()).toEqual([
      { url: "https://shorted.com.au/ownership" },
      { url: "https://shorted.com.au/ownership/notices" },
      { url: "https://shorted.com.au/ownership/stocks" },
      { url: "https://shorted.com.au/ownership/map" },
      { url: "https://shorted.com.au/ownership/connections" },
      { url: "https://shorted.com.au/ownership/activity" },
      { url: "https://shorted.com.au/ownership/funds" },
      { url: "https://shorted.com.au/ownership/holders" },
      { url: "https://shorted.com.au/ownership/changes" },
      // The fund list answers, so the funds are listed, each with its own file date.
      { url: "https://shorted.com.au/ownership/funds/asx%3AVAS", lastModified: "2026-10-20T00:00:00.000Z" },
      {
        url: "https://shorted.com.au/ownership/funds/vanguard%2FVanguard%20Australian%20Shares%20Index%20Fund",
        lastModified: "2026-09-30T00:00:00.000Z",
      },
    ]);
    expect(logged).toHaveBeenCalledWith("Failed to fetch the register list for sitemap: a page was not answered.");
    logged.mockRestore();
  });

  it("lists every explorer and workspace page, and each tracked fund at its own file date", async () => {
    loadFunds.mockClear();
    const ownership = await buildOwnershipSitemap();
    const urls = ownership.map((e) => e.url);
    for (const path of ["notices", "stocks", "map", "connections", "activity", "funds", "holders", "changes"]) {
      expect(urls).toContain(`https://shorted.com.au/ownership/${path}`);
    }
    const funds = ownership.filter((e) => e.url.startsWith("https://shorted.com.au/ownership/funds/"));
    expect(funds).toEqual([
      {
        url: "https://shorted.com.au/ownership/funds/asx%3AVAS",
        lastModified: "2026-10-20T00:00:00.000Z",
      },
      {
        url: "https://shorted.com.au/ownership/funds/vanguard%2FVanguard%20Australian%20Shares%20Index%20Fund",
        lastModified: "2026-09-30T00:00:00.000Z",
      },
    ]);
    // Only the list is read for the fund pages, never a portfolio per fund.
    expect(loadFunds).toHaveBeenCalledTimes(1);
  });

  it("drops the fund pages, and keeps the rest, while the fund list is not answered", async () => {
    loadFunds.mockResolvedValue({ ok: false, error: "", funds: [] });
    const logged = jest.spyOn(console, "error").mockImplementation(() => undefined);
    const ownership = await buildOwnershipSitemap();
    expect(ownership.some((e) => e.url.includes("/ownership/funds/asx"))).toBe(false);
    expect(ownership.map((e) => e.url)).toContain("https://shorted.com.au/ownership/map");
    expect(logged).toHaveBeenCalledWith("Failed to fetch the fund list for sitemap: the list was not answered.");
    logged.mockRestore();
  });

  it("dates the explorer pages by the newest notice read, as the hub is", async () => {
    const explorer = (await buildOwnershipSitemap()).filter((e) => /\/ownership\/(notices|stocks)$/.test(e.url));
    expect(explorer).toEqual([
      { url: "https://shorted.com.au/ownership/notices", lastModified: "2026-10-20T00:00:00.000Z" },
      { url: "https://shorted.com.au/ownership/stocks", lastModified: "2026-10-20T00:00:00.000Z" },
    ]);
  });

  it("lists the register pages that hold a current holder, in the register's order, dated by their newest notice", async () => {
    const registers = (await buildOwnershipSitemap()).filter((e) =>
      e.url.startsWith("https://shorted.com.au/ownership/stocks/"),
    );
    expect(registers.map((e) => e.url)).toEqual([
      "https://shorted.com.au/ownership/stocks/BHP",
      "https://shorted.com.au/ownership/stocks/PLS",
    ]);
    expect(registers[0]!.lastModified).toBe("2026-10-16T00:00:00.000Z");
    // No notice date: listed, with no invented lastmod.
    expect(registers[1]!.lastModified).toBeUndefined();
    expect(loadStockRegisters).toHaveBeenCalledWith({ limit: 100, offset: 0 });
  });

  it("reads the register list a hundred at a time, and lists at most 1,000 register pages", async () => {
    const many = Array.from({ length: 1200 }, (_, i) => ({ code: `R${i}`, interests: "1", latestNotice: "" }));
    loadStockRegisters.mockClear();
    loadStockRegisters.mockImplementation(async (query) => pageOf(many, query));
    const registers = (await buildOwnershipSitemap()).filter((e) =>
      e.url.startsWith("https://shorted.com.au/ownership/stocks/"),
    );
    expect(registers).toHaveLength(1000);
    expect(loadStockRegisters).toHaveBeenCalledTimes(10);
  });

  // The ten reads are in flight together, so two of them can answer the same register:
  // it is listed once.
  it("lists a register once when two reads of the list answer it", async () => {
    loadStockRegisters.mockImplementation(async (query) => ({
      ok: true,
      rows: query.offset === 0 || query.offset === 100 ? registerRowsFixture.slice(0, 2) : [],
      asOf: "2026-10-20",
    }));
    const registers = (await buildOwnershipSitemap()).filter((e) =>
      e.url.startsWith("https://shorted.com.au/ownership/stocks/"),
    );
    expect(registers.map((e) => e.url)).toEqual([
      "https://shorted.com.au/ownership/stocks/BHP",
      "https://shorted.com.au/ownership/stocks/PLS",
    ]);
  });

  // A list that did not answer every page is not a list of the whole register: one
  // page the list did not answer drops every register page, and the institutions stay.
  it("drops the register pages, and keeps the institutions, when one page of the list is not answered", async () => {
    loadStockRegisters.mockImplementation(async (query) =>
      query.offset === 100 ? { ok: false, rows: [], asOf: "" } : pageOf(registerRowsFixture, query),
    );
    const logged = jest.spyOn(console, "error").mockImplementation(() => undefined);
    const ownership = await buildOwnershipSitemap();
    expect(ownership.some((e) => e.url.startsWith("https://shorted.com.au/ownership/stocks/"))).toBe(false);
    expect(ownership.map((e) => e.url)).toContain("https://shorted.com.au/ownership/vanguard");
    expect(logged).toHaveBeenCalledWith("Failed to fetch the register list for sitemap: a page was not answered.");
    logged.mockRestore();
  });

  // A register as the API answers it, with the figures the register page's metadata reads.
  const registerResponse = (code: string, holders: number) => ({
    summary: {
      stockCode: code,
      companyName: `${code} Limited`,
      holders,
      disclosedPct: 9.5,
      byKind: [],
      shortPct: 0,
      hasShortPct: false,
      indexPct: 0,
      hasIndexPct: false,
      superOptions: 0,
      superValueAud: 0,
      hasSuperValue: false,
    },
    holders: [],
    history: [],
    fundHoldings: [],
    historyTotal: 0,
    withheldListed: 0,
    asOf: "2026-10-20",
    sharesOnIssue: 0,
    hasSharesOnIssue: false,
  });

  // The strict-subset rule for the register pages, asked of the page itself: each
  // listed register's own metadata is indexable, with no robots key.
  it("lists no register page that the page's own metadata noindexes", async () => {
    const registers = (await buildOwnershipSitemap()).filter((e) =>
      e.url.startsWith("https://shorted.com.au/ownership/stocks/"),
    );
    expect(registers).toHaveLength(2);
    for (const entry of registers) {
      const code = entry.url.slice(entry.url.lastIndexOf("/") + 1);
      const row = registerRowsFixture.find((r) => r.code === code)!;
      getStockOwnership.mockResolvedValue(registerResponse(code, Number(row.holders)));
      const meta = await registerMetadata({ params: Promise.resolve({ code }) });
      expect(meta.alternates?.canonical).toBe(entry.url);
      expect(Object.keys(meta)).not.toContain("robots");
    }
  });

  it("lists the capital-prices hub and every capital registry slug", async () => {
    const housing = await buildHousingSitemap();
    const hub = housing.find(
      (entry) => entry.url === "https://shorted.com.au/housing/capitals",
    );
    const housingHub = housing.find(
      (entry) => entry.url === "https://shorted.com.au/housing",
    );
    expect(hub).toBeDefined();
    expect(hub!.lastModified).toBe(housingHub!.lastModified);

    for (const slug of CAPITAL_SLUGS) {
      const capital = CAPITALS.find((candidate) => candidate.slug === slug)!;
      const entry = housing.find(
        (candidate) =>
          candidate.url === `https://shorted.com.au/housing/capitals/${slug}`,
      );
      const state = housing.find(
        (candidate) =>
          candidate.url ===
          `https://shorted.com.au/housing/${capital.stateCode.toLowerCase()}`,
      );
      expect(entry).toBeDefined();
      expect(entry!.lastModified).toBe(state!.lastModified);
    }
  });
});

describe("sitemap XML rendering", () => {
  it("renders a valid urlset, escaping and omitting absent lastmods", () => {
    const xml = renderUrlset([
      { url: "https://shorted.com.au/a?x=1&y=2", lastModified: "2026-08-13T00:00:00.000Z" },
      { url: "https://shorted.com.au/b" },
    ]);
    expect(xml.startsWith('<?xml version="1.0" encoding="UTF-8"?>')).toBe(true);
    expect(xml).toContain("<urlset");
    expect(xml).toContain("https://shorted.com.au/a?x=1&amp;y=2");
    expect((xml.match(/<lastmod>/g) ?? []).length).toBe(1);
    expect((xml.match(/<loc>/g) ?? []).length).toBe(2);
  });

  it("renders a sitemapindex referencing real child URLs", () => {
    const xml = renderSitemapIndex(
      SITEMAP_CHILDREN.map((c) => ({ url: `https://shorted.com.au/${c}` })),
    );
    expect(xml).toContain("<sitemapindex");
    expect((xml.match(/<loc>/g) ?? []).length).toBe(SITEMAP_CHILDREN.length);
    expect(SITEMAP_CHILDREN.length).toBeGreaterThanOrEqual(4);
  });
});
