import { type Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";

import { cn } from "~/@/lib/utils";
import { eyebrow, pageTitle } from "~/@/lib/typography";
import { siteConfig } from "~/@/config/site";
import { Breadcrumbs } from "~/@/components/seo/breadcrumbs";
import {
  BreadcrumbListSchema,
  ItemListStructuredData,
} from "~/@/components/seo/enhanced-structured-data";
import { getAllPosts } from "~/@/lib/api";
import {
  BLOG_CATEGORY_SLUGS,
  blogCategoryPath,
  getBlogCategory,
} from "~/@/lib/blog/categories";
import { countByCategory, toBlogCard } from "~/@/lib/blog/cards";
import { blogItemListEntry } from "~/@/lib/blog/structured-data";
import { BlogCategoryNav } from "~/@/components/blog/blog-category-nav";
import { BlogPostGrid } from "~/@/components/blog/blog-post-grid";

interface Params {
  params: { category: string };
}

// One static page per category; anything else is a 404, never a dynamic
// render.
export const revalidate = 3600;
export const dynamicParams = false;

export function generateStaticParams() {
  return BLOG_CATEGORY_SLUGS.map((category) => ({ category }));
}

export function generateMetadata({ params }: Params): Metadata {
  const category = getBlogCategory(params.category);
  if (!category) return {};
  const url = `${siteConfig.url}${blogCategoryPath(category.slug)}`;
  // Absolute: the root layout's `%s | Shorted` template would otherwise
  // brand this twice ("... Shorted Blog | Shorted").
  const title = `${category.title} | Shorted Blog`;
  // Nested segments do not inherit /blog's opengraph-image.tsx, and a
  // summary_large_image card with no image unfurls as a bare link.
  const image = {
    url: siteConfig.ogImage,
    width: 1200,
    height: 630,
    alt: title,
  };
  return {
    title: { absolute: title },
    description: category.description,
    openGraph: {
      title,
      description: category.description,
      url,
      siteName: siteConfig.name,
      type: "website",
      locale: "en_AU",
      images: [image],
    },
    twitter: {
      site: "@shorted___",
      creator: "@shorted___",
      card: "summary_large_image",
      title,
      description: category.description,
      images: [siteConfig.ogImage],
    },
    alternates: {
      canonical: url,
      languages: { "en-AU": url, "x-default": url },
    },
  };
}

export default function BlogCategoryPage({ params }: Params) {
  const category = getBlogCategory(params.category);
  if (!category) notFound();

  const allCards = getAllPosts().map(toBlogCard);
  const cards = allCards.filter((c) => c.category.slug === category.slug);
  const counts = countByCategory(allCards);
  const url = `${siteConfig.url}${blogCategoryPath(category.slug)}`;

  // Plain container rather than DashboardLayout: its sidebar mounts client
  // side for signed-in readers and would reflow the listing after first
  // paint. A reading surface has no dashboard nav to offer anyway.
  return (
    <main className="container py-6">
      <BreadcrumbListSchema
        items={[
          { name: "Home", url: siteConfig.url },
          { name: "Blog", url: `${siteConfig.url}/blog` },
          { name: category.label, url },
        ]}
      />
      <ItemListStructuredData
        name={`${category.title}: Shorted Blog`}
        description={category.description}
        itemType="BlogPosting"
        items={cards.map(blogItemListEntry)}
      />

      <div className="space-y-8">
        <div className="mb-4">
          <Breadcrumbs
            items={[
              { label: "Blog", href: "/blog" },
              { label: category.label, href: blogCategoryPath(category.slug) },
            ]}
          />
        </div>

        <header className="border-b border-border/40 pb-6">
          <p className={cn(eyebrow, "mb-2 font-medium")}>
            Blog <span aria-hidden="true">/</span> {category.label}
          </p>
          <h1 className={cn(pageTitle, "leading-[1.1]")}>{category.title}</h1>
          <p className="mt-2 max-w-2xl text-muted-foreground">
            {category.description}
          </p>
          <p className="mt-3 font-mono text-xs text-muted-foreground">
            <span className="tabular-nums">{cards.length}</span>{" "}
            {cards.length === 1 ? "article" : "articles"}
          </p>
        </header>

        <BlogCategoryNav active={category.slug} counts={counts} />

        {cards.length > 0 ? (
          <section aria-label={`${category.label} articles`}>
            {/* h2 cards: nothing sits between the page h1 and the grid.
                One eager cover: the grid is 1-up on phones, so only the
                first card is above the fold on every breakpoint. */}
            <BlogPostGrid cards={cards} headingLevel="h2" priorityCount={1} />
          </section>
        ) : (
          <p className="rounded-lg border border-dashed border-border p-6 text-sm text-muted-foreground">
            Nothing filed under {category.label} yet.{" "}
            <Link href="/blog" className="text-primary hover:underline">
              Browse every article
            </Link>
            .
          </p>
        )}

        <footer className="border-t border-border/40 pt-6 text-sm text-muted-foreground">
          <p>
            <Link href="/blog" className="text-primary hover:underline">
              All articles
            </Link>
            {" · "}
            Short positions come from ASIC&rsquo;s daily reports with a T+4
            trading-day delay, and nothing here is financial advice.
          </p>
        </footer>
      </div>
    </main>
  );
}
