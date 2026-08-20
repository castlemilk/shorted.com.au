import { type Metadata } from "next";
import { pageTitle } from "~/@/lib/typography";
import Link from "next/link";
import { Briefcase } from "lucide-react";
import { siteConfig } from "~/@/config/site";
import { DashboardLayout } from "~/@/components/layouts/dashboard-layout";
import {
  Breadcrumbs,
  BreadcrumbStructuredData,
} from "~/@/components/seo/breadcrumbs";
import { LLMMeta } from "~/@/components/seo/llm-meta";
import { getTopShortsData } from "~/app/actions/getTopShorts";

export const metadata: Metadata = {
  title: "ASX Insider Trading & Director Trades | Shorted",
  description:
    "Track director and insider share dealings on the Australian Securities Exchange. Per-stock trade history, ASX Appendix 3Y filings, and insider sentiment.",
  keywords: [
    "ASX insider trading",
    "ASX director trades",
    "Appendix 3Y",
    "director buying ASX",
    "director selling ASX",
    "insider sentiment Australia",
  ],
  openGraph: {
    title: "ASX Insider Trading & Director Trades | Shorted",
    description:
      "Director and insider trades across the ASX, sourced from Appendix 3Y filings.",
    url: `${siteConfig.url}/insider-trading`,
    siteName: siteConfig.name,
    type: "website",
    locale: "en_AU",
  },
  twitter: {
    site: "@shorted___",
    creator: "@shorted___",
    card: "summary_large_image",
    title: "ASX Insider Trading & Director Trades | Shorted",
    description:
      "Director and insider trades across the ASX.",
  },
  alternates: {
    canonical: `${siteConfig.url}/insider-trading`,
    languages: {
      "en-AU": `${siteConfig.url}/insider-trading`,
      "en": `${siteConfig.url}/insider-trading`,
      "x-default": `${siteConfig.url}/insider-trading`,
    },
  },
};

export const revalidate = 3600;

export default async function InsiderTradingHubPage() {
  // Seed the hub with the most-shorted stocks — those are the highest-
  // traffic surfaces and most likely to have actionable insider activity.
  let stocks: Array<{ productCode: string; name: string }> = [];
  try {
    const response = await getTopShortsData("max", 60, 0);
    if (response) {
      stocks = response.timeSeries
        .map((ts) => ({
          productCode: ts.productCode ?? "",
          name: ts.name ?? "",
        }))
        .filter((s) => /^[A-Z0-9]{1,4}$/.test(s.productCode));
    }
  } catch {
    stocks = [];
  }

  const breadcrumbItems = [{ label: "Insider Trading", href: "/insider-trading" }];

  const collectionSchema = {
    "@context": "https://schema.org",
    "@type": "CollectionPage",
    name: "ASX Insider Trading & Director Trades",
    description:
      "Index of ASX-listed stocks with director trades and insider activity tracking.",
    url: `${siteConfig.url}/insider-trading`,
    isPartOf: {
      "@type": "WebSite",
      name: "Shorted",
      url: siteConfig.url,
    },
    mainEntity: {
      "@type": "ItemList",
      itemListElement: stocks.slice(0, 30).map((s, i) => ({
        "@type": "ListItem",
        position: i + 1,
        url: `${siteConfig.url}/insider-trading/${s.productCode}`,
        name: `${s.name || s.productCode} Insider Trading`,
      })),
    },
  };

  return (
    <DashboardLayout>
      <BreadcrumbStructuredData items={breadcrumbItems} />
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: JSON.stringify(collectionSchema) }}
      />
      <LLMMeta
        title="ASX Insider Trading & Director Trades Hub"
        description="Index of ASX stocks with director trades sourced from Appendix 3Y filings, including buy/sell/exercise activity."
        keywords={[
          "ASX insider trading",
          "director trades",
          "Appendix 3Y",
        ]}
        dataSource="ASX Appendix 3Y filings"
        dataFrequency="daily"
        requiresAuth={false}
      />

      <section className="mb-4 flex items-center gap-3">
        <div className="rounded-lg bg-primary/10 p-2">
          <Briefcase className="h-5 w-5 text-primary" />
        </div>
        <div>
          <h1 className={pageTitle}>
            ASX Insider Trading & Director Trades
          </h1>
          <p className="text-sm text-muted-foreground">
            Pick a stock to view its director-trade history sourced from ASX
            Appendix 3Y filings. Coverage focuses on the most-shorted ASX
            stocks where insider activity matters most.
          </p>
        </div>
      </section>

      <Breadcrumbs items={breadcrumbItems} />

      {stocks.length === 0 ? (
        <p className="mt-6 rounded-lg border bg-muted/30 p-8 text-center text-sm text-muted-foreground">
          Unable to load stock list right now — please try again shortly.
        </p>
      ) : (
        <ul className="mt-6 grid gap-2 md:grid-cols-2 xl:grid-cols-3">
          {stocks.map((s) => (
            <li key={s.productCode}>
              <Link
                href={`/insider-trading/${s.productCode}`}
                className="group flex items-center gap-3 rounded-lg border bg-card p-3 transition-[border-color,box-shadow] duration-200 ease-out hover:border-primary/40 hover:shadow-md"
              >
                <span className="rounded-md bg-muted px-2 py-1 font-mono text-xs font-semibold tracking-wide">
                  {s.productCode}
                </span>
                <span className="truncate text-sm font-medium group-hover:text-primary">
                  {s.name || s.productCode}
                </span>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </DashboardLayout>
  );
}
