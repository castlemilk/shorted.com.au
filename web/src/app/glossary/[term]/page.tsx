import { type Metadata } from "next";
import { pageTitle } from "~/@/lib/typography";
import Link from "next/link";
import { notFound } from "next/navigation";
import { BookOpen, ChevronRight, ArrowLeft, Tag } from "lucide-react";
import { siteConfig } from "~/@/config/site";
import { DashboardLayout } from "~/@/components/layouts/dashboard-layout";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "~/@/components/ui/card";
import { Badge } from "~/@/components/ui/badge";
import { BreadcrumbListSchema } from "~/@/components/seo/enhanced-structured-data";
import { Breadcrumbs } from "~/@/components/seo/breadcrumbs";
import {
  getTermBySlug,
  getCategoryForTerm,
  getRelatedTerms,
  getAllTermSlugs,
} from "~/@/data/glossary-terms";

interface PageProps {
  params: Promise<{ term: string }>;
}

export async function generateStaticParams() {
  return getAllTermSlugs().map((slug) => ({ term: slug }));
}

export async function generateMetadata({ params }: PageProps): Promise<Metadata> {
  const { term: slug } = await params;
  const term = getTermBySlug(slug);

  if (!term) {
    // The page body calls notFound() for this slug, but the 404 status can be
    // pre-empted if the response has already streamed — keep the fallback
    // metadata explicitly noindex so a soft-200 never enters the index.
    return {
      title: "Term Not Found",
      robots: { index: false, follow: false },
    };
  }

  const title = `${term.term} Definition | Short Selling Glossary | ${siteConfig.name}`;
  const description = `${term.definition.slice(0, 155)}...`;

  return {
    title,
    description,
    keywords: [
      `${term.term.toLowerCase()} definition`,
      `${term.term.toLowerCase()} meaning`,
      `what is ${term.term.toLowerCase()}`,
      "short selling glossary",
      "ASX trading terms",
    ],
    openGraph: {
      title,
      description,
      url: `${siteConfig.url}/glossary/${slug}`,
      siteName: siteConfig.name,
      type: "article",
      locale: "en_AU",
    },
    twitter: {
      card: "summary",
      title,
      description,
    },
    alternates: {
      canonical: `${siteConfig.url}/glossary/${slug}`,
    },
  };
}

export const revalidate = false; // Static — glossary terms don't change

function TermStructuredData({ term }: { term: { term: string; definition: string; slug: string } }) {
  const structuredData = {
    "@context": "https://schema.org",
    "@type": "DefinedTerm",
    name: term.term,
    description: term.definition,
    inDefinedTermSet: {
      "@type": "DefinedTermSet",
      "@id": `${siteConfig.url}/glossary`,
      name: "Short Selling Glossary",
    },
    url: `${siteConfig.url}/glossary/${term.slug}`,
  };

  return (
    <script
      type="application/ld+json"
      dangerouslySetInnerHTML={{ __html: JSON.stringify(structuredData) }}
    />
  );
}

export default async function GlossaryTermPage({ params }: PageProps) {
  const { term: slug } = await params;
  const term = getTermBySlug(slug);

  if (!term) {
    notFound();
  }

  const category = getCategoryForTerm(term.term) ?? "General";
  const relatedTerms = getRelatedTerms(term);

  const breadcrumbItems = [
    { label: "Glossary", href: "/glossary" },
    { label: term.term, href: `/glossary/${slug}` },
  ];

  const breadcrumbsSchema = [
    { name: "Home", url: siteConfig.url },
    { name: "Glossary", url: `${siteConfig.url}/glossary` },
    { name: term.term, url: `${siteConfig.url}/glossary/${slug}` },
  ];

  return (
    <DashboardLayout>
      <BreadcrumbListSchema items={breadcrumbsSchema} />
      <TermStructuredData term={term} />

      <div className="space-y-8 max-w-3xl">
        {/* Breadcrumbs */}
        <div className="mb-4">
          <Breadcrumbs items={breadcrumbItems} />
        </div>

        {/* Back link */}
        <Link
          href="/glossary"
          className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground transition-colors"
        >
          <ArrowLeft className="h-3.5 w-3.5" />
          Back to Glossary
        </Link>

        {/* Hero */}
        <section className="border-b border-border/40 pb-8">
          <div className="flex items-center gap-2 mb-3">
            <Badge variant="outline" className="text-xs">
              <Tag className="h-3 w-3 mr-1" />
              {category}
            </Badge>
          </div>
          <h1 className={pageTitle}>
            {term.term}
          </h1>
        </section>

        {/* Definition */}
        <section>
          <Card>
            <CardHeader>
              <CardTitle className="text-lg flex items-center gap-2">
                <BookOpen className="h-5 w-5 text-primary" />
                Definition
              </CardTitle>
            </CardHeader>
            <CardContent>
              <p className="text-muted-foreground leading-relaxed text-lg">
                {term.definition}
              </p>
            </CardContent>
          </Card>
        </section>

        {/* Related Terms */}
        {relatedTerms.length > 0 && (
          <section>
            <h2 className="text-xl font-semibold mb-4 flex items-center gap-2">
              <ChevronRight className="h-5 w-5 text-primary" />
              Related Terms
            </h2>
            <div className="grid gap-3">
              {relatedTerms.map((related) => (
                <Link
                  key={related.slug}
                  href={`/glossary/${related.slug}`}
                  className="group"
                >
                  <Card className="hover:border-primary/50 transition-colors">
                    <CardContent className="pt-4 pb-4">
                      <div className="flex items-center justify-between">
                        <div>
                          <h3 className="font-semibold group-hover:text-primary transition-colors">
                            {related.term}
                          </h3>
                          <p className="text-sm text-muted-foreground mt-1 line-clamp-1">
                            {related.definition}
                          </p>
                        </div>
                        <ChevronRight className="h-4 w-4 text-muted-foreground group-hover:text-primary transition-colors flex-shrink-0" />
                      </div>
                    </CardContent>
                  </Card>
                </Link>
              ))}
            </div>
          </section>
        )}

        {/* CTA */}
        <section className="pt-8 border-t border-border/40">
          <Card className="bg-primary/5 border-primary/20">
            <CardContent className="pt-6">
              <div className="flex flex-col md:flex-row md:items-center justify-between gap-4">
                <div>
                  <h3 className="font-semibold text-lg">
                    See short selling in action
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
