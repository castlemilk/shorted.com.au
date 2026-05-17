import { type Metadata } from "next";
import Link from "next/link";
import { Database, ExternalLink, Calendar, Globe } from "lucide-react";
import { siteConfig } from "~/@/config/site";
import { DashboardLayout } from "~/@/components/layouts/dashboard-layout";
import {
  Breadcrumbs,
  BreadcrumbStructuredData,
} from "~/@/components/seo/breadcrumbs";
import { LLMMeta } from "~/@/components/seo/llm-meta";

export const metadata: Metadata = {
  title: "ASX Short Selling Datasets | Open Data Hub | Shorted",
  description:
    "Open access to ASX short selling datasets sourced from ASIC. Programmatic API endpoints with Dataset schema for Google Dataset Search. Free for research and analysis.",
  keywords: [
    "ASX dataset",
    "short selling data",
    "ASIC data download",
    "Australian stock data",
    "open finance data",
    "Dataset Search",
  ],
  openGraph: {
    title: "ASX Short Selling Datasets | Shorted",
    description:
      "Open access to ASX short selling datasets with API endpoints and Dataset schema for indexing.",
    url: `${siteConfig.url}/data`,
    siteName: siteConfig.name,
    type: "website",
    locale: "en_AU",
  },
  twitter: {
    card: "summary_large_image",
    title: "ASX Short Selling Datasets | Shorted",
    description:
      "Open access to ASX short selling datasets sourced from ASIC.",
  },
  alternates: {
    canonical: `${siteConfig.url}/data`,
    languages: {
      "en-AU": `${siteConfig.url}/data`,
      "en": `${siteConfig.url}/data`,
      "x-default": `${siteConfig.url}/data`,
    },
  },
};

export const revalidate = 86400;

interface DatasetEntry {
  slug: string;
  name: string;
  description: string;
  apiEndpoint: string;
  rpcName: string;
  temporalCoverage: string;
  keywords: string[];
  variables: Array<{ name: string; unit: string; description: string }>;
  rowCount?: string;
}

const DATASETS: DatasetEntry[] = [
  {
    slug: "top-shorts",
    name: "Top Shorted ASX Stocks",
    description:
      "Daily-updated rankings of the most shorted stocks on the Australian Securities Exchange, with current short interest percentage and historical time series. Sourced from official ASIC short position reports.",
    apiEndpoint: `${siteConfig.url}/shorts.v1alpha1.ShortedStocksService/GetTopShorts`,
    rpcName: "GetTopShorts",
    temporalCoverage: "2010-06-01/..",
    keywords: [
      "ASX top shorts",
      "short interest",
      "ASIC reports",
      "Australian stocks",
    ],
    variables: [
      { name: "productCode", unit: "ticker", description: "ASX stock code" },
      { name: "percentageShorted", unit: "PERCENT", description: "Current short interest %" },
      { name: "latestShortPosition", unit: "shares", description: "Reported short positions" },
    ],
    rowCount: "~900 stocks",
  },
  {
    slug: "historical-short-positions",
    name: "Historical ASX Short Positions Time Series",
    description:
      "Daily time-series of ASIC-reported short positions for each ASX-listed security from 2010 onwards. Includes percentage of shares on issue held short and absolute reported short positions.",
    apiEndpoint: `${siteConfig.url}/shorts.v1alpha1.ShortedStocksService/GetStockData`,
    rpcName: "GetStockData",
    temporalCoverage: "2010-06-01/..",
    keywords: [
      "historical short interest",
      "ASX time series",
      "short selling history",
    ],
    variables: [
      { name: "timestamp", unit: "ISO-8601", description: "Trading date" },
      { name: "shortPosition", unit: "PERCENT", description: "Short interest % on that date" },
    ],
    rowCount: "~2.1M rows",
  },
  {
    slug: "industry-treemap",
    name: "ASX Short Positions by Industry",
    description:
      "Industry-aggregated short positions and short-interest changes across ASX sectors over user-selected periods (3m, 6m, 1y, 2y, 5y). Useful for sector-rotation analysis and macro short-selling research.",
    apiEndpoint: `${siteConfig.url}/shorts.v1alpha1.ShortedStocksService/GetIndustryTreeMap`,
    rpcName: "GetIndustryTreeMap",
    temporalCoverage: "2010-06-01/..",
    keywords: [
      "ASX sector data",
      "industry short interest",
      "treemap",
      "sector rotation",
    ],
    variables: [
      { name: "industry", unit: "name", description: "GICS industry sector" },
      { name: "percentageChange", unit: "PERCENT", description: "Short interest change over period" },
      { name: "currentShortPosition", unit: "PERCENT", description: "Current aggregated short %" },
    ],
    rowCount: "~6,200 rows per period",
  },
  {
    slug: "stock-prices",
    name: "ASX Historical Stock Prices",
    description:
      "Daily OHLCV (open, high, low, close, volume) historical stock prices for ASX-listed securities, used alongside short position data for correlation and event-study analysis.",
    apiEndpoint: `${siteConfig.url}/marketdata.v1.MarketDataService/GetHistoricalPrices`,
    rpcName: "GetHistoricalPrices",
    temporalCoverage: "2010-01-01/..",
    keywords: [
      "ASX stock prices",
      "OHLCV",
      "historical prices",
      "Australian equities",
    ],
    variables: [
      { name: "date", unit: "ISO-8601", description: "Trading date" },
      { name: "open", unit: "AUD", description: "Opening price" },
      { name: "close", unit: "AUD", description: "Closing price" },
      { name: "adjustedClose", unit: "AUD", description: "Dividend & split adjusted close" },
      { name: "volume", unit: "shares", description: "Trading volume" },
    ],
    rowCount: "~3.7M rows",
  },
  {
    slug: "director-trades",
    name: "ASX Director Trades & Insider Activity",
    description:
      "Director and substantial-holder trades from ASX Appendix 3Y filings, tagged with stock code, trade type (buy/sell/exercise), share count and disclosed price. Useful for insider-sentiment research.",
    apiEndpoint: `${siteConfig.url}/shorts.v1alpha1.ShortedStocksService/GetDirectorTrades`,
    rpcName: "GetDirectorTrades",
    temporalCoverage: "2015-01-01/..",
    keywords: [
      "insider trading",
      "director trades",
      "ASX Appendix 3Y",
      "substantial holders",
    ],
    variables: [
      { name: "directorName", unit: "string", description: "Trading director" },
      { name: "tradeType", unit: "enum", description: "buy / sell / exercise_options" },
      { name: "sharesTraded", unit: "shares", description: "Volume of the trade" },
      { name: "totalValue", unit: "AUD", description: "Disclosed total value" },
      { name: "tradeDate", unit: "ISO-8601", description: "Trade date" },
    ],
  },
];

function buildDatasetSchema(d: DatasetEntry) {
  return {
    "@context": "https://schema.org",
    "@type": "Dataset",
    name: d.name,
    description: d.description,
    identifier: `https://shorted.com.au/data#${d.slug}`,
    url: `${siteConfig.url}/data#${d.slug}`,
    keywords: d.keywords,
    isAccessibleForFree: true,
    license: "https://creativecommons.org/licenses/by/4.0/",
    creator: {
      "@type": "Organization",
      name: siteConfig.name,
      url: siteConfig.url,
    },
    publisher: {
      "@type": "Organization",
      name: siteConfig.name,
      url: siteConfig.url,
      logo: { "@type": "ImageObject", url: siteConfig.ogImage },
    },
    sourceOrganization: {
      "@type": "Organization",
      name: "Australian Securities and Investments Commission",
      url: "https://asic.gov.au/regulatory-resources/markets/short-selling/",
    },
    inLanguage: "en-AU",
    spatialCoverage: {
      "@type": "Place",
      name: "Australia",
      address: { "@type": "PostalAddress", addressCountry: "AU" },
    },
    temporalCoverage: d.temporalCoverage,
    variableMeasured: d.variables.map((v) => ({
      "@type": "PropertyValue",
      name: v.name,
      unitText: v.unit,
      description: v.description,
    })),
    distribution: [
      {
        "@type": "DataDownload",
        contentUrl: d.apiEndpoint,
        encodingFormat: "application/json",
        description: `Connect-RPC endpoint: ${d.rpcName}. See API docs for request schema.`,
      },
    ],
  };
}

export default function DataHubPage() {
  const breadcrumbItems = [{ label: "Data", href: "/data" }];

  return (
    <DashboardLayout>
      <BreadcrumbStructuredData items={breadcrumbItems} />
      {DATASETS.map((d) => (
        <script
          key={d.slug}
          type="application/ld+json"
          dangerouslySetInnerHTML={{ __html: JSON.stringify(buildDatasetSchema(d)) }}
        />
      ))}
      <LLMMeta
        title="ASX Short Selling Open Data Hub"
        description="Catalog of open datasets for Australian short-selling research, with Dataset schema for Google Dataset Search indexing."
        keywords={[
          "ASX dataset",
          "open finance data",
          "ASIC data",
          "short selling research",
        ]}
        dataSource="ASIC short position reports + ASX Appendix 3Y filings"
        dataFrequency="daily"
        requiresAuth={false}
      />

      <section className="mb-4 flex items-center gap-3">
        <div className="rounded-lg bg-primary/10 p-2">
          <Database className="h-5 w-5 text-primary" />
        </div>
        <div>
          <h1 className="text-2xl font-bold tracking-tight md:text-3xl">
            ASX Short Selling Open Data
          </h1>
          <p className="text-sm text-muted-foreground">
            Free programmatic access to ASIC short position data, stock
            prices, and director trades. Each dataset is published with{" "}
            <code className="rounded bg-muted px-1 py-0.5 text-xs">Dataset</code>{" "}
            schema for Google Dataset Search.
          </p>
        </div>
      </section>

      <Breadcrumbs items={breadcrumbItems} />

      <div className="mt-2 grid gap-4 rounded-lg border bg-card p-4 text-sm md:grid-cols-2">
        <div className="flex items-start gap-2">
          <Calendar className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />
          <div>
            <p className="font-medium">Update cadence</p>
            <p className="text-muted-foreground">
              Daily after ASIC publication (T+4 delay).
            </p>
          </div>
        </div>
        <div className="flex items-start gap-2">
          <Globe className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />
          <div>
            <p className="font-medium">License</p>
            <p className="text-muted-foreground">
              <a
                href="https://creativecommons.org/licenses/by/4.0/"
                className="underline hover:no-underline"
                target="_blank"
                rel="noopener noreferrer"
              >
                CC-BY 4.0
              </a>{" "}
              — attribute Shorted.com.au + ASIC.
            </p>
          </div>
        </div>
      </div>

      <section className="mt-6 grid gap-4">
        {DATASETS.map((d) => (
          <article
            key={d.slug}
            id={d.slug}
            className="rounded-lg border bg-card p-5"
          >
            <div className="flex flex-wrap items-baseline justify-between gap-2">
              <h2 className="text-lg font-semibold tracking-tight">
                {d.name}
              </h2>
              {d.rowCount && (
                <span className="rounded-md bg-muted px-2 py-0.5 font-mono text-[11px] text-muted-foreground">
                  {d.rowCount}
                </span>
              )}
            </div>
            <p className="mt-2 text-sm leading-relaxed text-muted-foreground">
              {d.description}
            </p>

            <dl className="mt-4 grid grid-cols-2 gap-3 text-xs md:grid-cols-3">
              <div>
                <dt className="text-muted-foreground">Temporal coverage</dt>
                <dd className="font-mono">{d.temporalCoverage}</dd>
              </div>
              <div>
                <dt className="text-muted-foreground">RPC</dt>
                <dd className="font-mono">{d.rpcName}</dd>
              </div>
              <div>
                <dt className="text-muted-foreground">Format</dt>
                <dd className="font-mono">JSON over Connect-RPC</dd>
              </div>
            </dl>

            <details className="mt-3">
              <summary className="cursor-pointer text-xs font-medium text-muted-foreground hover:text-foreground">
                Variables ({d.variables.length})
              </summary>
              <ul className="mt-2 space-y-1 text-xs">
                {d.variables.map((v) => (
                  <li key={v.name} className="flex gap-2">
                    <code className="rounded bg-muted px-1.5 py-0.5 font-mono text-[11px]">
                      {v.name}
                    </code>
                    <span className="text-muted-foreground">{v.description}</span>
                    <span className="ml-auto font-mono text-[10px] text-muted-foreground">
                      {v.unit}
                    </span>
                  </li>
                ))}
              </ul>
            </details>

            <div className="mt-4 flex flex-wrap gap-2">
              <Link
                href="/docs/api-reference"
                className="inline-flex items-center gap-1 rounded-md border bg-background px-3 py-1.5 text-xs font-medium hover:bg-muted"
              >
                API documentation
                <ExternalLink className="h-3 w-3" />
              </Link>
              <a
                href={d.apiEndpoint}
                className="inline-flex items-center gap-1 rounded-md border bg-background px-3 py-1.5 font-mono text-[11px] hover:bg-muted"
                target="_blank"
                rel="noopener noreferrer"
              >
                {d.rpcName}
              </a>
            </div>
          </article>
        ))}
      </section>

      <p className="mt-6 text-xs text-muted-foreground">
        All datasets are derived from publicly-available sources (ASIC short
        position reports and ASX Appendix 3Y filings) and republished under
        CC-BY 4.0. When using this data in research or publications please
        cite both Shorted.com.au and ASIC.
      </p>
    </DashboardLayout>
  );
}
