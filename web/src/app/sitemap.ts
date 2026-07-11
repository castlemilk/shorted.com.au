import { type MetadataRoute } from "next";
import { siteConfig } from "~/@/config/site"
import { getAllPosts } from "~/@/lib/api";
import { createConnectTransport } from "@connectrpc/connect-web";
import { createClient } from "@connectrpc/connect";
import { ShortedStocksService } from "~/gen/shorts/v1alpha1/shorts_pb";
import { getAllTermSlugs } from "~/@/data/glossary-terms";
import { getHousingStateSlugs } from "./actions/getHousingSitemap";
import {
  buildApiUrl,
  getServerShortsApiUrl,
  serverFetchWithUserAgent,
  skipForBuild,
} from "./actions/config";
import {
  getAvailableWeekSlugs,
  getAvailableMonthSlugs,
  getAvailableYearSlugs,
} from "./actions/reports/getReportData";
import { isStockIndexable } from "~/@/lib/seo/stock-indexability";

// Regenerate the sitemap hourly at runtime. Without this the sitemap is
// frozen at build output — and because SKIP_STATIC_GENERATION=1 is set
// project-wide on Vercel, the build-time sitemap only ever contained the
// 20-stock fallback list (GSC "discovered - not indexed" regression,
// July 2026). Runtime regeneration + the build-phase-only skip below
// restore the full ~800-stock coverage.
export const revalidate = 3600;

// Regeneration fans out to ~15 RPCs (8 housing states + stocks + dates +
// industries + takes); the default 15s Vercel function limit killed it.
export const maxDuration = 60;

// ISR-safe fetch for every RPC made from this route: inside a
// revalidate-cached route a no-store fetch throws "Dynamic server usage",
// and serverFetchWithUserAgent forces no-store on POSTs at Vercel runtime
// unless an explicit cache/next option is given. Pin all sitemap RPCs to
// the data cache with the route's own revalidate window instead.
const sitemapFetch: typeof fetch = (input, init) =>
  serverFetchWithUserAgent(input, {
    ...init,
    next: { revalidate: 3600 },
  } as RequestInit);

// Educational articles for sitemap. Must cover every slug in articlesData
// (web/src/app/learn/[slug]/page.tsx) — three real pages had silently drifted
// out of this list (asic-short-selling-regulations, how-to-view-asic-short-
// positions, covered-short-selling-australia).
const learnArticles = [
  "what-is-short-selling",
  "understanding-t4-delay",
  "how-to-read-short-interest",
  "short-squeeze-mechanics",
  "risk-management-shorted-stocks",
  "sector-analysis-short-selling",
  "building-a-watchlist",
  "asx-short-selling-history",
  "securities-lending-explained",
  "short-selling-vs-put-options",
  "reading-short-interest-changes",
  "asic-short-selling-regulations",
  "how-to-view-asic-short-positions",
  "covered-short-selling-australia",
  "how-to-short-the-asx",
];

// API URL for sitemap generation during builds
const API_URL =
  getServerShortsApiUrl();

// API response type for top shorts
interface TopShortsResponse {
  // In summary mode (summaryOnly=true), the API returns `latestShortPosition`
  // populated with `current_percent` from mv_top_shorts (sorted DESC) plus the
  // company `name` and `industry`.
  timeSeries: Array<{
    productCode?: string;
    name?: string;
    latestShortPosition?: number;
    industry?: string;
  }>;
}

// Cap on stock URLs in the sitemap. The indexability gate (see
// stock-indexability) keeps the set to enriched / genuinely-shorted stocks
// (~1k) which is well under this cap; the equities-only MV filter
// (migration 000043) already excludes ETFs/bonds.
const SITEMAP_MAX_STOCKS = 1000;

// Popular stock codes as fallback when API is unavailable
const FALLBACK_STOCK_CODES = [
  "CBA", "BHP", "CSL", "NAB", "WBC", "ANZ", "WES", "MQG", "WOW", "TLS",
  "RIO", "FMG", "GMG", "TCL", "WDS", "NCM", "ALL", "COL", "REA", "QBE",
];

/**
 * Fetch all stock codes from the API for the sitemap.
 * Uses direct fetch to avoid protobuf-es SSR initialization issues.
 * Falls back to popular stock codes if API is unavailable.
 */
async function getAllStockCodes(): Promise<string[]> {
  if (skipForBuild()) {
    return FALLBACK_STOCK_CODES;
  }

  try {
    const baseUrl = API_URL;

    // Use direct fetch with JSON to avoid protobuf-es SSR issues.
    // Send Connect protocol + UA headers — the Cloudflare WAF 403s bare
    // server-side fetches to api.shorted.com.au (see CLAUDE.md / mcp-server),
    // which would otherwise silently fall back to FALLBACK_STOCK_CODES.
    const response = await sitemapFetch(
      buildApiUrl(
        baseUrl,
        "/shorts.v1alpha1.ShortedStocksService/GetTopShorts",
      ),
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Connect-Protocol-Version": "1",
          "User-Agent": "shorted-sitemap/1.0 (+https://shorted.com.au)",
        },
        body: JSON.stringify({
          period: "1y",
          limit: 1000,
          offset: 0,
          summaryOnly: true,
        }),
        next: { revalidate: 3600 }, // Cache for 1 hour
      }
    );

    if (!response.ok) {
      console.warn(`Sitemap API returned ${response.status}, using fallback stocks`);
      return FALLBACK_STOCK_CODES;
    }

    const data = (await response.json()) as TopShortsResponse;

    // Only list URLs the page itself indexes (see stock-indexability):
    // named stocks at/above the shared short-interest floor and with a code
    // the /shorts/[code] route serves (1-4 alnum — longer codes like govt
    // bonds GSB*, warrants XCLW*, preference shares GSBW30/BENPH/MQGPD 404).
    // This guarantees the sitemap never advertises a noindexed URL.
    const qualified = (data.timeSeries || [])
      .filter((ts) =>
        isStockIndexable({
          code: ts.productCode ?? "",
          name: ts.name,
          industry: ts.industry,
          percentShorted:
            typeof ts.latestShortPosition === "number"
              ? ts.latestShortPosition
              : 0,
        }),
      )
      .slice(0, SITEMAP_MAX_STOCKS)
      .map((ts) => ts.productCode!);

    return qualified.length > 0 ? [...new Set(qualified)] : FALLBACK_STOCK_CODES;
  } catch (error) {
    console.error("Failed to fetch stock codes for sitemap:", error);
    return FALLBACK_STOCK_CODES;
  }
}

export default async function sitemap(): Promise<MetadataRoute.Sitemap> {
  const baseUrl = siteConfig.url;
  const currentDate = new Date().toISOString();

  // Latest ASIC data date — the honest lastmod for all data-driven pages.
  // Google ignores lastmod when it's demonstrably the build timestamp, so
  // pages whose content changes with the daily sync use the actual data
  // date, and static marketing pages omit lastModified entirely.
  // One ISR-safe connect client for every RPC this route makes directly.
  // The shared server actions (getEditorialTake, getHousing, getIndustryData)
  // fetch without an explicit cache mode, which throws "Dynamic server usage"
  // inside this ISR route on Vercel — so the sitemap calls the RPCs itself.
  const transport = createConnectTransport({
    fetch: sitemapFetch,
    baseUrl: API_URL,
  });
  const client = createClient(ShortedStocksService, transport);

  let marketDates: string[] = [];
  if (!skipForBuild()) {
    try {
      const response = await client.getAvailableDates({ limit: 90, before: "" });
      marketDates = response.dates;
    } catch (error) {
      console.error("Failed to fetch market dates for sitemap:", error);
    }
  }
  const latestDataDate = marketDates[0]
    ? new Date(`${marketDates[0]}T00:00:00Z`).toISOString()
    : currentDate;

  // Static marketing/documentation pages: no reliable change signal, so no
  // lastModified (omitting is valid and better than a fabricated date).
  const staticRoutes: MetadataRoute.Sitemap = [
    { url: baseUrl, lastModified: latestDataDate },
    { url: `${baseUrl}/about` },
    { url: `${baseUrl}/blog` },
    { url: `${baseUrl}/terms` },
    { url: `${baseUrl}/roadmap` },
    { url: `${baseUrl}/pricing` },
    { url: `${baseUrl}/developer` },
    { url: `${baseUrl}/technology` },
    { url: `${baseUrl}/methodology` },
    { url: `${baseUrl}/disclaimer` },
    { url: `${baseUrl}/compare` },
    { url: `${baseUrl}/seasonality`, lastModified: latestDataDate },
    { url: `${baseUrl}/features/the-widow-maker`, lastModified: "2026-06-23" },
    { url: `${baseUrl}/housing`, lastModified: latestDataDate },
    { url: `${baseUrl}/housing/calculators`, lastModified: latestDataDate },
  ];

  // Blog post routes
  const posts = getAllPosts();
  const blogRoutes = posts.map((post) => ({
    url: `${baseUrl}/blog/${post.slug}`,
    lastModified: post.date,
  }));

  // Dynamically fetch all stock codes from the API
  const stockCodes = await getAllStockCodes();

  const stockRoutes = stockCodes.map((code) => ({
    url: `${baseUrl}/shorts/${code}`,
    lastModified: latestDataDate,
  }));

  // Seed comparison-page URLs from the top-20 most shorted stocks.
  // This yields up to 190 pairs (C(20,2)) but we cap at 30 to avoid
  // index bloat and only include alphabetically-canonical ordering.
  const top20 = stockCodes.slice(0, 20);
  const comparePairs: Array<{ url: string; lastModified: string }> = [];
  outer: for (let i = 0; i < top20.length; i++) {
    for (let j = i + 1; j < top20.length; j++) {
      const a = top20[i]!;
      const b = top20[j]!;
      const [lo, hi] = a < b ? [a, b] : [b, a];
      comparePairs.push({
        url: `${baseUrl}/compare/${lo}-vs-${hi}`,
        lastModified: latestDataDate,
      });
      if (comparePairs.length >= 30) break outer;
    }
  }

  // Canonical listing is /shorts; /stocks is not a canonical index.
  const shortsRoutes = [
    { url: `${baseUrl}/shorts`, lastModified: latestDataDate },
  ];

  // Documentation routes for LLMs and developers
  const docRoutes = [
    { url: `${baseUrl}/docs/llm-context` },
    { url: `${baseUrl}/docs/llm-context-raw` },
    { url: `${baseUrl}/docs/api-reference` },
  ];

  // Industry pages - index + individual industry pages. Fetched directly
  // (not via getAllIndustrySlugs) so the fetch carries the ISR-safe cache
  // mode; slug rules mirror actions/industry/getIndustryData.ts createSlug.
  let industrySlugs: string[] = [];
  if (!skipForBuild()) {
    try {
      const resp = await sitemapFetch(
        buildApiUrl(
          API_URL,
          "/shorts.v1alpha1.ShortedStocksService/GetIndustryTreeMap",
        ),
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Connect-Protocol-Version": "1",
          },
          body: JSON.stringify({ period: "max", limit: 50, viewMode: 0 }),
        },
      );
      if (resp.ok) {
        const treemap = (await resp.json()) as {
          stocks?: Array<{ industry?: string }>;
        };
        const invalid = new Set(["Class Pend", "Not Applic", "Not Applicable", ""]);
        const names = new Set<string>();
        for (const s of treemap.stocks ?? []) {
          const industry = s.industry?.trim() ?? "Other";
          names.add(invalid.has(industry) ? "Other" : industry);
        }
        industrySlugs = [...names].map((name) =>
          name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, ""),
        );
      }
    } catch (error) {
      console.error("Failed to fetch industry slugs for sitemap:", error);
    }
  }

  const industryRoutes = [
    {
      url: `${baseUrl}/industry-intelligence`,
      lastModified: latestDataDate,
    },
    {
      url: `${baseUrl}/industry`,
      lastModified: latestDataDate,
    },
    ...industrySlugs.map((slug) => ({
      url: `${baseUrl}/industry/${slug}`,
      lastModified: latestDataDate,
    })),
  ];

  // Glossary pages - index + individual terms (static content, no lastmod)
  const termSlugs = getAllTermSlugs();
  const glossaryRoutes = [
    { url: `${baseUrl}/glossary` },
    ...termSlugs.map((slug) => ({
      url: `${baseUrl}/glossary/${slug}`,
    })),
  ];

  // Directory pages - index + per-letter
  const letters = "abcdefghijklmnopqrstuvwxyz".split("");
  const directoryRoutes = [
    {
      url: `${baseUrl}/directory`,
      lastModified: latestDataDate,
    },
    ...letters.map((letter) => ({
      url: `${baseUrl}/directory/${letter}`,
      lastModified: latestDataDate,
    })),
  ];

  // Market snapshot pages: each dated snapshot was last modified on its own
  // date (historical data is immutable once published).
  const marketRoutes = [
    {
      url: `${baseUrl}/market`,
      lastModified: latestDataDate,
    },
    ...marketDates.map((date) => ({
      url: `${baseUrl}/market/${date}`,
      lastModified: new Date(`${date}T00:00:00Z`).toISOString(),
    })),
  ];

  // Report pages
  let weekSlugs: string[] = [];
  let monthSlugs: string[] = [];
  let yearSlugs: string[] = [];
  try {
    weekSlugs = await getAvailableWeekSlugs();
    monthSlugs = await getAvailableMonthSlugs();
    yearSlugs = await getAvailableYearSlugs();
  } catch (error) {
    console.error("Failed to fetch report slugs for sitemap:", error);
  }

  // Historical reports have fixed publish dates; derive lastmod from slug so
  // older reports don't churn their lastmod on every regeneration.
  const weeklyLastMod = (slug: string): string => {
    // Supports "2026-W17" or "2026-17"
    const m = /^(\d{4})-W?(\d{1,2})$/.exec(slug);
    if (!m) return currentDate;
    const year = parseInt(m[1]!, 10);
    const week = parseInt(m[2]!, 10);
    // ISO week 1 = the week containing Jan 4. Approximate to Monday of that week + 5 days (Saturday).
    const jan4 = new Date(Date.UTC(year, 0, 4));
    const jan4Day = jan4.getUTCDay() || 7;
    const mondayWeek1 = new Date(jan4);
    mondayWeek1.setUTCDate(jan4.getUTCDate() - (jan4Day - 1));
    const target = new Date(mondayWeek1);
    target.setUTCDate(mondayWeek1.getUTCDate() + (week - 1) * 7 + 5);
    return target.toISOString();
  };
  const monthlyLastMod = (slug: string): string => {
    const m = /^(\d{4})-(\d{1,2})$/.exec(slug);
    if (!m) return currentDate;
    const year = parseInt(m[1]!, 10);
    const month = parseInt(m[2]!, 10);
    // First day of the following month
    return new Date(Date.UTC(year, month, 1)).toISOString();
  };
  const yearlyLastMod = (slug: string): string => {
    const m = /^(\d{4})$/.exec(slug);
    if (!m) return currentDate;
    return new Date(Date.UTC(parseInt(m[1]!, 10) + 1, 0, 1)).toISOString();
  };

  const reportRoutes = [
    { url: `${baseUrl}/reports`, lastModified: currentDate },
    ...weekSlugs.map((slug) => ({
      url: `${baseUrl}/reports/weekly/${slug}`,
      lastModified: weeklyLastMod(slug),
    })),
    ...monthSlugs.map((slug) => ({
      url: `${baseUrl}/reports/monthly/${slug}`,
      lastModified: monthlyLastMod(slug),
    })),
    ...yearSlugs.map((slug) => ({
      url: `${baseUrl}/reports/yearly/${slug}`,
      lastModified: yearlyLastMod(slug),
    })),
  ];

  // FAQ + privacy: static content, no reliable change signal.
  const faqRoutes = [{ url: `${baseUrl}/faq` }];
  const privacyRoutes = [{ url: `${baseUrl}/privacy` }];

  // Educational content hub (static articles)
  const learnRoutes = [
    { url: `${baseUrl}/learn` },
    ...learnArticles.map((slug) => ({
      url: `${baseUrl}/learn/${slug}`,
    })),
  ];

  // Top page (high priority landing page, refreshed with the daily sync)
  const topRoutes = [
    {
      url: `${baseUrl}/top`,
      lastModified: latestDataDate,
    },
  ];

  // Screener page (query param presets excluded — not indexable)
  const screenerRoutes = [
    {
      url: `${baseUrl}/screener`,
      lastModified: latestDataDate,
    },
  ];

  // News hub + per-stock news pages. Per-stock news pages share the
  // same qualified stockCodes list, so the news tree mirrors the
  // pruned stock list (no thin pages get indexed). News flows hourly,
  // so the render date is genuinely the last modification.
  const newsRoutes = [
    { url: `${baseUrl}/news`, lastModified: currentDate },
    ...stockCodes.map((code) => ({
      url: `${baseUrl}/shorts/${code}/news`,
      lastModified: currentDate,
    })),
  ];

  // Shorted Take editorial pages (DB-backed). Called directly on the
  // ISR-safe client (the shared action's fetch throws in ISR context).
  // Soft-fail so a transient outage doesn't blank the sitemap.
  let takeRoutes: MetadataRoute.Sitemap = [];
  if (!skipForBuild()) {
    try {
      const takesResp = await client.listEditorialTakes({
        limit: 200,
        offset: 0,
        stockCode: "",
      });
      takeRoutes = (takesResp?.takes ?? []).map((t) => {
        const lastMod =
          t.publishedAt && typeof t.publishedAt.seconds === "bigint"
            ? new Date(Number(t.publishedAt.seconds) * 1000).toISOString()
            : currentDate;
        return { url: `${baseUrl}/news/${t.slug}`, lastModified: lastMod };
      });
    } catch {
      // ignore — Take pages will appear in the next regeneration
    }
  }

  // Insider-trading hub + per-stock director-trades pages.
  const insiderRoutes = [
    { url: `${baseUrl}/insider-trading`, lastModified: latestDataDate },
    ...stockCodes.map((code) => ({
      url: `${baseUrl}/insider-trading/${code}`,
      lastModified: latestDataDate,
    })),
  ];

  // Open data hub.
  const dataRoutes = [
    { url: `${baseUrl}/data`, lastModified: latestDataDate },
  ];

  // Housing pages: state drilldowns + priced suburbs (thin pages excluded).
  // Suburbs are fetched directly on the ISR-safe client, states in parallel
  // (8 sequential RPCs through the shared action previously helped blow the
  // function time limit). Slug shape mirrors actions/getHousingSitemap.ts.
  let housingStateSlugs: string[] = [];
  let housingSuburbUrls: { state: string; suburb: string }[] = [];
  try { housingStateSlugs = await getHousingStateSlugs(); } catch (e) { console.error("housing state slugs:", e); }
  if (!skipForBuild()) {
    const slugifySuburb = (name: string, postcode: string) =>
      `${name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "")}-${postcode}`;
    const { ALL_STATES, stateSlug } = await import("~/@/lib/housing/states");
    const perState = await Promise.all(
      ALL_STATES.map(async (st) => {
        try {
          const res = await client.listStateSuburbs({ stateCode: st, query: "", limit: 5000 });
          return res.suburbs
            .filter((s) => s.latestMedianPrice > 0) // only real price data (avoid thin pages)
            .map((s) => ({ state: stateSlug(st), suburb: slugifySuburb(s.salName, s.postcode) }));
        } catch (e) {
          console.error(`housing suburb urls (${st}):`, e);
          return [];
        }
      }),
    );
    housingSuburbUrls = perState.flat();
  }

  const housingRoutes = [
    ...housingStateSlugs.map((slug) => ({ url: `${baseUrl}/housing/${slug}`, lastModified: latestDataDate })),
    // clean canonical URLs (the page resolves the SAL from the slug; ?sal= is only a fast-path)
    ...housingSuburbUrls.map((s) => ({ url: `${baseUrl}/housing/${s.state}/${s.suburb}`, lastModified: latestDataDate })),
  ];

  // Authors hub + per-author profile pages — E-E-A-T signal (static).
  const { getAllAuthorSlugs } = await import("~/@/data/authors");
  const authorSlugs = getAllAuthorSlugs();
  const authorRoutes = [
    { url: `${baseUrl}/authors` },
    ...authorSlugs.map((slug) => ({
      url: `${baseUrl}/authors/${slug}`,
    })),
  ];

  return [
    ...staticRoutes,
    ...topRoutes,
    ...shortsRoutes,
    ...industryRoutes,
    ...glossaryRoutes,
    ...directoryRoutes,
    ...marketRoutes,
    ...reportRoutes,
    ...newsRoutes,
    ...takeRoutes,
    ...insiderRoutes,
    ...dataRoutes,
    ...authorRoutes,
    ...faqRoutes,
    ...privacyRoutes,
    ...learnRoutes,
    ...docRoutes,
    ...screenerRoutes,
    ...housingRoutes,
    ...blogRoutes,
    ...stockRoutes,
    ...comparePairs,
  ];
}
