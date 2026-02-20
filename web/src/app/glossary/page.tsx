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
import { LLMMeta } from "~/@/components/seo/llm-meta";
import { glossaryTerms } from "~/@/data/glossary-terms";

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
    images: [
      {
        url: siteConfig.ogImage,
        width: 1200,
        height: 630,
        alt: "Short Selling Glossary - Key Terms & Definitions",
      },
    ],
  },
  twitter: {
    card: "summary_large_image",
    title: "Short Selling Glossary | Key Terms & Definitions",
    description:
      "Comprehensive glossary of short selling terms and definitions.",
    images: [siteConfig.ogImage],
  },
  alternates: {
    canonical: `${siteConfig.url}/glossary`,
  },
};

const breadcrumbs = [
  { name: "Home", url: siteConfig.url },
  { name: "Glossary", url: `${siteConfig.url}/glossary` },
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
      <LLMMeta
        title="Short Selling Glossary - Key Terms & Definitions"
        description="Comprehensive glossary of short selling terms and definitions for ASX investors."
        keywords={[
          "short selling glossary",
          "short interest definition",
          "ASX trading terms",
          "ASIC short position terms",
        ]}
        dataSource="ASIC"
        dataFrequency="static"
      />

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
                <Card key={item.term} id={item.slug}>
                  <CardHeader className="pb-3">
                    <Link href={`/glossary/${item.slug}`} className="hover:text-primary transition-colors">
                      <CardTitle className="text-lg">{item.term}</CardTitle>
                    </Link>
                  </CardHeader>
                  <CardContent>
                    <p className="text-muted-foreground mb-4">{item.definition}</p>
                    <div className="flex flex-wrap items-center gap-2">
                      {item.related.length > 0 && (
                        <>
                          <span className="text-xs text-muted-foreground">
                            Related:
                          </span>
                          {item.related.map((related) => (
                            <Link
                              key={related}
                              href={`/glossary/${related.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "")}`}
                              className="text-xs px-2 py-1 rounded bg-muted hover:bg-muted/80 transition-colors"
                            >
                              {related}
                            </Link>
                          ))}
                        </>
                      )}
                      <Link
                        href={`/glossary/${item.slug}`}
                        className="text-xs text-primary hover:underline ml-auto"
                      >
                        Read more
                      </Link>
                    </div>
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
