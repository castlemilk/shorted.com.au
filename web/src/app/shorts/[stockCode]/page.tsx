import dynamic from "next/dynamic";
import { type Metadata } from "next";
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
import CompanyFinancials,{
  CompanyFinancialsPlaceholder,
} from "~/@/components/ui/companyFinancials";
import { EnrichedCompanySection } from "~/@/components/company/enriched-company-section";

// Dynamic import to avoid SSR issues — child components import @connectrpc/connect
const StockTabs = dynamic(
  () => import("~/@/components/company/stock-tabs").then((m) => m.StockTabs),
  { ssr: false }
);
import { Suspense } from "react";
import { StockStructuredData } from "~/@/components/seo/structured-data";
import {
  Breadcrumbs,
  BreadcrumbStructuredData,
} from "~/@/components/seo/breadcrumbs";
import { LLMMeta, StockLLMMeta } from "~/@/components/seo/llm-meta";
import { DashboardLayout } from "~/@/components/layouts/dashboard-layout";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "~/@/components/ui/card";
import { TrendingDown, CandlestickChart } from "lucide-react";
import { siteConfig } from "~/@/config/site";
import { RelatedStocks } from "~/@/components/seo/related-stocks";
import { getRelatedStocks } from "~/app/actions/getRelatedStocks";
import { createConnectTransport } from "@connectrpc/connect-web";
import { createClient } from "@connectrpc/connect";
import { ShortedStocksService } from "~/gen/shorts/v1alpha1/shorts_pb";
import { getStock } from "~/app/actions/getStock";

/**
 * Pre-generate ALL stocks with non-zero short positions at build time (~940 stocks).
 * This ensures every actively-shorted stock is crawlable by Google on first visit.
 * The mv_top_shorts materialized view contains all stocks with short_position > 0.
 */
export async function generateStaticParams(): Promise<{ stockCode: string }[]> {
  try {
    const transport = createConnectTransport({
      baseUrl:
        process.env.NEXT_PUBLIC_SHORTS_SERVICE_ENDPOINT ??
        process.env.NEXT_PUBLIC_API_URL ??
        "http://localhost:9091",
    });

    const client = createClient(ShortedStocksService, transport);

    // Fetch all actively-shorted stocks (mv_top_shorts has ~940 rows)
    const response = await client.getTopShorts({
      period: "max",
      limit: 1000,
      offset: 0,
    });

    const stockCodes = response.timeSeries
      .map((ts) => ts.productCode)
      .filter((code): code is string => !!code && /^[A-Z0-9]{1,4}$/.test(code));

    // Return unique stock codes
    return [...new Set(stockCodes)].map((code) => ({
      stockCode: code,
    }));
  } catch (error) {
    console.error("Failed to fetch stock codes for static generation:", error);
    // Fallback to most popular stocks if API fails
    const fallbackStocks = [
      "CBA", "BHP", "CSL", "NAB", "WBC", "ANZ", "WES", "MQG", "WOW", "TLS",
      "RIO", "FMG", "GMG", "TCL", "WDS", "NCM", "ALL", "COL", "REA", "QBE",
    ];
    return fallbackStocks.map((code) => ({ stockCode: code }));
  }
}

interface PageProps {
  params: Promise<{ stockCode: string }>;
}

export async function generateMetadata({ params }: PageProps): Promise<Metadata> {
  const { stockCode } = await params;
  const code = stockCode.toUpperCase();

  // Try to fetch stock data for enriched metadata
  let title = `${code} Short Position | Official ASIC Data (T+4)`;
  let description = `${code} short selling data from official ASIC reports. Current short interest %, historical trends, charts & analysis. Updated daily with T+4 delay. Free ASX short position tracking.`;

  try {
    const stock = await getStock(code);
    if (stock) {
      const companyName = stock.name ? `(${stock.name})` : "";
      const shortPct = stock.percentageShorted > 0 ? ` | ${stock.percentageShorted.toFixed(2)}% Shorted` : "";
      title = `${code} ${companyName} Short Position${shortPct} | ASIC Data`;

      const dateStr = new Date().toLocaleDateString("en-AU", {
        month: "short",
        day: "numeric",
        year: "numeric",
      });
      const shortInfo = stock.percentageShorted > 0
        ? `${stock.name || code} has ${stock.percentageShorted.toFixed(2)}% of shares sold short as of ${dateStr}.`
        : `${stock.name || code} short selling data from official ASIC reports.`;
      const industryInfo = stock.industry ? ` Industry: ${stock.industry}.` : "";
      description = `${shortInfo}${industryInfo} Track ${code}'s short position history, price charts, peer comparison, and ASIC data. Updated daily with T+4 delay.`;
    }
  } catch {
    // Fall back to default title/description if fetch fails
  }

  return {
    title,
    description,
    keywords: [
      `${code} short position`,
      `${code} short interest`,
      `${code} ASX short selling`,
      `${code} ASIC data`,
      `${code} stock analysis`,
      `${code} bearish sentiment`,
      `how much is ${code} shorted`,
      `${code} short squeeze`,
      "ASIC short position reports",
      "ASX short selling data",
      "Australian stocks short interest",
    ],
    openGraph: {
      title: `${title} | ${siteConfig.name}`,
      description,
      url: `${siteConfig.url}/shorts/${code}`,
      siteName: siteConfig.name,
      type: "article",
      locale: "en_AU",
    },
    twitter: {
      card: "summary_large_image",
      title: `${title} | ${siteConfig.name}`,
      description,
    },
    alternates: {
      canonical: `${siteConfig.url}/shorts/${code}`,
      languages: {
        "en-AU": `${siteConfig.url}/shorts/${code}`,
        "en": `${siteConfig.url}/shorts/${code}`,
        "x-default": `${siteConfig.url}/shorts/${code}`,
      },
    },
  };
}

// ISR: revalidate daily. On-demand revalidation via /api/revalidate?scope=all after daily sync.
export const revalidate = 86400;

const Chart = dynamic(() => import("~/@/components/ui/chart"), {
  ssr: false,
  loading: () => <ChartSkeleton />,
});

const Page = async ({ params }: PageProps) => {
  const { stockCode: rawStockCode } = await params;
  // This page is public for SEO and discovery - no authentication required
  const stockCode = rawStockCode.toUpperCase();

  // Fetch stock data for StockLLMMeta and related stocks in parallel
  // Both use withRetryAndNotFound, so they return undefined on failure
  let stock: Awaited<ReturnType<typeof getStock>> = undefined;
  let relatedData: Awaited<ReturnType<typeof getRelatedStocks>>;
  try {
    [stock, relatedData] = await Promise.all([
      getStock(stockCode),
      getRelatedStocks(stockCode),
    ]);
  } catch {
    // Fallback if parallel fetch fails during static generation
    relatedData = { stocks: [], industry: null, industrySlug: null };
  }

  const breadcrumbItems = [
    { label: "Stocks", href: "/stocks" },
    { label: stockCode, href: `/shorts/${stockCode}` },
  ];

  return (
    <DashboardLayout>
      <StockStructuredData stockCode={stockCode} />
      <BreadcrumbStructuredData items={breadcrumbItems} />
      <LLMMeta
        title={`${stockCode} Stock Analysis - Short Position Data`}
        description={`Comprehensive analysis of ${stockCode} short positions on the ASX. View real-time charts, company profile, and short interest data for ${stockCode} shares.`}
        keywords={[
          `${stockCode} short position`,
          `${stockCode} ASX`,
          `${stockCode} stock analysis`,
          `${stockCode} short interest`,
          "short selling data",
          "Australian stocks",
        ]}
        dataSource="ASIC"
        dataFrequency="daily"
        requiresAuth={false}
      />
      {stock && (
        <StockLLMMeta
          stockCode={stockCode}
          companyName={stock.name || stockCode}
          industry={stock.industry || ""}
          sector={stock.industry || ""}
          shortPercentage={stock.percentageShorted || undefined}
          currentShortPosition={stock.reportedShortPositions || undefined}
        />
      )}

      <div className="mb-4">
        <Breadcrumbs items={breadcrumbItems} />
      </div>

      {/* Header: Profile & Stats (always visible above tabs) */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4 md:gap-6 items-start mb-6">
        <div className="md:col-span-2">
          <Suspense fallback={<CompanyProfilePlaceholder />}>
            <CompanyProfile stockCode={stockCode} />
          </Suspense>
        </div>
        <div className="md:col-span-1 h-full">
          <Suspense fallback={<CompanyStatsPlaceholder />}>
            <CompanyStats stockCode={stockCode} />
          </Suspense>
        </div>
      </div>

      {/* Tabbed content area */}
      <StockTabs
        stockCode={stockCode}
        overviewContent={
          <div className="grid grid-cols-1 md:grid-cols-3 gap-4 md:gap-6 items-start">
            <div className="md:col-span-1 flex flex-col gap-4 md:gap-6">
              <Suspense fallback={<CompanyInfoPlaceholder />}>
                <CompanyInfo stockCode={stockCode} />
              </Suspense>

              {/* Related stocks for internal linking */}
              {relatedData.stocks.length > 0 && (
                <RelatedStocks
                  stocks={relatedData.stocks}
                  currentStock={stockCode}
                  industrySlug={relatedData.industrySlug}
                  title={`More ${relatedData.industry} Stocks`}
                  description="Other shorted stocks in this sector"
                />
              )}
            </div>

            <div className="md:col-span-2 flex flex-col gap-4 md:gap-6">
              {/* Short Position Trends */}
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
                  <Chart stockCode={stockCode} />
                </CardContent>
              </Card>

              {/* Historical Price Data */}
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
                  <MarketChart stockCode={stockCode} />
                </CardContent>
              </Card>

              {/* Enriched Company Insights */}
              <EnrichedCompanySection stockCode={stockCode} />
            </div>
          </div>
        }
        financialsContent={
          <div className="flex flex-col gap-4 md:gap-6">
            <Suspense fallback={<CompanyFinancialsPlaceholder />}>
              <CompanyFinancials stockCode={stockCode} />
            </Suspense>
            <EnrichedCompanySection stockCode={stockCode} />
          </div>
        }
      />
    </DashboardLayout>
  );
};

export default Page;

const ChartSkeleton = () => (
  <div className="grid">
    <div className="flex flex-row-reverse">
      <div className="flex">
        <div className="h-10 w-[60px] ml-2 rounded bg-muted animate-pulse" />
        <div className="h-10 w-[60px] ml-2 rounded bg-muted animate-pulse" />
      </div>
      <div className="flex space-x-2">
        {Array.from({ length: 8 }).map((_, idx) => (
          <div key={idx} className="h-10 w-12 rounded bg-muted animate-pulse" />
        ))}
      </div>
    </div>
    <div>
      <div className="h-[500px] min-h-[500px] w-full mt-2 rounded bg-muted animate-pulse" />
    </div>
  </div>
);
