import { type Metadata } from "next";
import Link from "next/link";
import Image from "next/image";
import { TrendingDown, ChevronRight } from "lucide-react";
import { siteConfig } from "~/@/config/site";
import { DashboardLayout } from "~/@/components/layouts/dashboard-layout";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "~/@/components/ui/card";
import { Badge } from "~/@/components/ui/badge";
import { BreadcrumbListSchema } from "~/@/components/seo/enhanced-structured-data";
import { getIndustryData } from "../actions/industry/getIndustryData";
import { getSectorImagePath, getSectorImageAlt } from "~/@/lib/sector-images";

export const metadata: Metadata = {
  title: "ASX Short Positions by Industry | Sector Analysis",
  description:
    "Explore short selling activity across ASX industry sectors. Compare short interest levels in Mining, Financials, Energy, Healthcare, Technology and more. Official ASIC data.",
  keywords: [
    "ASX industry short positions",
    "sector short selling",
    "most shorted industry ASX",
    "mining stocks short interest",
    "financial stocks short selling",
    "energy sector shorts",
    "ASX sector analysis",
    "industry short interest comparison",
  ],
  openGraph: {
    title: "ASX Short Positions by Industry | Sector Analysis",
    description:
      "Explore short selling activity across ASX industry sectors. Official ASIC data updated daily.",
    url: `${siteConfig.url}/industry`,
    siteName: siteConfig.name,
    type: "website",
    locale: "en_AU",
  },
  twitter: {
    card: "summary_large_image",
    title: "ASX Short Positions by Industry | Sector Analysis",
    description:
      "Explore short selling activity across ASX industry sectors.",
  },
  alternates: {
    canonical: `${siteConfig.url}/industry`,
  },
};

// Force dynamic rendering — this page requires a live backend for data
export const dynamic = "force-dynamic";
export const revalidate = 3600;

const breadcrumbs = [
  { name: "Home", url: siteConfig.url },
  { name: "Industries", url: `${siteConfig.url}/industry` },
];

export default async function IndustryIndexPage() {
  const industryData = await getIndustryData();

  // CollectionPage + ItemList — exposes every industry/sector as a
  // structured child so crawlers can ingest the sector taxonomy.
  const itemList = {
    "@context": "https://schema.org",
    "@type": "CollectionPage",
    name: "ASX Short Positions by Industry",
    description:
      "Short selling activity across ASX industry sectors. Aggregated short interest, ranked stock lists, and sector trends from official ASIC data.",
    url: "https://shorted.com.au/industry",
    isPartOf: {
      "@type": "WebSite",
      name: "Shorted",
      url: "https://shorted.com.au",
    },
    mainEntity: {
      "@type": "ItemList",
      numberOfItems: industryData.length,
      itemListElement: industryData.map((industry, i) => ({
        "@type": "ListItem",
        position: i + 1,
        url: `https://shorted.com.au/industry/${industry.slug}`,
        name: `${industry.name} — ASX Short Positions`,
      })),
    },
  };

  return (
    <DashboardLayout>
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: JSON.stringify(itemList) }}
      />
      <BreadcrumbListSchema items={breadcrumbs} />

      <div className="space-y-8">
        {/* Hero Section */}
        <section className="relative border-b border-border/40 pb-8">
          <div className="flex items-center gap-3 mb-4">
            <div className="h-10 w-1 bg-gradient-to-b from-blue-500 to-purple-500 rounded-full" />
            <h1 className="text-3xl md:text-4xl font-bold tracking-tight">
              Short Positions by Industry
            </h1>
          </div>
          <p className="text-muted-foreground text-lg max-w-2xl">
            Explore short selling activity across different ASX industry sectors.
            Click on any industry to see the most shorted stocks in that sector.
          </p>
        </section>

        {/* Industry Grid */}
        <section className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
          {industryData.map((industry) => (
            <Link
              key={industry.slug}
              href={`/industry/${industry.slug}`}
              className="group"
            >
              <Card className="h-full hover:shadow-md transition-all duration-200 hover:border-primary/50">
                <CardHeader className="pb-3">
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-3">
                      <div className="relative h-16 w-16 flex-shrink-0">
                        <Image
                          src={getSectorImagePath(industry.name)}
                          alt={getSectorImageAlt(industry.name)}
                          width={64}
                          height={64}
                          className="rounded-lg object-contain drop-shadow-sm"
                        />
                      </div>
                      <div>
                        <CardTitle className="text-lg group-hover:text-primary transition-colors">
                          {industry.name}
                        </CardTitle>
                        <CardDescription>
                          {industry.stockCount} stocks tracked
                        </CardDescription>
                      </div>
                    </div>
                    <ChevronRight className="h-5 w-5 text-muted-foreground group-hover:text-primary transition-colors" />
                  </div>
                </CardHeader>
                <CardContent>
                  <div className="space-y-3">
                    <div className="flex items-center justify-between text-sm">
                      <span className="text-muted-foreground">Avg Short %</span>
                      <Badge
                        variant={industry.avgShortPercent > 10 ? "destructive" : "secondary"}
                      >
                        {industry.avgShortPercent.toFixed(2)}%
                      </Badge>
                    </div>
                    <div className="flex items-center justify-between text-sm">
                      <span className="text-muted-foreground">Top Shorted</span>
                      <span className="font-medium">{industry.topStock?.code ?? "N/A"}</span>
                    </div>
                    {industry.topStock && (
                      <div className="flex items-center gap-2 text-xs text-muted-foreground">
                        <TrendingDown className="h-3 w-3 text-red-500" />
                        <span>
                          {industry.topStock.code}: {industry.topStock.shortPercent.toFixed(2)}%
                        </span>
                      </div>
                    )}
                  </div>
                </CardContent>
              </Card>
            </Link>
          ))}
        </section>

        {/* SEO Content */}
        <section className="prose prose-sm dark:prose-invert max-w-none mt-12 pt-8 border-t border-border/40">
          <h2>Understanding Industry Short Positions</h2>
          <p>
            Short selling activity varies significantly across different industry sectors on the ASX.
            Understanding which industries are heavily shorted can provide valuable insights into
            market sentiment and potential opportunities.
          </p>
          <h3>High Short Interest Industries</h3>
          <p>
            Sectors like mining (especially lithium and rare earths), speculative technology,
            and retail often see higher short interest due to their volatile nature and
            sensitivity to commodity prices or consumer spending patterns.
          </p>
          <h3>Lower Short Interest Industries</h3>
          <p>
            Defensive sectors such as utilities, healthcare, and essential consumer staples
            typically maintain lower short interest levels due to their stable revenue streams
            and lower volatility.
          </p>
        </section>
      </div>
    </DashboardLayout>
  );
}
