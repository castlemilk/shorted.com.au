import type { Metadata } from "next";

import { DashboardLayout } from "~/@/components/layouts/dashboard-layout";
import { siteConfig } from "~/@/config/site";
import {
  buildIndustryIntelligenceStories,
  type IndustryStockInput,
} from "~/@/lib/industry-intelligence";
import {
  getIndustryData,
  getIndustryStocks,
} from "~/app/actions/industry/getIndustryData";
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

function todayIsoDate(): string {
  return new Date().toISOString().slice(0, 10);
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
  const stockNameByCode = new Map(
    (topShorts?.timeSeries ?? [])
      .map((stock) => [
        stock.productCode.toUpperCase(),
        stock.name.trim(),
      ] as const)
      .filter(([code, name]) => code.length > 0 && name.length > 0),
  );
  const selectedIndustries = industries.slice(0, 8);
  const stockResults = await Promise.all(
    selectedIndustries.map(async (industry) => {
      const result = await getIndustryStocks(industry.slug);
      return [industry.slug, result.stocks] as const;
    }),
  );
  const stocksByIndustry = stockResults.reduce<Record<string, IndustryStockInput[]>>(
    (acc, [slug, stocks]) => {
      acc[slug] = stocks.map((stock) => {
        const code = stock.code.toUpperCase();
        const enrichedName = stockNameByCode.get(code);

        return {
          ...stock,
          name:
            enrichedName && enrichedName.toUpperCase() !== code
              ? enrichedName
              : stock.name,
        };
      });
      return acc;
    },
    {},
  );
  const stories = buildIndustryIntelligenceStories({
    industries: selectedIndustries,
    stocksByIndustry,
    asAt: todayIsoDate(),
  });

  return (
    <DashboardLayout>
      <IndustryIntelligenceClient stories={stories} initialSlug={selectedSlug} />
    </DashboardLayout>
  );
}
