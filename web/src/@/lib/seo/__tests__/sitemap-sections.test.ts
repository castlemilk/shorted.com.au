/// <reference types="jest" />

/**
 * Structural guard for the sitemap index restructure (August 2026).
 *
 * /sitemap.xml is a sitemapindex over five children. The invariants that
 * matter — and that no runtime check can recover from once broken — are:
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
    listStateSuburbs: async ({ stateCode }: { stateCode: string }) => ({
      suburbs: Array.from({ length: 5 }, (_, i) => ({
        salCode: `${stateCode}${i}`,
        salName: `Suburb ${stateCode} ${i}`,
        postcode: `${2000 + i}`,
        // Half priced, half unpriced — exercises both lastmod branches.
        latestMedianPrice: i % 2 === 0 ? 1_000_000 : 0,
        population: 5_000,
        latestPeriod:
          i % 2 === 0 ? { seconds: BigInt(1_748_000_000 + i * 86_400) } : undefined,
      })),
    }),
  }),
}));

jest.mock("~/app/actions/config", () => ({
  skipForBuild: () => false,
  getServerShortsApiUrl: () => "https://api.example.test",
  buildApiUrl: (base: string, path: string) => `${base}${path}`,
  serverFetchWithUserAgent: async (input: string) => {
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
  },
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
    { slug: "post-one", date: "2026-05-01T00:00:00.000Z" },
    { slug: "post-two", date: "2026-06-01T00:00:00.000Z" },
  ],
}));

import {
  buildCoreSitemap,
  buildHousingSitemap,
  buildPoliticiansSitemap,
  buildReportsSitemap,
  buildShortsSitemap,
} from "../sitemap-sections";
import {
  SITEMAP_CHILDREN,
  dedupeEntries,
  renderSitemapIndex,
  renderUrlset,
} from "../sitemap-xml";
import { THEME_SLUGS } from "~/@/lib/themes/registry";
import {
  HOUSING_RANKINGS,
  HOUSING_RANKING_SLUGS,
} from "~/@/lib/housing-rankings/registry";
import { PUBLISHED_ECONOMY_TOPIC_PAIRS } from "~/@/lib/economy/topics";

type Section = { name: string; entries: Awaited<ReturnType<typeof buildCoreSitemap>> };

async function buildAll(): Promise<Section[]> {
  const [core, shorts, reports, housing, politicians] = await Promise.all([
    buildCoreSitemap(),
    buildShortsSitemap(),
    buildReportsSitemap(),
    buildHousingSitemap(),
    buildPoliticiansSitemap(),
  ]);
  return [
    { name: "sitemap-core.xml", entries: core },
    { name: "sitemap-shorts.xml", entries: shorts },
    { name: "sitemap-reports.xml", entries: reports },
    { name: "sitemap-housing.xml", entries: housing },
    { name: "sitemap-politicians.xml", entries: politicians },
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
    ];

    for (const [needle, child] of expectations) {
      expect({ needle, in: where(needle) }).toEqual({ needle, in: [child] });
    }
  });

  // The theme URLs come from the registry, so a new theme reaches the sitemap
  // without anyone remembering to hand-edit a list.
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

  it("drops the auth-gated /developer stub and adds the API docs tree", async () => {
    const all = (await buildAll()).flatMap((s) => s.entries.map((e) => e.url));
    expect(all.filter((u) => u.endsWith("/developer"))).toEqual([]);
    expect(all).toContain("https://shorted.com.au/docs/api");
    expect(all).toContain("https://shorted.com.au/docs/api/get-top-shorts");
    expect(all).toContain("https://shorted.com.au/docs/api/clients/python");
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
