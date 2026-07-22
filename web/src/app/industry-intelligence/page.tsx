import type { Metadata } from "next";

import { DashboardLayout } from "~/@/components/layouts/dashboard-layout";
import { BreadcrumbListSchema } from "~/@/components/seo/enhanced-structured-data";
import { LLMMeta } from "~/@/components/seo/llm-meta";
import { siteConfig } from "~/@/config/site";
import {
  buildIndustryCrowdingSeries,
  buildIndustryIntelligenceStories,
  type IndustryCrowdingSeries,
  type IndustryEvidenceEntityTotalInput,
  type IndustryEvidenceRecordInput,
  type IndustryEvidenceSourceInput,
  type IndustryEvidenceTimeBucketInput,
  type IndustrySummary,
  type IndustryStockInput,
} from "~/@/lib/industry-intelligence";
import { createSlug } from "~/@/lib/industry-slug";
import {
  getIndustryData,
  getIndustryStocks,
} from "~/app/actions/industry/getIndustryData";
import { getVerifiedCompanyLogoUrls } from "~/app/actions/company-logo-availability";
import { getIndustryIntelligenceSnapshot } from "~/app/actions/getIndustryIntelligence";
import { getTopShortsByCodes, getTopShortsSummary } from "~/app/actions/getTopShorts";
import {
  buildApiUrl,
  getServerShortsApiUrl,
  serverFetchWithUserAgent,
} from "~/app/actions/config";
import { IndustryIntelligenceClient } from "./industry-intelligence-client";

export const revalidate = 3600;
// Cold renders fan out to the shorts backend (top-shorts series + per-industry
// evidence); a cold Cloud Run start must not push us past the default function
// budget and 504.
export const maxDuration = 60;

export const metadata: Metadata = {
  title: "Industry Intelligence | Short Interest & Top Stocks",
  description:
    "Explore ASX short-interest crowding by industry, connect sectors to top shorted stocks, and create alert monitors.",
  alternates: {
    canonical: `${siteConfig.url}/industry-intelligence`,
  },
  openGraph: {
    title: "Industry Intelligence",
    description:
      "ASX industry short-interest stories with ranked company links and alert entry points.",
    url: `${siteConfig.url}/industry-intelligence`,
    siteName: siteConfig.name,
    type: "website",
    locale: "en_AU",
  },
};

type IndustryEvidenceBundle = {
  sources: IndustryEvidenceSourceInput[];
  records: IndustryEvidenceRecordInput[];
  timeBuckets: IndustryEvidenceTimeBucketInput[];
  entityTotals: IndustryEvidenceEntityTotalInput[];
};

type TopShortsStock = NonNullable<
  Awaited<ReturnType<typeof getTopShortsSummary>>
>["timeSeries"][number];

const invalidIndustries = new Set([
  "Class Pend",
  "Not Applic",
  "Not Applicable",
  "",
]);

function todayIsoDate(): string {
  return new Date().toISOString().slice(0, 10);
}

function industryNameForStock(
  stock: TopShortsStock,
  industryByCode?: Map<string, string>,
): string {
  // Points-mode GetTopShorts responses never carry the industry field, so
  // prefer the summary-mode lookup map when the caller provides one.
  const industry = (
    industryByCode?.get(stock.productCode.toUpperCase()) ??
    stock.industry ??
    ""
  ).trim();
  if (invalidIndustries.has(industry)) return "Other";
  return industry;
}

// Fallback industry lookup for when getIndustryData() returns empty: a
// summary-mode GetTopShorts (mv_top_shorts) DOES carry industry per stock.
// Without this map the fallback grouping below put every stock in "Other"
// (the July 2026 /industry-intelligence regression). ISR-safe cache mode is
// required — a no-store POST throws inside this revalidate-cached route.
async function fetchIndustryByCode(): Promise<Map<string, string>> {
  const map = new Map<string, string>();
  try {
    const resp = await serverFetchWithUserAgent(
      buildApiUrl(
        getServerShortsApiUrl(),
        "/shorts.v1alpha1.ShortedStocksService/GetTopShorts",
      ),
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Connect-Protocol-Version": "1",
        },
        body: JSON.stringify({
          period: "1y",
          limit: 1000,
          offset: 0,
          summaryOnly: true,
        }),
        next: { revalidate: 1800 },
      },
    );
    if (resp.ok) {
      const data = (await resp.json()) as {
        timeSeries?: Array<{ productCode?: string; industry?: string }>;
      };
      for (const ts of data.timeSeries ?? []) {
        if (ts.productCode && ts.industry) {
          map.set(ts.productCode.toUpperCase(), ts.industry);
        }
      }
    }
  } catch (error) {
    console.warn("IndustryIntelligencePage: industry lookup failed:", error);
  }
  return map;
}

function buildIndustryDataFromTopShorts(
  stocks: TopShortsStock[],
  industryByCode: Map<string, string>,
): IndustrySummary[] {
  const grouped = new Map<
    string,
    {
      stocks: TopShortsStock[];
      totalShortPercent: number;
    }
  >();

  for (const stock of stocks) {
    const industry = industryNameForStock(stock, industryByCode);
    const group = grouped.get(industry) ?? {
      stocks: [],
      totalShortPercent: 0,
    };
    group.stocks.push(stock);
    group.totalShortPercent += stock.latestShortPosition;
    grouped.set(industry, group);
  }

  return Array.from(grouped.entries())
    .map(([name, group]) => {
      const sortedStocks = [...group.stocks].sort(
        (a, b) => b.latestShortPosition - a.latestShortPosition,
      );
      const topStock = sortedStocks[0];

      return {
        name,
        slug: createSlug(name),
        stockCount: sortedStocks.length,
        avgShortPercent:
          sortedStocks.length > 0
            ? group.totalShortPercent / sortedStocks.length
            : 0,
        totalShortPercent: group.totalShortPercent,
        topStock: topStock
          ? {
              code: topStock.productCode,
              name: topStock.name,
              shortPercent: topStock.latestShortPosition,
            }
          : null,
      };
    })
    .sort((a, b) => b.stockCount - a.stockCount);
}

function buildIndustryStocksFromTopShorts(
  stocks: TopShortsStock[],
  industrySlug: string,
  industryByCode: Map<string, string>,
): IndustryStockInput[] {
  return stocks
    .filter(
      (stock) =>
        createSlug(industryNameForStock(stock, industryByCode)) ===
        industrySlug,
    )
    .sort((a, b) => b.latestShortPosition - a.latestShortPosition)
    .slice(0, 50)
    .map((stock) => ({
      code: stock.productCode,
      name: stock.name,
      shortPercent: stock.latestShortPosition,
      change: 0,
    }));
}

export default async function IndustryIntelligencePage() {
  // Deep-link params (?industry=&view=) are applied CLIENT-side after
  // hydration (see IndustryIntelligenceClient): awaiting searchParams here
  // would silently opt the whole route out of ISR and re-run this fan-out on
  // every request.
  const [industries, topShorts] = await Promise.all([
    getIndustryData(),
    // summary_only: names + industry + latest short position for the top 1000,
    // WITHOUT time-series points (~102KB vs ~3.19MB for the full 2y×1000 fetch).
    // The crowding points are fetched separately below, scoped to just the
    // charted constituents — this call no longer carries 45k discarded points.
    getTopShortsSummary("2y", 1000).catch((error) => {
      console.warn(
        "IndustryIntelligencePage: top-shorts name enrichment failed:",
        error,
      );
      return null;
    }),
  ]);
  const topShortStocks = topShorts?.timeSeries ?? [];
  const stockNameByCode = new Map(
    topShortStocks
      .map(
        (stock) =>
          [stock.productCode.toUpperCase(), stock.name.trim()] as const,
      )
      .filter(([code, name]) => code.length > 0 && name.length > 0),
  );
  // Fallback path: only consulted when getIndustryData() came back empty.
  // The lookup map is required because points-mode responses lack industry.
  const industryByCode =
    industries.length > 0 ? new Map<string, string>() : await fetchIndustryByCode();
  const industrySource =
    industries.length > 0
      ? industries
      : buildIndustryDataFromTopShorts(topShortStocks, industryByCode);
  const selectedIndustries = industrySource.slice(0, 8);
  // Evidence snapshots only need industry NAMES — start them now, in
  // parallel with the per-industry stock fetches, instead of gating them
  // behind that whole phase (each serialized phase is seconds on a cold
  // backend).
  const intelligencePromise = Promise.all(
    selectedIndustries.map(async (industry) => {
      const result = await getIndustryIntelligenceSnapshot(industry.name, 50);
      return [industry.slug, result] as const;
    }),
  );
  const stockResults = await Promise.all(
    selectedIndustries.map(async (industry) => {
      const result = await getIndustryStocks(industry.slug);
      return [
        industry.slug,
        result.stocks.length > 0
          ? result.stocks
          : buildIndustryStocksFromTopShorts(
              topShortStocks,
              industry.slug,
              industryByCode,
            ),
      ] as const;
    }),
  );
  const storyStockCodes = stockResults.flatMap(([, stocks]) =>
    stocks.slice(0, 10).map((stock) => stock.code.toUpperCase()),
  );
  // Every charted crowding constituent (all industries × their stocks). The
  // points fetch is scoped to just these codes instead of pulling all ~1000
  // top-shorts stocks' series (~1.6MB vs ~3.19MB), and runs in parallel with
  // the logo + evidence fan-out rather than blocking wave 1.
  const constituentCodes = Array.from(
    new Set(
      stockResults.flatMap(([, stocks]) =>
        stocks.map((stock) => stock.code.toUpperCase()),
      ),
    ),
  );
  const [logoUrlByCode, intelligenceResults, crowdingPoints] = await Promise.all([
    getVerifiedCompanyLogoUrls(storyStockCodes),
    intelligencePromise,
    getTopShortsByCodes("2y", constituentCodes).catch((error) => {
      console.warn(
        "IndustryIntelligencePage: crowding points fetch failed:",
        error,
      );
      return null;
    }),
  ]);
  const crowdingStocks = crowdingPoints?.timeSeries ?? [];
  const stocksByIndustry = stockResults.reduce<
    Record<string, IndustryStockInput[]>
  >((acc, [slug, stocks]) => {
    acc[slug] = stocks.map((stock) => {
      const code = stock.code.toUpperCase();
      const enrichedName = stockNameByCode.get(code);

      return {
        ...stock,
        logoUrl: logoUrlByCode.get(code) ?? null,
        name:
          enrichedName && enrichedName.toUpperCase() !== code
            ? enrichedName
            : stock.name,
      };
    });
    return acc;
  }, {});
  const evidenceByIndustry = intelligenceResults.reduce<
    Record<string, IndustryEvidenceBundle>
  >((acc, [slug, snapshot]) => {
    if (!snapshot) return acc;
    acc[slug] = snapshot;
    return acc;
  }, {});
  // Crowding constituents come from the page's own industry->stocks mapping
  // (the treemap join); their per-stock points come from the code-scoped
  // GetTopShorts fetch above (points-mode responses never carry the industry).
  const pointsByCode = new Map(
    crowdingStocks.map((stock) => [
      stock.productCode.toUpperCase(),
      (stock.points ?? [])
        .map((point) => ({
          date: timestampToIsoDate(point.timestamp),
          value: point.shortPosition,
        }))
        .filter((point) => point.date !== ""),
    ]),
  );
  const crowdingByIndustry = selectedIndustries.reduce<
    Record<string, IndustryCrowdingSeries | null>
  >((acc, industry) => {
    const stocks = (stocksByIndustry[industry.slug] ?? [])
      .map((stock) => ({
        code: stock.code.toUpperCase(),
        points: pointsByCode.get(stock.code.toUpperCase()) ?? [],
      }))
      .filter((stock) => stock.points.length > 0);
    acc[industry.slug] = buildIndustryCrowdingSeries(stocks);
    return acc;
  }, {});
  const stories = buildIndustryIntelligenceStories({
    industries: selectedIndustries,
    stocksByIndustry,
    asAt: todayIsoDate(),
    evidenceByIndustry,
    crowdingByIndustry,
  });

  return (
    <DashboardLayout>
      <LLMMeta
        title="Industry Intelligence"
        description="ASX industry short-interest crowding with cited public-source evidence: ATO corporate tax, AusTender contracts, and NGER emissions for exact-matched entities."
        keywords={[
          "ASX short interest by industry",
          "industry short selling",
          "corporate tax transparency ASX",
          "government contracts ASX companies",
        ]}
        url={`${siteConfig.url}/industry-intelligence`}
        dataSource="ASIC short position reports; ATO Corporate Tax Transparency; AusTender; Clean Energy Regulator NGER"
        dataFrequency="daily"
        requiresAuth={false}
      />
      <BreadcrumbListSchema
        items={[
          { name: "Home", url: siteConfig.url },
          {
            name: "Industry Intelligence",
            url: `${siteConfig.url}/industry-intelligence`,
          },
        ]}
      />
      <IndustryIntelligenceClient stories={stories} />
    </DashboardLayout>
  );
}

/**
 * Time-series points arrive as ISO strings from the edge-read JSON path and as
 * protobuf Timestamp objects from the Connect fallback — normalise both.
 */
function timestampToIsoDate(timestamp: unknown): string {
  if (typeof timestamp === "string") return timestamp.slice(0, 10);
  if (
    timestamp &&
    typeof timestamp === "object" &&
    "seconds" in timestamp &&
    timestamp.seconds != null
  ) {
    const seconds = Number((timestamp as { seconds: unknown }).seconds);
    if (Number.isFinite(seconds) && seconds > 0) {
      return new Date(seconds * 1000).toISOString().slice(0, 10);
    }
  }
  return "";
}
