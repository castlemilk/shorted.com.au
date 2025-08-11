import { notFound } from "next/navigation";
import { getAllPosts, getPostBySlug } from "@/lib/api";
import Container from "@/components/ui/container";
import { PostHeader } from "@/components/ui/post-header";
import { type Metadata } from "next";
import { MDXRemote } from "next-mdx-remote/rsc";
import { useMDXComponents } from "@/app/mdx-components";
import { type MDXComponents } from "mdx/types";
import { siteConfig } from "@/config/site";
import { ArticleSchema } from "@/components/seo/article-schema";
import { SocialShare } from "@/components/seo/social-share";
import { RelatedPosts } from "@/components/seo/related-posts";
import { calculateReadingTime, formatReadingTime } from "@/utils/reading-time";

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

  const components: MDXComponents = useMDXComponents({});
  const readingTime = calculateReadingTime(String(post.content));
  const postUrl = `${siteConfig.url}/blog/${params.slug}`;

  return (
    <main>
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
            <div className="flex items-center gap-4 text-sm text-gray-500 border-b border-gray-200 pb-4">
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
                  remarkPlugins: [],
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

  const title = `${post.title} | ${siteConfig.name}`;
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
      card: "summary_large_image",
      title,
      description,
      images: [post.ogImage?.url || siteConfig.ogImage],
    },
    alternates: {
      canonical: `${siteConfig.url}/blog/${params.slug}`,
    },
    robots: {
      index: true,
      follow: true,
    },
  };
}

export async function generateStaticParams() {
  const posts = getAllPosts();

  return posts.map((post) => ({
    slug: post.slug,
  }));
}
