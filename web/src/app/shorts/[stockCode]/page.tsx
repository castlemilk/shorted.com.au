import Chart from "~/@/components/ui/chart";
import MarketChart from "~/@/components/ui/market-chart";
import CompanyProfile, {
  CompanyProfilePlaceholder,
} from "~/@/components/ui/companyProfile";
import CompanyStats, {
  CompanyStatsPlaceholder,
} from "~/@/components/ui/companyStats";
import CompanyInfo, {
  CompanyInfoPlaceholder,
} from "~/@/components/ui/companyInfo";
import { Suspense } from "react";
import { siteConfig } from "~/@/config/site";
import { type Metadata } from "next";
import { StockStructuredData } from "~/@/components/seo/structured-data";
import {
  Breadcrumbs,
  BreadcrumbStructuredData,
} from "~/@/components/seo/breadcrumbs";

interface PageProps {
  params: { stockCode: string };
}

export async function generateMetadata({
  params,
}: PageProps): Promise<Metadata> {
  const stockCode = params.stockCode.toUpperCase();

  // TODO: Fetch actual company data for richer metadata
  // const companyData = await getCompanyData(stockCode);

  return {
    title: `${stockCode} Stock Analysis - Short Position Data`,
    description: `Comprehensive analysis of ${stockCode} short positions on the ASX. View real-time charts, company profile, and short interest data for ${stockCode} shares.`,
    keywords: [
      `${stockCode} short position`,
      `${stockCode} ASX`,
      `${stockCode} stock analysis`,
      `${stockCode} short interest`,
      `${stockCode} bearish sentiment`,
      "ASX short data",
      "Australian stock analysis",
    ],
    openGraph: {
      title: `${stockCode} Short Position Analysis | ${siteConfig.name}`,
      description: `Analyze ${stockCode} short positions with real-time data and interactive charts. Discover market sentiment and trading insights.`,
      url: `${siteConfig.url}/shorts/${stockCode}`,
      type: "article",
      images: [
        {
          url: siteConfig.ogImage,
          width: 1200,
          height: 630,
          alt: `${stockCode} short position analysis`,
        },
      ],
    },
    twitter: {
      card: "summary_large_image",
      title: `${stockCode} Short Analysis`,
      description: `Real-time ${stockCode} short position data and market insights`,
    },
    alternates: {
      canonical: `${siteConfig.url}/shorts/${stockCode}`,
    },
    robots: {
      index: true,
      follow: true,
    },
  };
}
export const revalidate = 60; // revalidate the data at most every minute
const Page = async ({ params }: PageProps) => {
  const stockCode = params.stockCode.toUpperCase();

  const breadcrumbItems = [
    { label: "Stocks", href: "/shorts" },
    { label: stockCode, href: `/shorts/${stockCode}` },
  ];

  return (
    <div className="flex min-h-screen w-full flex-col bg-muted/40">
      <StockStructuredData stockCode={stockCode} />
      <BreadcrumbStructuredData items={breadcrumbItems} />

      <div className="p-4 sm:px-6">
        <Breadcrumbs items={breadcrumbItems} className="mb-4" />
      </div>

      <main className="grid auto-rows-min flex-1 items-start gap-4 mt-1 p-4 sm:px-6 sm:py-0 md:gap-8 lg:grid-cols-3 xl:grid-cols-3">
        <div className="grid items-start gap-4 md:gap-8 lg:col-span-1">
          <div className="grid  gap-4 sm:grid-cols-4 md:grid-cols-4 lg:grid-cols-4 xl:grid-cols-4">
            <Suspense fallback={<CompanyProfilePlaceholder />}>
              <CompanyProfile stockCode={params.stockCode} />
            </Suspense>
          </div>
          <div className="grid gap-4 sm:grid-cols-4 md:grid-cols-4 lg:grid-cols-4 xl:grid-cols-4">
            <Suspense fallback={<CompanyStatsPlaceholder />}>
              <CompanyStats stockCode={params.stockCode} />
            </Suspense>
          </div>
          <div className="grid gap-4 sm:grid-cols-4 md:grid-cols-4 lg:grid-cols-4 xl:grid-cols-4">
            <Suspense fallback={<CompanyInfoPlaceholder />}>
              <CompanyInfo stockCode={params.stockCode} />
            </Suspense>
          </div>
        </div>
        <div className="grid auto-rows-max items-start gap-4 lg:col-span-2">
          <div>
            <h2 className="text-lg font-semibold mb-2">Short Position Trends</h2>
            <Chart stockCode={params.stockCode} />
          </div>
          <div className="mt-6">
            <h2 className="text-lg font-semibold mb-2">Historical Price Data</h2>
            <MarketChart stockCode={params.stockCode} />
          </div>
        </div>
      </main>
    </div>
  );
};

export default Page;
