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
import { IndustryIntelligenceClient } from "./industry-intelligence-client";

export const revalidate = 3600;

export const metadata: Metadata = {
  title: "Industry Intelligence | Short Interest, Top Stocks & Evidence Packs",
  description:
    "Explore ASX short-interest crowding by industry, connect sectors to top shorted stocks, and track source-ready public data signals.",
  alternates: {
    canonical: `${siteConfig.url}/industry-intelligence`,
  },
  openGraph: {
    title: "Industry Intelligence",
    description:
      "ASX industry short-interest stories with top-stock links and source-ready evidence packs.",
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
  const industries = await getIndustryData();
  const selectedIndustries = industries.slice(0, 8);
  const stockResults = await Promise.all(
    selectedIndustries.map(async (industry) => {
      const result = await getIndustryStocks(industry.slug);
      return [industry.slug, result.stocks] as const;
    }),
  );
  const stocksByIndustry = stockResults.reduce<Record<string, IndustryStockInput[]>>(
    (acc, [slug, stocks]) => {
      acc[slug] = stocks;
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
