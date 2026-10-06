import { type Metadata } from "next";
import { notFound } from "next/navigation";
import { MDXRemote } from "next-mdx-remote/rsc";
import remarkGfm from "remark-gfm";

import { getPostBySlug } from "~/@/lib/api";
import { siteConfig } from "~/@/config/site";
import { AUTHORS } from "~/@/data/authors";
import { blogMdxComponents } from "~/@/components/blog/mdx-components";
import { BlogPostHeader } from "~/@/components/blog/blog-post-header";
import { ArticleSchema } from "~/@/components/seo/article-schema";
import {
  Breadcrumbs,
  BreadcrumbStructuredData,
} from "~/@/components/seo/breadcrumbs";
import { LLMMeta } from "~/@/components/seo/llm-meta";
import { SocialShare } from "~/@/components/seo/social-share";
import { RelatedPosts } from "~/@/components/seo/related-posts";
import { blogCategoryPath } from "~/@/lib/blog/categories";
import { blogPostPath, toBlogCard } from "~/@/lib/blog/cards";
import { stripLeadingHeading } from "~/@/lib/blog/body";
// Prism theme for fenced code blocks — only blog posts pay for it.
import "prismjs/themes/prism-tomorrow.css";

export const revalidate = 3600; // Revalidate hourly — blog posts change infrequently

interface Params {
  params: {
    slug: string;
  };
}

const authorSlugFor = (name?: string): string | undefined =>
  AUTHORS.find((a) => a.name === name)?.slug;

export default async function Post({ params }: Params) {
  const post = getPostBySlug(params.slug);

  if (!post) {
    return notFound();
  }

  const card = toBlogCard(post);
  const postUrl = `${siteConfig.url}${blogPostPath(params.slug)}`;
  const description =
    post.excerpt ||
    `Read ${post.title} on Shorted - insights into ASX short positions and market analysis.`;
  const authorName = post.author?.name || siteConfig.author;
  const authorSlug = authorSlugFor(post.author?.name);
  const keywords = [
    ...(post.tags ?? []),
    card.category.label,
    "ASX short selling",
    "market analysis",
  ];

  const breadcrumbItems = [
    { label: "Blog", href: "/blog" },
    { label: card.category.label, href: blogCategoryPath(card.category.slug) },
    { label: post.title, href: blogPostPath(params.slug) },
  ];

  // Plain container rather than DashboardLayout: its sidebar mounts client
  // side for signed-in readers and would reflow the article after first
  // paint. Long-form reading has no dashboard nav to offer.
  return (
    <main className="container py-6">
      <BreadcrumbStructuredData items={breadcrumbItems} />
      <ArticleSchema
        type="BlogPosting"
        title={post.title}
        description={description}
        datePublished={post.date}
        dateModified={post.updated}
        authorName={authorName}
        authorSlug={authorSlug}
        authorImage={post.author?.picture}
        image={post.ogImage?.url || siteConfig.ogImage}
        url={postUrl}
        articleSection={card.category.label}
        keywords={keywords}
      />
      <LLMMeta
        title={post.title}
        description={description}
        keywords={keywords}
        dataSource="Shorted Blog"
        dataFrequency="irregular"
        datePublished={post.date}
        lastUpdated={post.updated ?? post.date}
      />

      <div className="mx-auto max-w-4xl">
        <Breadcrumbs items={breadcrumbItems} className="mb-6 [&_[aria-current=page]]:hidden sm:[&_[aria-current=page]]:block [&>svg:last-of-type]:hidden sm:[&>svg:last-of-type]:block" />

        <article className="mb-16">
          <BlogPostHeader
            card={card}
            updated={post.updated}
            authorHref={authorSlug ? `/authors/${authorSlug}` : undefined}
          />

          <div className="article-prose custom-mdx-content mx-auto mt-10 max-w-2xl">
            <MDXRemote
              // The masthead already renders the title; the body's own
              // `# Title` line would repeat it as an oversized h2.
              source={stripLeadingHeading(post.content)}
              components={blogMdxComponents}
              options={{
                parseFrontmatter: false,
                mdxOptions: {
                  remarkPlugins: [remarkGfm],
                  rehypePlugins: [],
                },
              }}
            />
          </div>

          <div className="mx-auto mt-12 max-w-2xl">
            <SocialShare
              url={postUrl}
              title={post.title}
              description={post.excerpt || ""}
            />
          </div>
        </article>

        <RelatedPosts currentSlug={params.slug} />
      </div>
    </main>
  );
}

export function generateMetadata({ params }: Params): Metadata {
  const post = getPostBySlug(params.slug);

  if (!post) {
    return notFound();
  }

  const card = toBlogCard(post);
  const title = post.title;
  const description =
    post.excerpt ||
    `${post.title} - Expert analysis on ASX short positions, market trends, and ASIC regulations. Learn about Australian stock market short selling with data-driven insights.`;
  const authorName = post.author?.name || siteConfig.author;
  const url = `${siteConfig.url}${blogPostPath(params.slug)}`;

  return {
    title,
    description,
    keywords: [
      ...(post.tags ?? []),
      card.category.label,
      ...siteConfig.keywords,
      "blog",
    ],
    authors: [{ name: authorName }],
    openGraph: {
      type: "article",
      title,
      description,
      url,
      publishedTime: post.date,
      modifiedTime: post.updated,
      authors: [authorName],
      section: card.category.label,
      tags: post.tags,
      images: [
        {
          url: post.ogImage?.url || siteConfig.ogImage,
          width: /\/cover-editorial-v\d+\.webp$/.test(post.ogImage?.url ?? "") ? 1600 : 1200,
          height: /\/cover-editorial-v\d+\.webp$/.test(post.ogImage?.url ?? "") ? 900 : 630,
          alt: post.coverAlt?.trim() ? post.coverAlt : title,
        },
      ],
    },
    twitter: {
      site: "@shorted___",
      creator: "@shorted___",
      card: "summary_large_image",
      title,
      description,
      images: [post.ogImage?.url || siteConfig.ogImage],
    },
    alternates: {
      canonical: url,
      languages: {
        "en-AU": url,
        en: url,
        "x-default": url,
      },
    },
    robots: {
      index: true,
      follow: true,
    },
  };
}
