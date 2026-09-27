import { type Metadata } from "next";
import Link from "next/link";

import { cn } from "~/@/lib/utils";
import { eyebrow, pageTitle, sectionTitle } from "~/@/lib/typography";
import { siteConfig } from "~/@/config/site";
import { Breadcrumbs } from "~/@/components/seo/breadcrumbs";
import {
  BreadcrumbListSchema,
  ItemListStructuredData,
} from "~/@/components/seo/enhanced-structured-data";
import { LLMMeta } from "~/@/components/seo/llm-meta";
import { getAllPosts } from "~/@/lib/api";
import {
  countByCategory,
  formatBlogDate,
  toBlogCard,
} from "~/@/lib/blog/cards";
import { blogItemListEntry } from "~/@/lib/blog/structured-data";
import { BlogCategoryNav } from "~/@/components/blog/blog-category-nav";
import { BlogFeaturedPost } from "~/@/components/blog/blog-featured-post";
import { BlogPostGrid } from "~/@/components/blog/blog-post-grid";

const TITLE = "ASX Short Selling Blog: Guides, Data and Analysis";
const DESCRIPTION =
  "Guides to ASIC's official short-position data, data stories on the most shorted ASX stocks, and housing analysis from ABS and Valuer-General data.";

export const metadata: Metadata = {
  // Root layout applies the `%s | Shorted` template.
  title: TITLE,
  description: DESCRIPTION,
  keywords: [
    "ASX short selling blog",
    "short selling analysis",
    "how to read short interest data",
    "most shorted ASX stocks",
    "short squeeze analysis",
    "ASIC short position insights",
    "Australian house prices analysis",
    "market sentiment Australia",
  ],
  openGraph: {
    title: "Notes on shorting the ASX | Shorted Blog",
    description: DESCRIPTION,
    url: `${siteConfig.url}/blog`,
    siteName: siteConfig.name,
    type: "website",
    locale: "en_AU",
    // No `images` key: this route ships its own opengraph-image.tsx and an
    // explicit `images` here would SHADOW the file convention.
  },
  twitter: {
    site: "@shorted___",
    creator: "@shorted___",
    card: "summary_large_image",
    title: "Notes on shorting the ASX | Shorted Blog",
    description:
      "Guides, data stories and analysis on ASX short selling, from official ASIC data.",
  },
  alternates: {
    canonical: `${siteConfig.url}/blog`,
    languages: {
      "en-AU": `${siteConfig.url}/blog`,
      "x-default": `${siteConfig.url}/blog`,
    },
  },
};

// Posts are files in `_blogs/`, read at build/regeneration time. Hourly ISR
// is plenty; nothing here reads searchParams, so the page stays static.
export const revalidate = 3600;

export default function BlogIndexPage() {
  // getAllPosts() is newest-first, so the first card is the featured post.
  const cards = getAllPosts().map(toBlogCard);
  const [featured, ...rest] = cards;
  const counts = countByCategory(cards);

  // Plain container rather than DashboardLayout: its sidebar mounts client
  // side for signed-in readers and would reflow the whole listing after
  // first paint. A reading surface has no dashboard nav to offer anyway.
  return (
    <main className="container py-6">
      <BreadcrumbListSchema
        items={[
          { name: "Home", url: siteConfig.url },
          { name: "Blog", url: `${siteConfig.url}/blog` },
        ]}
      />
      <ItemListStructuredData
        name="Shorted Blog"
        description={DESCRIPTION}
        itemType="BlogPosting"
        items={cards.map(blogItemListEntry)}
      />
      <LLMMeta
        title={TITLE}
        description={DESCRIPTION}
        keywords={[
          "ASX short selling",
          "short interest guides",
          "market analysis",
          "Australian housing data",
        ]}
        dataSource="Shorted Blog"
        // Posts land when they are ready, a few a month at most.
        dataFrequency="irregular"
        lastUpdated={featured?.date}
      />

      <div className="space-y-8">
        <div className="mb-4">
          <Breadcrumbs items={[{ label: "Blog", href: "/blog" }]} />
        </div>

        <header className="border-b border-border/40 pb-6">
          <p className={cn(eyebrow, "mb-2 font-medium")}>Blog</p>
          <h1 className={cn(pageTitle, "leading-[1.1]")}>
            Notes on shorting the ASX
          </h1>
          <p className="mt-2 max-w-2xl text-muted-foreground">
            Guides to reading ASIC&rsquo;s short-position data, data stories on
            crowded trades and sector rotations, and the occasional detour into
            Australian house prices and what we are building.
          </p>
          <p className="mt-3 font-mono text-xs text-muted-foreground">
            <span className="tabular-nums">{cards.length}</span> articles
            {featured ? (
              <>
                {" · "}Latest{" "}
                <time dateTime={featured.date}>
                  {formatBlogDate(featured.date)}
                </time>
              </>
            ) : null}
            {" · "}
            <Link href="/feed.xml" className="text-primary hover:underline">
              RSS
            </Link>
          </p>
        </header>

        <BlogCategoryNav active="all" counts={counts} />

        {featured ? <BlogFeaturedPost card={featured} /> : null}

        {rest.length > 0 ? (
          <section aria-labelledby="blog-more-articles">
            <div className="mb-5 flex items-baseline justify-between gap-4">
              <h2 id="blog-more-articles" className={sectionTitle}>
                More articles
              </h2>
              <p className="font-mono text-xs text-muted-foreground">
                Newest first
              </p>
            </div>
            <BlogPostGrid cards={rest} />
          </section>
        ) : null}

        <footer className="border-t border-border/40 pt-6 text-sm text-muted-foreground">
          <p>
            Short positions come from ASIC&rsquo;s daily reports with a T+4
            trading-day delay, and nothing here is financial advice. See also:{" "}
            <Link href="/top" className="text-primary hover:underline">
              most shorted ASX stocks
            </Link>
            {" · "}
            <Link href="/reports" className="text-primary hover:underline">
              weekly reports
            </Link>
            {" · "}
            <Link href="/news" className="text-primary hover:underline">
              newsroom
            </Link>
            .
          </p>
        </footer>
      </div>
    </main>
  );
}
