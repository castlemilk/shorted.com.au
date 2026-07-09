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
import {
  getIndustryData,
  getIndustryStocks,
} from "~/app/actions/industry/getIndustryData";
import { getVerifiedCompanyLogoUrls } from "~/app/actions/company-logo-availability";
import { getIndustryIntelligenceSnapshot } from "~/app/actions/getIndustryIntelligence";
import { getTopShortsData } from "~/app/actions/getTopShorts";
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

interface IndustrySearchParams {
  industry?: string;
  view?: string;
}

interface PageProps {
  searchParams?: Promise<IndustrySearchParams>;
}

type IndustryEvidenceBundle = {
  sources: IndustryEvidenceSourceInput[];
  records: IndustryEvidenceRecordInput[];
  timeBuckets: IndustryEvidenceTimeBucketInput[];
  entityTotals: IndustryEvidenceEntityTotalInput[];
};

type TopShortsStock = NonNullable<
  Awaited<ReturnType<typeof getTopShortsData>>
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

function createSlug(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}

function industryNameForStock(stock: TopShortsStock): string {
  const industry = stock.industry.trim();
  if (invalidIndustries.has(industry)) return "Other";
  return industry;
}

function buildIndustryDataFromTopShorts(
  stocks: TopShortsStock[],
): IndustrySummary[] {
  const grouped = new Map<
    string,
    {
      stocks: TopShortsStock[];
      totalShortPercent: number;
    }
  >();

  for (const stock of stocks) {
    const industry = industryNameForStock(stock);
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
): IndustryStockInput[] {
  return stocks
    .filter((stock) => createSlug(industryNameForStock(stock)) === industrySlug)
    .sort((a, b) => b.latestShortPosition - a.latestShortPosition)
    .slice(0, 50)
    .map((stock) => ({
      code: stock.productCode,
      name: stock.name,
      shortPercent: stock.latestShortPosition,
      change: 0,
    }));
}

export default async function IndustryIntelligencePage({
  searchParams,
}: PageProps) {
  const params: IndustrySearchParams = searchParams ? await searchParams : {};
  const selectedSlug = params.industry;
  const initialView = params.view;
  const [industries, topShorts] = await Promise.all([
    getIndustryData(),
    getTopShortsData("3m", 1000, 0).catch((error) => {
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
  const industrySource =
    industries.length > 0
      ? industries
      : buildIndustryDataFromTopShorts(topShortStocks);
  const selectedIndustries = industrySource.slice(0, 8);
  const stockResults = await Promise.all(
    selectedIndustries.map(async (industry) => {
      const result = await getIndustryStocks(industry.slug);
      return [
        industry.slug,
        result.stocks.length > 0
          ? result.stocks
          : buildIndustryStocksFromTopShorts(topShortStocks, industry.slug),
      ] as const;
    }),
  );
  const storyStockCodes = stockResults.flatMap(([, stocks]) =>
    stocks.slice(0, 10).map((stock) => stock.code.toUpperCase()),
  );
  const [logoUrlByCode, intelligenceResults] = await Promise.all([
    getVerifiedCompanyLogoUrls(storyStockCodes),
    Promise.all(
      selectedIndustries.map(async (industry) => {
        const result = await getIndustryIntelligenceSnapshot(industry.name, 50);
        return [industry.slug, result] as const;
      }),
    ),
  ]);
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
  // GetTopShorts responses with points never carry the industry field, so the
  // crowding constituents come from the page's own industry->stocks mapping
  // (the treemap join) and the per-stock points are looked up by code.
  const pointsByCode = new Map(
    topShortStocks.map((stock) => [
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
      <IndustryIntelligenceClient
        stories={stories}
        initialSlug={selectedSlug}
        initialView={initialView}
      />
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
