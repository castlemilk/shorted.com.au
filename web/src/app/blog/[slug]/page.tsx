import { notFound } from "next/navigation";
import { getPostBySlug } from "~/@/lib/api";
import Container from "~/@/components/ui/container";
import { PostHeader } from "~/@/components/ui/post-header";
import { type Metadata } from "next";
import { MDXRemote } from "next-mdx-remote/rsc";
import remarkGfm from "remark-gfm";
import { siteConfig } from "~/@/config/site";
import { ArticleSchema } from "~/@/components/seo/article-schema";
import { BreadcrumbStructuredData } from "~/@/components/seo/breadcrumbs";
import { LLMMeta } from "~/@/components/seo/llm-meta";
import { SocialShare } from "~/@/components/seo/social-share";
import { RelatedPosts } from "~/@/components/seo/related-posts";
import {
  calculateReadingTime,
  formatReadingTime,
} from "~/@/utils/reading-time";
import Info from "~/@/components/ui/info";
// SSR-safe wrapper: the raw RegisterEmail is a client component that imports a
// Connect-RPC server action, which crashes RSC rendering inside MDXRemote
// (see CLAUDE.md "SSR Issues with @connectrpc/connect"). The dynamic ssr:false
// wrapper is what the blog index already uses.
import RegisterEmailClient from "~/@/components/ui/register-email-client";
// Lazy load Prism CSS only for blog posts
import "prismjs/themes/prism-tomorrow.css";

export const revalidate = 3600; // Revalidate hourly — blog posts change infrequently

interface Params {
  params: {
    slug: string;
  };
}

export default async function Post({ params }: Params) {
  const post = getPostBySlug(params.slug);

  if (!post) {
    return notFound();
  }

  const readingTime = calculateReadingTime(String(post.content));
  const postUrl = `${siteConfig.url}/blog/${params.slug}`;

  const components = {
    h1: ({ children, ...props }: React.HTMLAttributes<HTMLHeadingElement>) => (
      <h2 className="text-4xl font-bold mt-8 mb-4" {...props}>{children}</h2>
    ),
    h2: ({ children, ...props }: React.HTMLAttributes<HTMLHeadingElement>) => (
      <h2 className="text-3xl font-semibold mt-6 mb-3" {...props}>{children}</h2>
    ),
    h3: ({ children, ...props }: React.HTMLAttributes<HTMLHeadingElement>) => (
      <h3 className="text-2xl font-medium mt-4 mb-2" {...props}>{children}</h3>
    ),
    h4: ({ children, ...props }: React.HTMLAttributes<HTMLHeadingElement>) => (
      <h4 className="text-xl font-medium mt-3 mb-2" {...props}>{children}</h4>
    ),
    h5: ({ children, ...props }: React.HTMLAttributes<HTMLHeadingElement>) => (
      <h5 className="text-lg font-medium mt-2 mb-1" {...props}>{children}</h5>
    ),
    h6: ({ children, ...props }: React.HTMLAttributes<HTMLHeadingElement>) => (
      <h6 className="text-base font-medium mt-2 mb-1" {...props}>{children}</h6>
    ),
    a: ({ children, ...props }: React.HTMLAttributes<HTMLAnchorElement>) => (
      <a className="text-primary hover:underline" {...props}>{children}</a>
    ),
    p: (props: React.HTMLAttributes<HTMLParagraphElement>) => (
      <p className="mt-4 mb-4" {...props} />
    ),
    ul: (props: React.HTMLAttributes<HTMLUListElement>) => (
      <ul className="list-disc list-inside mt-2 mb-2" {...props} />
    ),
    ol: (props: React.HTMLAttributes<HTMLOListElement>) => (
      <ol className="list-decimal list-inside mt-2 mb-2" {...props} />
    ),
    li: (props: React.HTMLAttributes<HTMLLIElement>) => (
      <li className="mt-1 mb-1" {...props} />
    ),
    table: (props: React.HTMLAttributes<HTMLTableElement>) => (
      <table className="w-full mt-4 mb-4" {...props} />
    ),
    tr: (props: React.HTMLAttributes<HTMLTableRowElement>) => (
      <tr className="border-b border-border" {...props} />
    ),
    th: (props: React.HTMLAttributes<HTMLTableCellElement>) => (
      <th className="px-4 py-2 text-left" {...props} />
    ),
    td: (props: React.HTMLAttributes<HTMLTableCellElement>) => (
      <td className="px-4 py-2 text-left" {...props} />
    ),
    RegisterEmail: (props: Record<string, unknown>) => (
      <RegisterEmailClient {...props} />
    ),
    Info: (props: { title: string; children: React.ReactNode }) => (
      <Info {...props} />
    ),
  };

  return (
    <main>
      <BreadcrumbStructuredData
        items={[
          { label: "Blog", href: "/blog" },
          { label: post.title, href: `/blog/${params.slug}` },
        ]}
      />
      <ArticleSchema
        title={post.title}
        description={
          post.excerpt ||
          `Read ${post.title} on Shorted - insights into ASX short positions and market analysis.`
        }
        datePublished={post.date}
        authorName={post.author?.name || siteConfig.author}
        authorImage={post.author?.picture}
        image={post.ogImage?.url || siteConfig.ogImage}
        url={postUrl}
        keywords={[
          ...siteConfig.keywords,
          "blog",
          "market insights",
          "investment analysis",
        ]}
      />
      <LLMMeta
        title={post.title}
        description={
          post.excerpt ||
          `${post.title} - Expert analysis on ASX short positions, market trends, and ASIC regulations.`
        }
        keywords={[
          "blog",
          "market insights",
          "investment analysis",
          "ASX short selling",
          "market analysis",
        ]}
        dataSource="Shorted Blog"
        dataFrequency="weekly"
        lastUpdated={post.date}
      />

      <Container>
        <article className="mb-32">
          <PostHeader
            title={post.title}
            coverImage={post.coverImage}
            date={post.date}
            author={post.author}
          />

          {/* Reading time indicator */}
          <div className="max-w-2xl mx-auto mb-8">
            <div className="flex items-center gap-4 text-sm text-muted-foreground border-b border-border pb-4">
              <time dateTime={post.date}>
                {new Date(post.date).toLocaleDateString("en-AU", {
                  year: "numeric",
                  month: "long",
                  day: "numeric",
                })}
              </time>
              <span>•</span>
              <span>{formatReadingTime(readingTime)}</span>
              <span>•</span>
              <span>By {post.author?.name || siteConfig.author}</span>
            </div>
          </div>

          <div className="max-w-2xl mx-auto custom-mdx-content">
            <MDXRemote
              source={post.content}
              components={components}
              options={{
                parseFrontmatter: false,
                mdxOptions: {
                  remarkPlugins: [remarkGfm],
                  rehypePlugins: [],
                },
              }}
            />
          </div>

          {/* Social sharing */}
          <div className="max-w-2xl mx-auto mt-12">
            <SocialShare
              url={postUrl}
              title={post.title}
              description={post.excerpt || ""}
            />
          </div>

          {/* Related posts */}
          <div className="max-w-4xl mx-auto">
            <RelatedPosts currentSlug={params.slug} />
          </div>
        </article>
      </Container>
    </main>
  );
}

export function generateMetadata({ params }: Params): Metadata {
  const post = getPostBySlug(params.slug);

  if (!post) {
    return notFound();
  }

  const title = post.title;
  const description =
    post.excerpt ||
    `${post.title} - Expert analysis on ASX short positions, market trends, and ASIC regulations. Learn about Australian stock market short selling with data-driven insights.`;

  return {
    title,
    description,
    keywords: [
      ...siteConfig.keywords,
      "blog",
      "market insights",
      "investment analysis",
      "stock market news",
    ],
    authors: [{ name: post.author?.name || siteConfig.author }],
    openGraph: {
      type: "article",
      title,
      description,
      url: `${siteConfig.url}/blog/${params.slug}`,
      publishedTime: post.date,
      authors: [post.author?.name || siteConfig.author],
      images: [
        {
          url: post.ogImage?.url || siteConfig.ogImage,
          width: 1200,
          height: 630,
          alt: title,
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
      canonical: `${siteConfig.url}/blog/${params.slug}`,
      languages: {
        "en-AU": `${siteConfig.url}/blog/${params.slug}`,
        "en": `${siteConfig.url}/blog/${params.slug}`,
        "x-default": `${siteConfig.url}/blog/${params.slug}`,
      },
    },
    robots: {
      index: true,
      follow: true,
    },
  };
}
