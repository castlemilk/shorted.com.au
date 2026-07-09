import type { Metadata } from "next";

import { DashboardLayout } from "~/@/components/layouts/dashboard-layout";
import { siteConfig } from "~/@/config/site";
import {
  buildIndustryIntelligenceStories,
  type IndustryEvidenceRecordInput,
  type IndustryEvidenceSourceInput,
  type IndustrySummary,
  type IndustryStockInput,
} from "~/@/lib/industry-intelligence";
import {
  getIndustryData,
  getIndustryStocks,
} from "~/app/actions/industry/getIndustryData";
import { getVerifiedCompanyLogoUrls } from "~/app/actions/company-logo-availability";
import { getIndustryIntelligence } from "~/app/actions/getIndustryIntelligence";
import { getTopShortsData } from "~/app/actions/getTopShorts";
import { IndustryIntelligenceClient } from "./industry-intelligence-client";

export const revalidate = 3600;

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
}

interface PageProps {
  searchParams?: Promise<IndustrySearchParams>;
}

type IndustryEvidenceBundle = {
  sources: IndustryEvidenceSourceInput[];
  records: IndustryEvidenceRecordInput[];
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
        const result = await getIndustryIntelligence(industry.name, 24);
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
  >((acc, [slug, result]) => {
    if (
      !result ||
      (result.sources.length === 0 && result.records.length === 0)
    ) {
      return acc;
    }

    acc[slug] = {
      sources: result.sources.map((source) => ({
        sourceKey: source.sourceKey,
        displayName: source.displayName,
        publisher: source.publisher,
        sourceUrl: source.sourceUrl,
        licence: source.licence,
      })),
      records: result.records.map((record) => ({
        sourceKey: record.sourceKey,
        signalKind: record.signalKind,
        stockCode: record.stockCode,
        title: record.title,
        summary: record.summary,
        metricLabel: record.metricLabel,
        metricValue: record.hasMetricValue ? record.metricValue : null,
        unit: record.unit,
        asOf: record.asOf,
        sourceUrl: record.sourceUrl,
      })),
    };
    return acc;
  }, {});
  const stories = buildIndustryIntelligenceStories({
    industries: selectedIndustries,
    stocksByIndustry,
    asAt: todayIsoDate(),
    evidenceByIndustry,
  });

  return (
    <DashboardLayout>
      <IndustryIntelligenceClient
        stories={stories}
        initialSlug={selectedSlug}
      />
    </DashboardLayout>
  );
}
