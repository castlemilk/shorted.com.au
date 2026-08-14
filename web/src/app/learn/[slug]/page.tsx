import { type Metadata } from "next";
import { cn } from "~/@/lib/utils";
import { articlesData } from "./articles-data";
import { pageTitle } from "~/@/lib/typography";
import Link from "next/link";
import { notFound } from "next/navigation";
import {
  Clock,
  ChevronRight,
  ChevronLeft,
  BookOpen,
  GraduationCap,
} from "lucide-react";
import { siteConfig } from "~/@/config/site";
import { DashboardLayout } from "~/@/components/layouts/dashboard-layout";
import { Badge } from "~/@/components/ui/badge";
import { Button } from "~/@/components/ui/button";
import {
  BreadcrumbListSchema,
} from "~/@/components/seo/enhanced-structured-data";
import { Breadcrumbs } from "~/@/components/seo/breadcrumbs";
import { ArticleSchema } from "~/@/components/seo/article-schema";

interface PageProps {
  params: Promise<{ slug: string }>;
}


export async function generateMetadata({ params }: PageProps): Promise<Metadata> {
  const { slug } = await params;
  const article = articlesData[slug];

  if (!article) {
    return { title: "Article Not Found" };
  }

  return {
    title: article.title,
    description: article.description,
    keywords: [...article.topics, "short selling guide", "ASX education", "ASIC data"],
    openGraph: {
      title: article.title,
      description: article.description,
      url: `${siteConfig.url}/learn/${slug}`,
      siteName: siteConfig.name,
      type: "article",
      locale: "en_AU",
      // No `images` key: this route ships its own opengraph-image.tsx and an
      // explicit `images` here would SHADOW the file convention.
    },
    twitter: {
      card: "summary_large_image",
      title: article.title,
      description: article.description,
    },
    alternates: {
      canonical: `${siteConfig.url}/learn/${slug}`,
      languages: {
        "en-AU": `${siteConfig.url}/learn/${slug}`,
        "x-default": `${siteConfig.url}/learn/${slug}`,
      },
    },
  };
}

export function generateStaticParams() {
  return Object.keys(articlesData).map((slug) => ({ slug }));
}

const levelColors = {
  Beginner: "bg-secondary/15 text-secondary-foreground dark:text-secondary border-secondary/40",
  Intermediate: "bg-primary/10 text-primary border-primary/30",
  Advanced: "bg-accent/15 text-accent border-accent/40",
};

export default async function LearnArticlePage({ params }: PageProps) {
  const { slug } = await params;
  const article = articlesData[slug];

  if (!article) {
    notFound();
  }

  const breadcrumbItems = [
    { label: "Learn", href: "/learn" },
    { label: article.title, href: `/learn/${slug}` },
  ];

  const breadcrumbsSchema = [
    { name: "Home", url: siteConfig.url },
    { name: "Learn", url: `${siteConfig.url}/learn` },
    { name: article.title, url: `${siteConfig.url}/learn/${slug}` },
  ];

  const relatedArticles = article.relatedArticles
    .map((relatedSlug) => {
      const related = articlesData[relatedSlug];
      return related ? { slug: relatedSlug, ...related } : null;
    })
    .filter(Boolean);

  return (
    <DashboardLayout>
      <BreadcrumbListSchema items={breadcrumbsSchema} />
      <ArticleSchema
        title={article.title}
        description={article.description}
        datePublished={article.datePublished}
        dateModified={article.dateModified}
        url={`${siteConfig.url}/learn/${slug}`}
        authorName={siteConfig.author}
        // The article schema should show the ARTICLE card, not the generic
        // site card, now that this route generates its own.
        image={`${siteConfig.url}/learn/${slug}/opengraph-image`}
        keywords={[...article.topics, "short selling guide", "ASX education"]}
      />
      {article.faqs.length > 0 && (
        <script
          type="application/ld+json"
          dangerouslySetInnerHTML={{
            __html: JSON.stringify({
              "@context": "https://schema.org",
              "@type": "FAQPage",
              mainEntity: article.faqs.map((faq) => ({
                "@type": "Question",
                name: faq.question,
                acceptedAnswer: {
                  "@type": "Answer",
                  text: faq.answer,
                },
              })),
            }),
          }}
        />
      )}

      <div className="max-w-4xl mx-auto">
        {/* Breadcrumbs */}
        <div className="mb-6">
          <Breadcrumbs items={breadcrumbItems} />
        </div>

        {/* Article Header */}
        <header className="mb-8 pb-8 border-b border-border/40">
          <div className="flex items-center gap-2 mb-4">
            <Badge
              variant="outline"
              className={levelColors[article.level as keyof typeof levelColors]}
            >
              {article.level}
            </Badge>
            <span className="flex items-center gap-1 text-sm text-muted-foreground">
              <Clock className="h-4 w-4" />
              {article.readTime}
            </span>
          </div>

          <h1 className={cn(pageTitle, "mb-4")}>
            {article.title}
          </h1>

          <p className="text-lg text-muted-foreground">{article.description}</p>

          <div className="flex flex-wrap gap-2 mt-4">
            {article.topics.map((topic) => (
              <span
                key={topic}
                className="text-xs px-2 py-1 rounded bg-muted text-muted-foreground"
              >
                {topic}
              </span>
            ))}
          </div>
        </header>

        {/* Article Content */}
        <div className="mb-12">{article.content}</div>

        {/* FAQ Section */}
        {article.faqs.length > 0 && (
          <section className="mb-12 p-6 bg-muted/30 rounded-lg">
            <h2 className="text-xl font-semibold mb-4 flex items-center gap-2">
              <BookOpen className="h-5 w-5 text-primary" />
              Frequently Asked Questions
            </h2>
            <div className="space-y-4">
              {article.faqs.map((faq, index) => (
                <div key={index}>
                  <h3 className="font-medium">{faq.question}</h3>
                  <p className="text-sm text-muted-foreground mt-1">{faq.answer}</p>
                </div>
              ))}
            </div>
          </section>
        )}

        {/* Related Articles */}
        {relatedArticles.length > 0 && (
          <section className="mb-12">
            <h2 className="text-xl font-semibold mb-4">Continue Learning</h2>
            <div className="grid gap-4">
              {relatedArticles.map((related) =>
                related ? (
                  <Link key={related.slug} href={`/learn/${related.slug}`} className="group">
                    <div className="flex items-center gap-4 p-4 rounded-lg border border-border/60 hover:border-primary/50 transition-colors">
                      <GraduationCap className="h-5 w-5 text-primary flex-shrink-0" />
                      <div className="flex-1 min-w-0">
                        <div className="font-medium group-hover:text-primary transition-colors">
                          {related.title}
                        </div>
                        <div className="text-sm text-muted-foreground truncate">
                          {related.description}
                        </div>
                      </div>
                      <ChevronRight className="h-4 w-4 text-muted-foreground" />
                    </div>
                  </Link>
                ) : null
              )}
            </div>
          </section>
        )}

        {/* Navigation */}
        <div className="flex justify-between pt-8 border-t border-border/40">
          <Link href="/learn">
            <Button variant="outline" className="flex items-center gap-2">
              <ChevronLeft className="h-4 w-4" />
              All Guides
            </Button>
          </Link>
          <Link href="/top">
            <Button className="flex items-center gap-2">
              View Top Shorts
              <ChevronRight className="h-4 w-4" />
            </Button>
          </Link>
        </div>
      </div>
    </DashboardLayout>
  );
}
