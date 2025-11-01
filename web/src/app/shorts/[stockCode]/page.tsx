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
import { DashboardLayout } from "@/components/layouts/dashboard-layout";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "~/@/components/ui/card";
import { TrendingDown, CandlestickChart } from "lucide-react";

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
    <DashboardLayout>
      <StockStructuredData stockCode={stockCode} />
      <BreadcrumbStructuredData items={breadcrumbItems} />

      <div className="mb-4">
        <Breadcrumbs items={breadcrumbItems} />
      </div>

      <div className="grid auto-rows-min flex-1 items-start gap-4 md:gap-8 lg:grid-cols-3 xl:grid-cols-3">
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
        <div className="grid auto-rows-max items-start gap-6 lg:col-span-2">
          <Card className="border-l-4 border-l-red-500 shadow-lg hover:shadow-xl transition-all duration-300 overflow-hidden">
            <CardHeader className="pb-4 bg-gradient-to-r from-red-50/50 to-transparent dark:from-red-950/20 dark:to-transparent">
              <div className="flex items-center gap-3">
                <div className="p-2.5 bg-red-100 dark:bg-red-900/40 rounded-lg shadow-sm">
                  <TrendingDown className="h-6 w-6 text-red-600 dark:text-red-400" />
                </div>
                <div className="flex-1">
                  <CardTitle className="text-xl text-red-900 dark:text-red-100">
                    Short Position Trends
                  </CardTitle>
                  <CardDescription className="mt-1.5 text-sm">
                    Track bearish sentiment and short interest over time
                  </CardDescription>
                </div>
              </div>
            </CardHeader>
            <CardContent className="pt-2">
              <Chart stockCode={params.stockCode} />
            </CardContent>
          </Card>

          <Card className="border-l-4 border-l-blue-500 shadow-lg hover:shadow-xl transition-all duration-300 overflow-hidden">
            <CardHeader className="pb-4 bg-gradient-to-r from-blue-50/50 to-transparent dark:from-blue-950/20 dark:to-transparent">
              <div className="flex items-center gap-3">
                <div className="p-2.5 bg-blue-100 dark:bg-blue-900/40 rounded-lg shadow-sm">
                  <CandlestickChart className="h-6 w-6 text-blue-600 dark:text-blue-400" />
                </div>
                <div className="flex-1">
                  <CardTitle className="text-xl text-blue-900 dark:text-blue-100">
                    Historical Price Data
                  </CardTitle>
                  <CardDescription className="mt-1.5 text-sm">
                    View stock price movements, volume, and trading patterns
                  </CardDescription>
                </div>
              </div>
            </CardHeader>
            <CardContent className="pt-2">
              <MarketChart stockCode={params.stockCode} />
            </CardContent>
          </Card>
        </div>
      </div>
    </DashboardLayout>
  );
};

export default Page;
