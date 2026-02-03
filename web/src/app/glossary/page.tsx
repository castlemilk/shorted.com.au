import { type Metadata } from "next";
import Link from "next/link";
import { BookOpen, ChevronRight } from "lucide-react";
import { siteConfig } from "~/@/config/site";
import { DashboardLayout } from "~/@/components/layouts/dashboard-layout";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "~/@/components/ui/card";
import { BreadcrumbListSchema } from "~/@/components/seo/enhanced-structured-data";

export const metadata: Metadata = {
  title: "Short Selling Glossary | Key Terms & Definitions",
  description:
    "Comprehensive glossary of short selling terms and definitions. Learn about short interest, days to cover, T+4 delay, short squeeze, securities lending, and more ASX trading terminology.",
  keywords: [
    "short selling glossary",
    "short interest definition",
    "T+4 delay meaning",
    "short squeeze explained",
    "days to cover definition",
    "ASX trading terms",
    "ASIC short position terms",
    "securities lending explained",
    "short selling terminology",
  ],
  openGraph: {
    title: "Short Selling Glossary | Key Terms & Definitions",
    description:
      "Comprehensive glossary of short selling terms and definitions for ASX investors.",
    url: `${siteConfig.url}/glossary`,
    siteName: siteConfig.name,
    type: "website",
    locale: "en_AU",
  },
  twitter: {
    card: "summary_large_image",
    title: "Short Selling Glossary | Key Terms & Definitions",
    description:
      "Comprehensive glossary of short selling terms and definitions.",
  },
  alternates: {
    canonical: `${siteConfig.url}/glossary`,
  },
};

const breadcrumbs = [
  { name: "Home", url: siteConfig.url },
  { name: "Glossary", url: `${siteConfig.url}/glossary` },
];

// Glossary terms organized by category
const glossaryTerms = [
  {
    category: "Core Concepts",
    terms: [
      {
        term: "Short Selling",
        definition:
          "A trading strategy where an investor borrows shares and sells them, hoping to buy them back at a lower price. The investor profits if the stock price falls and loses money if it rises.",
        related: ["Short Position", "Securities Lending", "Short Squeeze"],
      },
      {
        term: "Short Position",
        definition:
          "The number of shares of a particular stock that have been sold short but not yet covered or closed out. On the ASX, significant short positions must be reported to ASIC.",
        related: ["Short Interest", "ASIC"],
      },
      {
        term: "Short Interest",
        definition:
          "The percentage of a company's total shares on issue that are currently held as short positions. Expressed as a percentage, e.g., 10% short interest means 10% of all shares are shorted.",
        related: ["Short Position", "Shares on Issue"],
      },
      {
        term: "Short Squeeze",
        definition:
          "A rapid increase in a stock's price caused by short sellers rushing to cover their positions. When many shorts try to buy shares simultaneously, it can drive the price up dramatically, forcing more shorts to cover.",
        related: ["Short Covering", "Short Position"],
      },
    ],
  },
  {
    category: "ASIC & Reporting",
    terms: [
      {
        term: "ASIC",
        definition:
          "The Australian Securities and Investments Commission - Australia's corporate regulator. ASIC collects and publishes aggregated short position reports from market participants.",
        related: ["T+4 Delay", "Short Position"],
      },
      {
        term: "T+4 Delay",
        definition:
          "ASIC publishes short position data with a four trading day delay. For example, Monday's short positions are published on Friday. This delay is built into the reporting system.",
        related: ["ASIC", "Short Position"],
      },
      {
        term: "Reporting Threshold",
        definition:
          "Market participants must report short positions to ASIC when they exceed $100,000 or 0.01% of the company's issued capital, whichever is less.",
        related: ["ASIC", "Short Position"],
      },
      {
        term: "Aggregated Short Position",
        definition:
          "The total short position across all market participants, published by ASIC. Individual positions are not disclosed to protect trader confidentiality.",
        related: ["ASIC", "Short Position"],
      },
    ],
  },
  {
    category: "Trading Mechanics",
    terms: [
      {
        term: "Securities Lending",
        definition:
          "The process by which shares are borrowed from institutional holders (like superannuation funds) to facilitate short selling. Lenders receive a fee for making their shares available.",
        related: ["Short Selling", "Borrowing Cost"],
      },
      {
        term: "Short Covering",
        definition:
          "The process of closing out a short position by buying back the shares that were previously sold short. Also called 'covering' or 'closing a short'.",
        related: ["Short Squeeze", "Short Position"],
      },
      {
        term: "Days to Cover",
        definition:
          "The number of days it would take for all short sellers to cover their positions based on average daily trading volume. Calculated as: Short Interest ÷ Average Daily Volume.",
        related: ["Short Interest", "Short Squeeze"],
      },
      {
        term: "Borrowing Cost",
        definition:
          "The interest rate charged to borrow shares for short selling. Hard-to-borrow stocks have higher borrowing costs, which can exceed 50% annually for heavily shorted stocks.",
        related: ["Securities Lending", "Short Selling"],
      },
      {
        term: "Margin Call",
        definition:
          "A demand from a broker for additional funds when a short position moves against the trader. If the stock price rises significantly, the short seller must deposit more collateral.",
        related: ["Short Selling", "Short Squeeze"],
      },
    ],
  },
  {
    category: "Analysis Terms",
    terms: [
      {
        term: "Bearish",
        definition:
          "A negative outlook on a stock or the market. Short sellers are bearish as they profit when prices fall. High short interest is often considered a bearish indicator.",
        related: ["Short Selling", "Short Interest"],
      },
      {
        term: "Bullish",
        definition:
          "A positive outlook expecting prices to rise. Some traders view high short interest as bullish, believing a short squeeze could push prices higher.",
        related: ["Short Squeeze"],
      },
      {
        term: "Shares on Issue",
        definition:
          "The total number of shares of a company that have been issued and are outstanding. Used as the denominator when calculating short interest percentage.",
        related: ["Short Interest"],
      },
      {
        term: "Float",
        definition:
          "The number of shares available for public trading, excluding restricted shares held by insiders. Short interest relative to float can be higher than relative to total shares.",
        related: ["Short Interest", "Shares on Issue"],
      },
      {
        term: "Short Interest Ratio",
        definition:
          "Another name for days to cover. A higher ratio suggests it will take longer for shorts to exit their positions, potentially increasing squeeze risk.",
        related: ["Days to Cover", "Short Squeeze"],
      },
    ],
  },
  {
    category: "Market Participants",
    terms: [
      {
        term: "Hedge Fund",
        definition:
          "Investment funds that use various strategies including short selling. Hedge funds are major participants in ASX short selling activity.",
        related: ["Short Selling", "Securities Lending"],
      },
      {
        term: "Market Maker",
        definition:
          "Financial institutions that provide liquidity by buying and selling securities. Market makers may have short positions as part of their market-making activities.",
        related: ["Short Position"],
      },
      {
        term: "Prime Broker",
        definition:
          "Financial institutions that provide services to hedge funds including securities lending for short selling. They facilitate the borrowing of shares.",
        related: ["Securities Lending", "Hedge Fund"],
      },
    ],
  },
];

// DefinedTermSet structured data
function GlossaryStructuredData() {
  const terms = glossaryTerms.flatMap((category) =>
    category.terms.map((t) => ({
      "@type": "DefinedTerm",
      name: t.term,
      description: t.definition,
      inDefinedTermSet: `${siteConfig.url}/glossary`,
    }))
  );

  const structuredData = {
    "@context": "https://schema.org",
    "@type": "DefinedTermSet",
    "@id": `${siteConfig.url}/glossary`,
    name: "Short Selling Glossary",
    description:
      "Comprehensive glossary of short selling terms and definitions for ASX investors",
    hasDefinedTerm: terms,
  };

  return (
    <script
      type="application/ld+json"
      dangerouslySetInnerHTML={{ __html: JSON.stringify(structuredData) }}
    />
  );
}

export default function GlossaryPage() {
  return (
    <DashboardLayout>
      <BreadcrumbListSchema items={breadcrumbs} />
      <GlossaryStructuredData />

      <div className="space-y-8">
        {/* Hero Section */}
        <section className="relative border-b border-border/40 pb-8">
          <div className="flex items-center gap-3 mb-4">
            <div className="p-3 bg-primary/10 rounded-lg">
              <BookOpen className="h-8 w-8 text-primary" />
            </div>
            <div>
              <h1 className="text-3xl md:text-4xl font-bold tracking-tight">
                Short Selling Glossary
              </h1>
              <p className="text-muted-foreground mt-1">
                Key terms and definitions for understanding ASX short positions
              </p>
            </div>
          </div>
        </section>

        {/* Quick Navigation */}
        <section className="flex flex-wrap gap-2">
          {glossaryTerms.map((category) => (
            <a
              key={category.category}
              href={`#${category.category.toLowerCase().replace(/\s+/g, "-")}`}
              className="text-sm px-3 py-1.5 rounded-full border border-border hover:bg-muted transition-colors"
            >
              {category.category}
            </a>
          ))}
        </section>

        {/* Terms by Category */}
        {glossaryTerms.map((category) => (
          <section
            key={category.category}
            id={category.category.toLowerCase().replace(/\s+/g, "-")}
            className="scroll-mt-20"
          >
            <h2 className="text-xl font-semibold mb-4 flex items-center gap-2">
              <ChevronRight className="h-5 w-5 text-primary" />
              {category.category}
            </h2>
            <div className="grid gap-4">
              {category.terms.map((item) => (
                <Card key={item.term} id={item.term.toLowerCase().replace(/\s+/g, "-")}>
                  <CardHeader className="pb-3">
                    <CardTitle className="text-lg">{item.term}</CardTitle>
                  </CardHeader>
                  <CardContent>
                    <p className="text-muted-foreground mb-4">{item.definition}</p>
                    {item.related.length > 0 && (
                      <div className="flex flex-wrap gap-2">
                        <span className="text-xs text-muted-foreground">
                          Related:
                        </span>
                        {item.related.map((related) => (
                          <a
                            key={related}
                            href={`#${related.toLowerCase().replace(/\s+/g, "-")}`}
                            className="text-xs px-2 py-1 rounded bg-muted hover:bg-muted/80 transition-colors"
                          >
                            {related}
                          </a>
                        ))}
                      </div>
                    )}
                  </CardContent>
                </Card>
              ))}
            </div>
          </section>
        ))}

        {/* CTA Section */}
        <section className="mt-12 pt-8 border-t border-border/40">
          <Card className="bg-primary/5 border-primary/20">
            <CardContent className="pt-6">
              <div className="flex flex-col md:flex-row md:items-center justify-between gap-4">
                <div>
                  <h3 className="font-semibold text-lg">
                    Ready to track short positions?
                  </h3>
                  <p className="text-sm text-muted-foreground mt-1">
                    Explore real-time ASIC short position data for ASX stocks.
                  </p>
                </div>
                <Link
                  href="/top"
                  className="inline-flex items-center justify-center rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90 transition-colors"
                >
                  View Top Shorted Stocks
                  <ChevronRight className="ml-2 h-4 w-4" />
                </Link>
              </div>
            </CardContent>
          </Card>
        </section>
      </div>
    </DashboardLayout>
  );
}
