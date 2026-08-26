/**
 * Per-section sitemap builders.
 *
 * WHY THIS FILE EXISTS
 * --------------------
 * `/sitemap.xml` used to be ONE flat urlset of ~8.7k URLs that took ~6.9s to
 * generate: housing was 62% of it, so the ASX cluster (the pages that actually
 * change every day with the ASIC sync) had no independent recrawl signal, and
 * a single slow housing RPC delayed the whole document. It is now a
 * sitemapindex over five children (see SITEMAP_CHILDREN in ./sitemap-xml), and
 * each child fetches ONLY the data its own section needs.
 *
 * RENDERING SEMANTICS — DO NOT "OPTIMISE" THIS TO ISR
 * ---------------------------------------------------
 * Every child route that fetches data is `force-dynamic`. The build runs with
 * SKIP_STATIC_GENERATION=1, so a prerender only ever contains the 20-stock
 * fallback — with ISR that degenerate copy would serve for up to an hour after
 * EVERY deploy (GSC "discovered - not indexed" regression, July 2026).
 * Freshness/cost is handled at the fetch layer instead: the plain-JSON RPCs
 * carry `next.revalidate`, so repeat renders hit the data cache and only the
 * first request after a deploy pays the full fan-out.
 *
 * LASTMOD POLICY
 * --------------
 * Before August 2026 a single `latestDataDate` constant (the newest ASIC data
 * date) was stamped on nearly every URL — housing, economy, politicians,
 * directory, everything — so every lastmod in the document was byte-identical
 * and carried zero information. Google discards lastmod wholesale when it
 * looks like a build constant. The rule now:
 *
 *   - ASIC-derived pages (stocks, /top, /statistics, /scans, /industry,
 *     /directory, /market, /screener, insider-trading) -> latestDataDate.
 *   - Pages with their own real date (market snapshots, reports, blog posts,
 *     editorial takes, priced suburbs) -> THAT date.
 *   - Hub pages over a collection -> newest member's date.
 *   - Everything else (static marketing, economy, politicians, unpriced
 *     suburbs, calculators, /price-drops) -> NO lastmod. Omitting is valid and
 *     strictly better than fabricating.
 */

import { createConnectTransport } from "@connectrpc/connect-web";
import { createClient } from "@connectrpc/connect";
import { siteConfig } from "~/@/config/site";
import { getAllPosts } from "~/@/lib/api";
import { HousingService } from "~/gen/shorts/v1alpha1/housing_pb";
import { MarketService } from "~/gen/shorts/v1alpha1/market_pb";
import { NewsService } from "~/gen/shorts/v1alpha1/news_pb";
import { getAllTermSlugs } from "~/@/data/glossary-terms";
import { getHousingStateSlugs } from "~/app/actions/getHousingSitemap";
import {
  buildApiUrl,
  getServerShortsApiUrl,
  serverFetchWithUserAgent,
  skipForBuild,
} from "~/app/actions/config";
import { getReportsList } from "~/app/actions/reports/getReportData";
import { weeklyReportPath } from "~/@/lib/reports/weekly-slug";
import { SCAN_SLUGS } from "~/@/lib/scans/registry";
import { THEME_SLUGS } from "~/@/lib/themes/registry";
import {
  HOUSING_RANKINGS,
  HOUSING_RANKING_SLUGS,
} from "~/@/lib/housing-rankings/registry";
import { CAPITALS } from "~/@/lib/housing/capitals";
import { STATE_SLUGS } from "~/@/lib/economy/map-metrics";
import { PUBLISHED_ECONOMY_TOPIC_PAIRS } from "~/@/lib/economy/topics";
import { isStockIndexable } from "~/@/lib/seo/stock-indexability";
import { createSlug } from "~/@/lib/industry-slug";
import { ALL_STATES, stateSlug, suburbSlug } from "~/@/lib/housing/states";
import { isSuburbSitemapEligible } from "~/@/lib/seo/suburb-indexability";
import { newestLastMod, type SitemapEntry } from "~/@/lib/seo/sitemap-xml";

const baseUrl = siteConfig.url;
const API_URL = getServerShortsApiUrl();

// Data-cached fetch for the plain-JSON RPCs below (string bodies hash into a
// Next data-cache key, so repeat renders skip the network). Connect-transport
// calls must NOT use this: their streamed request bodies make Next throw
// "Failed to generate cache key" (500'd the whole route on Vercel) — they run
// uncached instead, which is legal in a force-dynamic route.
const sitemapFetch: typeof fetch = (input, init) =>
  serverFetchWithUserAgent(input, {
    ...init,
    next: { revalidate: 3600 },
  } as RequestInit);

// One connect client factory per render. Uses the plain (uncached / no-store)
// fetch: connect streams its POST bodies, which the Next data cache cannot key.
function connectTransport() {
  return createConnectTransport({
    fetch: serverFetchWithUserAgent,
    baseUrl: API_URL,
  });
}

// Educational articles for the sitemap. Must cover every slug in articlesData
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

// Mirrors Object.keys(CLIENT_GUIDES) in
// web/src/app/docs/api/clients/[language]/page.tsx. Hardcoded rather than
// imported so the sitemap never pulls a React page module into a route handler.
const API_CLIENT_LANGUAGES = [
  "curl",
  "javascript",
  "python",
  "typescript",
  "go",
  "java",
];

// Cap on stock URLs. The indexability gate (see stock-indexability) keeps the
// set to enriched / genuinely-shorted stocks (~1k) which is well under this
// cap; the equities-only MV filter (migration 000043) excludes ETFs/bonds.
const SITEMAP_MAX_STOCKS = 1000;

// Comparison pages seeded from the most-shorted list. /compare/[pair] renders
// ANY pair whose two codes both resolve via getStockOrNotFound, so seeding from
// the qualified (already-indexable) stock list can never advertise a 404. The
// cap was 30; 80 keeps the co-shorted cluster (top-20 x top-20) meaningfully
// covered without unbounded index bloat.
const SITEMAP_MAX_COMPARE_PAIRS = 80;

// Popular stock codes as fallback when the API is unavailable.
const FALLBACK_STOCK_CODES = [
  "CBA", "BHP", "CSL", "NAB", "WBC", "ANZ", "WES", "MQG", "WOW", "TLS",
  "RIO", "FMG", "GMG", "TCL", "WDS", "NCM", "ALL", "COL", "REA", "QBE",
];

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

/**
 * Fetch all stock codes from the API for the sitemap.
 * Uses direct fetch to avoid protobuf-es SSR initialization issues.
 * Falls back to popular stock codes if the API is unavailable.
 */
async function getAllStockCodes(): Promise<string[]> {
  if (skipForBuild()) {
    return FALLBACK_STOCK_CODES;
  }

  try {
    // Send Connect protocol + UA headers — the Cloudflare WAF 403s bare
    // server-side fetches to api.shorted.com.au (see CLAUDE.md / mcp-server),
    // which would otherwise silently fall back to FALLBACK_STOCK_CODES.
    const response = await sitemapFetch(
      buildApiUrl(API_URL, "/shorts.v1alpha1.ShortedStocksService/GetTopShorts"),
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
        next: { revalidate: 3600 },
      },
    );

    if (!response.ok) {
      console.warn(`Sitemap API returned ${response.status}, using fallback stocks`);
      return FALLBACK_STOCK_CODES;
    }

    const data = (await response.json()) as TopShortsResponse;

    // Only list URLs the page itself indexes (see stock-indexability): named
    // stocks at/above the shared short-interest floor and with a code the
    // /shorts/[code] route serves (1-4 alnum — longer codes like govt bonds
    // GSB*, warrants XCLW*, preference shares GSBW30/BENPH/MQGPD 404). This
    // guarantees the sitemap never advertises a noindexed URL.
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

/** Available ASIC report dates, newest first. */
async function getMarketDates(): Promise<string[]> {
  if (skipForBuild()) return [];
  try {
    const marketClient = createClient(MarketService, connectTransport());
    const response = await marketClient.getAvailableDates({ limit: 90, before: "" });
    return response.dates;
  } catch (error) {
    console.error("Failed to fetch market dates for sitemap:", error);
    return [];
  }
}

/**
 * The honest lastmod for every ASIC-derived page: the newest data date, NOT the
 * render time. `undefined` when the RPC fails — better no signal than a fake one.
 */
function latestDataDateOf(marketDates: string[]): string | undefined {
  const first = marketDates[0];
  return first ? new Date(`${first}T00:00:00Z`).toISOString() : undefined;
}

/* ------------------------------------------------------------------ core -- */

export async function buildCoreSitemap(): Promise<SitemapEntry[]> {
  const marketDates = await getMarketDates();
  const latestDataDate = latestDataDateOf(marketDates);

  // Static marketing/documentation pages: no reliable change signal, so no
  // lastModified (omitting is valid and better than a fabricated date).
  // NOTE: /developer is deliberately absent — it is an auth-gated dashboard
  // stub that renders a spinner for anonymous crawlers.
  const staticRoutes: SitemapEntry[] = [
    { url: baseUrl, lastModified: latestDataDate },
    { url: `${baseUrl}/about` },
    { url: `${baseUrl}/blog` },
    { url: `${baseUrl}/terms` },
    { url: `${baseUrl}/roadmap` },
    { url: `${baseUrl}/pricing` },
    { url: `${baseUrl}/technology` },
    { url: `${baseUrl}/methodology` },
    { url: `${baseUrl}/disclaimer` },
    { url: `${baseUrl}/seasonality`, lastModified: latestDataDate },
    { url: `${baseUrl}/features/the-widow-maker`, lastModified: "2026-06-23" },
    // Economy: monthly collector cadence and no per-series date on this path,
    // so no lastmod rather than the ASIC date it used to (wrongly) carry.
    { url: `${baseUrl}/economy` },
    ...STATE_SLUGS.map((slug) => ({
      url: `${baseUrl}/economy/${slug}`,
    })),
    // Topic drill-downs share the registry's measured publication gate. Like
    // their hubs, they omit lastmod because no route-level source date exists.
    ...PUBLISHED_ECONOMY_TOPIC_PAIRS.map(({ state, topic }) => ({
      url: `${baseUrl}/economy/${state}/${topic}`,
    })),
    // Squeeze radar — "short squeeze asx" is a winnable SERP with weak incumbents.
    { url: `${baseUrl}/battlegrounds`, lastModified: latestDataDate },
    // Aggregate market statistics — the citable "$X.XB shorted" page.
    { url: `${baseUrl}/statistics`, lastModified: latestDataDate },
    { url: `${baseUrl}/top`, lastModified: latestDataDate },
    // Screener (query-param presets excluded — not indexable).
    { url: `${baseUrl}/screener`, lastModified: latestDataDate },
    // Fixed short-interest scans (slugs come from the registry — single source
    // of truth, no hand-list drift).
    { url: `${baseUrl}/scans`, lastModified: latestDataDate },
    ...SCAN_SLUGS.map((slug) => ({
      url: `${baseUrl}/scans/${slug}`,
      lastModified: latestDataDate,
    })),
    // Curated thematic baskets. Same rule as scans: ASIC-derived, so
    // latestDataDate, and the slugs come from the registry so there is no
    // hand-list to drift.
    { url: `${baseUrl}/themes`, lastModified: latestDataDate },
    ...THEME_SLUGS.map((slug) => ({
      url: `${baseUrl}/themes/${slug}`,
      lastModified: latestDataDate,
    })),
    // Open data hub + press kit — both citation surfaces we point journalists at.
    { url: `${baseUrl}/data`, lastModified: latestDataDate },
    { url: `${baseUrl}/press` },
    { url: `${baseUrl}/faq` },
    { url: `${baseUrl}/privacy` },
  ];

  // Blog posts carry their own publish date.
  const blogRoutes: SitemapEntry[] = getAllPosts().map((post) => ({
    url: `${baseUrl}/blog/${post.slug}`,
    lastModified: post.date,
  }));

  // Industry pages. Fetched directly (not via getAllIndustrySlugs) so the fetch
  // carries the ISR-safe cache mode; slug rules use the canonical helper.
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
        industrySlugs = [...names].map(createSlug);
      }
    } catch (error) {
      console.error("Failed to fetch industry slugs for sitemap:", error);
    }
  }

  const industryRoutes: SitemapEntry[] = [
    { url: `${baseUrl}/industry-intelligence`, lastModified: latestDataDate },
    { url: `${baseUrl}/industry`, lastModified: latestDataDate },
    ...industrySlugs.map((slug) => ({
      url: `${baseUrl}/industry/${slug}`,
      lastModified: latestDataDate,
    })),
  ];

  // Glossary: static content, no lastmod.
  const glossaryRoutes: SitemapEntry[] = [
    { url: `${baseUrl}/glossary` },
    ...getAllTermSlugs().map((slug) => ({ url: `${baseUrl}/glossary/${slug}` })),
  ];

  const letters = "abcdefghijklmnopqrstuvwxyz".split("");
  const directoryRoutes: SitemapEntry[] = [
    { url: `${baseUrl}/directory`, lastModified: latestDataDate },
    ...letters.map((letter) => ({
      url: `${baseUrl}/directory/${letter}`,
      lastModified: latestDataDate,
    })),
  ];

  // Market snapshots: each dated snapshot was last modified on its OWN date
  // (historical data is immutable once published).
  const marketRoutes: SitemapEntry[] = [
    { url: `${baseUrl}/market`, lastModified: latestDataDate },
    ...marketDates.map((date) => ({
      url: `${baseUrl}/market/${date}`,
      lastModified: new Date(`${date}T00:00:00Z`).toISOString(),
    })),
  ];

  const learnRoutes: SitemapEntry[] = [
    { url: `${baseUrl}/learn` },
    ...learnArticles.map((slug) => ({ url: `${baseUrl}/learn/${slug}` })),
  ];

  // Authors hub + per-author profile pages — E-E-A-T signal (static).
  const { getAllAuthorSlugs } = await import("~/@/data/authors");
  const authorRoutes: SitemapEntry[] = [
    { url: `${baseUrl}/authors` },
    ...getAllAuthorSlugs().map((slug) => ({ url: `${baseUrl}/authors/${slug}` })),
  ];

  // Documentation for LLMs and developers. The /docs/api tree generates real
  // static pages (generateStaticParams over the OpenAPI spec + the client
  // guides) but had never been submitted. The spec is read from disk, which is
  // only present at build time on Vercel — a runtime miss yields an empty
  // endpoint list, which is fine: the index + client guides still ship.
  let apiEndpointIds: string[] = [];
  try {
    const { parseOpenAPISpec } = await import("~/lib/openapi/parser");
    const spec = await parseOpenAPISpec();
    apiEndpointIds = spec.endpoints.map((e) => e.id);
  } catch (error) {
    console.error("Failed to parse OpenAPI spec for sitemap:", error);
  }

  const docRoutes: SitemapEntry[] = [
    { url: `${baseUrl}/docs/llm-context` },
    { url: `${baseUrl}/docs/llm-context-raw` },
    { url: `${baseUrl}/docs/api-reference` },
    { url: `${baseUrl}/docs/api` },
    ...apiEndpointIds.map((id) => ({ url: `${baseUrl}/docs/api/${id}` })),
    ...API_CLIENT_LANGUAGES.map((language) => ({
      url: `${baseUrl}/docs/api/clients/${language}`,
    })),
  ];

  // Shorted Take editorial pages (DB-backed). Called directly on the ISR-safe
  // client (the shared action's fetch throws in ISR context). Soft-fail so a
  // transient outage doesn't blank the section.
  let takeRoutes: SitemapEntry[] = [];
  if (!skipForBuild()) {
    try {
      const newsClient = createClient(NewsService, connectTransport());
      const takesResp = await newsClient.listEditorialTakes({
        limit: 200,
        offset: 0,
        stockCode: "",
      });
      takeRoutes = (takesResp?.takes ?? []).map((t) => ({
        url: `${baseUrl}/news/${t.slug}`,
        lastModified:
          t.publishedAt && typeof t.publishedAt.seconds === "bigint"
            ? new Date(Number(t.publishedAt.seconds) * 1000).toISOString()
            : undefined,
      }));
    } catch {
      // ignore — Take pages will appear in the next regeneration
    }
  }

  // The news hub's honest lastmod is its newest published take.
  const newsHub: SitemapEntry = {
    url: `${baseUrl}/news`,
    lastModified: newestLastMod(takeRoutes.map((t) => t.lastModified)),
  };

  return [
    ...staticRoutes,
    ...industryRoutes,
    ...glossaryRoutes,
    ...directoryRoutes,
    ...marketRoutes,
    ...learnRoutes,
    ...blogRoutes,
    ...authorRoutes,
    ...docRoutes,
    newsHub,
    ...takeRoutes,
  ];
}

/* ---------------------------------------------------------------- shorts -- */

export async function buildShortsSitemap(): Promise<SitemapEntry[]> {
  const [marketDates, stockCodes] = await Promise.all([
    getMarketDates(),
    getAllStockCodes(),
  ]);
  const latestDataDate = latestDataDateOf(marketDates);

  // Canonical listing is /shorts; /stocks is not a canonical index.
  const stockRoutes: SitemapEntry[] = [
    { url: `${baseUrl}/shorts`, lastModified: latestDataDate },
    ...stockCodes.map((code) => ({
      url: `${baseUrl}/shorts/${code}`,
      lastModified: latestDataDate,
    })),
  ];

  // Per-stock news pages share the qualified stockCodes list, so the news tree
  // mirrors the pruned stock list (no thin pages get indexed). The stock's news
  // tab is rebuilt with the same daily sync the stock page is.
  const stockNewsRoutes: SitemapEntry[] = stockCodes.map((code) => ({
    url: `${baseUrl}/shorts/${code}/news`,
    lastModified: latestDataDate,
  }));

  const insiderRoutes: SitemapEntry[] = [
    { url: `${baseUrl}/insider-trading`, lastModified: latestDataDate },
    ...stockCodes.map((code) => ({
      url: `${baseUrl}/insider-trading/${code}`,
      lastModified: latestDataDate,
    })),
  ];

  // Comparison pages seeded from the top-20 most shorted stocks: C(20,2) = 190
  // candidate pairs, capped (see SITEMAP_MAX_COMPARE_PAIRS) and emitted in
  // alphabetically-canonical order so we never advertise the redirecting form.
  const top20 = stockCodes.slice(0, 20);
  const comparePairs: SitemapEntry[] = [{ url: `${baseUrl}/compare` }];
  outer: for (let i = 0; i < top20.length; i++) {
    for (let j = i + 1; j < top20.length; j++) {
      const a = top20[i]!;
      const b = top20[j]!;
      const [lo, hi] = a < b ? [a, b] : [b, a];
      comparePairs.push({
        url: `${baseUrl}/compare/${lo}-vs-${hi}`,
        lastModified: latestDataDate,
      });
      if (comparePairs.length > SITEMAP_MAX_COMPARE_PAIRS) break outer;
    }
  }

  return [...stockRoutes, ...stockNewsRoutes, ...insiderRoutes, ...comparePairs];
}

/* --------------------------------------------------------------- reports -- */

// Historical reports have fixed publish dates; derive lastmod from the slug so
// older reports don't churn their lastmod on every regeneration.
function weeklyLastMod(slug: string): string | undefined {
  // Supports "2026-W17" or "2026-17"
  const m = /^(\d{4})-W?(\d{1,2})$/.exec(slug);
  if (!m) return undefined;
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
}

function monthlyLastMod(slug: string): string | undefined {
  const m = /^(\d{4})-(\d{1,2})$/.exec(slug);
  if (!m) return undefined;
  // First day of the following month
  return new Date(Date.UTC(parseInt(m[1]!, 10), parseInt(m[2]!, 10), 1)).toISOString();
}

function yearlyLastMod(slug: string): string | undefined {
  const m = /^(\d{4})$/.exec(slug);
  if (!m) return undefined;
  return new Date(Date.UTC(parseInt(m[1]!, 10) + 1, 0, 1)).toISOString();
}

export { weeklyLastMod, monthlyLastMod, yearlyLastMod };

/**
 * Published reports ONLY (ListReports, headline-gated in getReportsList).
 * Slugs used to be derived from the calendar (last 52 weeks), which advertised
 * URLs for weeks the generator never published — a sitemapped soft-404 whenever
 * the pipeline stalls (2026-W26..W28, July 2026). Requested PER TYPE: a
 * combined most-recent-first request hits the backend row cap and silently
 * truncates the oldest type as the archive grows. On RPC failure only the
 * /reports index is emitted: a transient regeneration without report URLs beats
 * advertising 404s.
 */
export async function buildReportsSitemap(): Promise<SitemapEntry[]> {
  let weekSlugs: string[] = [];
  let monthSlugs: string[] = [];
  let yearSlugs: string[] = [];
  try {
    if (!skipForBuild()) {
      const [weekly, monthly, yearly] = await Promise.all([
        getReportsList("weekly", 200),
        getReportsList("monthly", 100),
        getReportsList("yearly", 50),
      ]);
      weekSlugs = weekly.map((r) => r.slug);
      monthSlugs = monthly.map((r) => r.slug);
      yearSlugs = yearly.map((r) => r.slug);
    }
  } catch (error) {
    console.error("Failed to fetch report slugs for sitemap:", error);
  }

  const reports: SitemapEntry[] = [
    ...weekSlugs.map((slug) => ({
      // Canonical query-matching path; the ISO form 301s to it.
      url: `${baseUrl}${weeklyReportPath(slug)}`,
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

  // The archive indexes change when the newest report lands — not on render.
  const index: SitemapEntry = {
    url: `${baseUrl}/reports`,
    lastModified: newestLastMod(reports.map((r) => r.lastModified)),
  };
  const weeklyIndex: SitemapEntry = {
    url: `${baseUrl}/reports/weekly`,
    lastModified: newestLastMod(
      weekSlugs.map((slug) => weeklyLastMod(slug)),
    ),
  };

  return [index, weeklyIndex, ...reports];
}

/* --------------------------------------------------------------- housing -- */

/**
 * State drilldowns + priced suburbs (thin pages excluded). Suburbs are fetched
 * on the ISR-safe client, states in PARALLEL (8 sequential RPCs through the
 * shared action previously helped blow the function time limit).
 *
 * lastmod comes from each suburb's own `latestPeriod` (the Valuer-General
 * period the median price is from) — a real per-URL signal. Suburbs with no
 * price feed (QLD/WA/ACT/TAS/NT) get no lastmod rather than a borrowed one.
 */
export async function buildHousingSitemap(): Promise<SitemapEntry[]> {
  let housingStateSlugs: string[] = [];
  try {
    housingStateSlugs = await getHousingStateSlugs();
  } catch (e) {
    console.error("housing state slugs:", e);
  }

  type SuburbUrl = { state: string; suburb: string; lastModified?: string };
  const perStateEntries = new Map<string, SuburbUrl[]>();

  if (!skipForBuild()) {
    const housingClient = createClient(HousingService, connectTransport());
    const perState = await Promise.all(
      ALL_STATES.map(async (st) => {
        try {
          const res = await housingClient.listStateSuburbs({
            stateCode: st,
            query: "",
            limit: 5000,
          });
          const urls = res.suburbs
            // ONE gate, shared with the page's robots meta, so the sitemap can
            // never advertise a URL the page marks noindex. The old
            // `latestMedianPrice > 0` filter excluded every suburb in QLD, WA,
            // ACT, TAS and NT — states with no ingested Valuer-General feed —
            // regardless of how much Census and amenity content the page had.
            .filter((s) =>
              isSuburbSitemapEligible({
                salCode: s.salCode,
                salName: s.salName,
                latestMedianPrice: s.latestMedianPrice,
                population: s.population,
              }),
            )
            .map((s) => ({
              state: stateSlug(st),
              suburb: suburbSlug(s.salName, s.postcode),
              lastModified:
                s.latestPeriod && typeof s.latestPeriod.seconds === "bigint"
                  ? new Date(Number(s.latestPeriod.seconds) * 1000).toISOString()
                  : undefined,
            }));
          return [stateSlug(st), urls] as const;
        } catch (e) {
          console.error(`housing suburb urls (${st}):`, e);
          return [stateSlug(st), [] as SuburbUrl[]] as const;
        }
      }),
    );
    for (const [slug, urls] of perState) perStateEntries.set(slug, urls);
  }

  const allSuburbUrls = [...perStateEntries.values()].flat();
  const newestHousingPeriod = newestLastMod(
    allSuburbUrls.map((suburb) => suburb.lastModified),
  );

  return [
    // The housing hub's signal is the newest price period anywhere in the country.
    {
      url: `${baseUrl}/housing`,
      lastModified: newestHousingPeriod,
    },
    // Capital price routes are registry-owned like the fixed rankings. Until
    // this sitemap has a capital-series date feed, inherit the corresponding
    // state housing signal rather than inventing a separate lastmod.
    { url: `${baseUrl}/housing/capitals`, lastModified: newestHousingPeriod },
    ...CAPITALS.map((capital) => {
      const capitalStateSlug = stateSlug(capital.stateCode);
      return {
        url: `${baseUrl}/housing/capitals/${capital.slug}`,
        lastModified: newestLastMod(
          (perStateEntries.get(capitalStateSlug) ?? []).map(
            (suburb) => suburb.lastModified,
          ),
        ),
      };
    }),
    // Fixed suburb ranking pages derive from the same state payloads. The hub
    // follows the newest national price period; each ranking follows the state
    // whose suburbs it orders, so lastmod remains a real data signal.
    { url: `${baseUrl}/housing/rankings`, lastModified: newestHousingPeriod },
    ...HOUSING_RANKING_SLUGS.map((slug) => {
      const ranking = HOUSING_RANKINGS[slug]!;
      const rankingStateSlug = stateSlug(ranking.stateCode);
      return {
        url: `${baseUrl}/housing/rankings/${slug}`,
        lastModified: newestLastMod(
          (perStateEntries.get(rankingStateSlug) ?? []).map(
            (suburb) => suburb.lastModified,
          ),
        ),
      };
    }),
    // Calculators are static tools; the price-drops board is crawl-driven and
    // exposes no data date on any read path — neither fabricates a lastmod.
    { url: `${baseUrl}/housing/calculators` },
    { url: `${baseUrl}/price-drops` },
    // NOTE: /housing/suburbs is deliberately NOT listed — next.config.mjs 301s
    // it to /housing (the hub page was deprecated 2026-06-29); sitemapping it
    // would advertise a permanent redirect.
    ...housingStateSlugs.map((slug) => ({
      url: `${baseUrl}/housing/${slug}`,
      lastModified: newestLastMod(
        (perStateEntries.get(slug) ?? []).map((s) => s.lastModified),
      ),
    })),
    // Clean canonical URLs (the page resolves the SAL from the slug; ?sal= is
    // only a fast-path).
    ...allSuburbUrls.map((s) => ({
      url: `${baseUrl}/housing/${s.state}/${s.suburb}`,
      lastModified: s.lastModified,
    })),
  ];
}

/* ----------------------------------------------------------- politicians -- */

/**
 * Registers of Members'/Senators' Interests. Profiles are filtered to those
 * with at least one matched declaration, mirroring the housing-suburb filter:
 * the sitemap must never advertise a page the route marks noindex.
 *
 * THE HUB URLS ARE GATED ON THE REGISTER ACTUALLY BEING ON (§6.3 open item 2).
 * POLITICIAN_INTERESTS_ENABLED is a takedown switch: with it off the rpcs
 * return empty by design, but the routes still render — so a sitemap that
 * advertises them unconditionally hands a crawler empty pages about named
 * individuals during exactly the period someone flipped the switch to stop
 * publishing them. The gate is the DATA, not a second copy of the env var.
 *
 * No lastmod anywhere in this section: the register RPCs expose no per-record
 * revision date, and the ASIC data date this section used to borrow was pure
 * noise. (Follow-up: surface an updated_at on ListPoliticians.)
 */
export async function buildPoliticiansSitemap(): Promise<SitemapEntry[]> {
  const politicianHubs: SitemapEntry[] = [
    { url: `${baseUrl}/politicians` },
    { url: `${baseUrl}/politicians/short-interest` },
    { url: `${baseUrl}/politicians/changes` },
    // The AEC funding explorer. Gated with the other three on the REGISTER
    // actually being on, deliberately: a takedown of the register empties the
    // politician corpus every one of these hubs is reached through. It has its
    // own switch (AEC_DONATIONS_ENABLED) for a funding-specific dispute.
    { url: `${baseUrl}/politicians/donations` },
  ];

  if (skipForBuild()) return politicianHubs;

  try {
    const { getPoliticianSlugs } = await import("~/app/actions/getPoliticians");
    const slugs = (await getPoliticianSlugs()) ?? [];
    // Zero politicians means the feature is off (or the corpus is unloaded).
    // Either way there is nothing to index. Note this tests the FULL list, not
    // the hasInterests subset: a register that is on but has matched nothing
    // yet is still a real surface worth advertising.
    if (slugs.length === 0) return [];
    return politicianHubs.concat(
      slugs
        .filter((s) => s.hasInterests)
        .map((s) => ({ url: `${baseUrl}/politicians/${s.slug}` })),
    );
  } catch {
    // An OUTAGE IS NOT A TAKEDOWN. A failed call says nothing about whether the
    // feature is published, so the hubs stay and the sitemap does not silently
    // shrink because the API blipped.
    return politicianHubs;
  }
}
