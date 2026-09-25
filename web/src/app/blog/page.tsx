import { type Metadata } from "next";
import Container from "~/@/components/ui/container";
import { HeroPost } from "~/@/components/ui/hero-post";
import { Intro } from "~/@/components/ui/intro";
import { MoreStories } from "~/@/components/ui/more-stories";
import { getAllPosts } from "~/@/lib/api";
import { MDXRemote } from "next-mdx-remote/rsc";
import remarkGfm from "remark-gfm";
import { type Post } from "~/@/interfaces/post";
// Lazy load Prism CSS only for blog pages
import "prismjs/themes/prism-tomorrow.css";
import { siteConfig } from "~/@/config/site";
import { blogMdxComponents } from "~/@/components/blog/mdx-components";

export const metadata: Metadata = {
  title: "ASX Short Selling Blog — Analysis & Insights",
  description:
    "Expert analysis and insights on ASX short selling. Learn about short squeezes, market trends, ASIC reporting, and strategies for tracking bearish sentiment in Australian stocks.",
  keywords: [
    "ASX short selling blog",
    "short selling analysis",
    "Australian stock market insights",
    "short squeeze analysis",
    "ASIC short position insights",
    "market sentiment Australia",
    "short interest strategies",
  ],
  openGraph: {
    title: "Short Selling Insights & Analysis | Shorted Blog",
    description:
      "Expert analysis and insights on ASX short selling. Learn about short squeezes, market trends, and strategies.",
    url: `${siteConfig.url}/blog`,
    siteName: siteConfig.name,
    type: "website",
    locale: "en_AU",
  },
  twitter: {
    site: "@shorted___",
    creator: "@shorted___",
    card: "summary_large_image",
    title: "Short Selling Insights & Analysis | Shorted Blog",
    description:
      "Expert analysis and insights on ASX short selling.",
  },
  alternates: {
    canonical: `${siteConfig.url}/blog`,
  },
};

export const revalidate = 3600; // Revalidate every hour

export default async function Index() {
  const allPosts: Post[] = getAllPosts();
  const heroPost = allPosts[0];
  const morePosts = allPosts.slice(1);

  const components = blogMdxComponents;

  return (
    <main>
      <Container>
        <Intro />
        {heroPost && (
          <HeroPost
            title={heroPost.title}
            coverImage={heroPost.coverImage}
            date={heroPost.date}
            author={heroPost.author}
            slug={heroPost.slug}
            excerpt={heroPost.excerpt}
          >
            <div className="max-w-2xl mx-auto custom-mdx-content">
              {/* remark-gfm as on /blog/[slug]: the hero post is rendered in
                  full here, and the house-price posts carry GFM tables. */}
              <MDXRemote
                source={heroPost.content}
                components={components}
                options={{ mdxOptions: { remarkPlugins: [remarkGfm] } }}
              />
            </div>
          </HeroPost>
        )}
        {morePosts.length > 0 && <MoreStories posts={morePosts} />}
      </Container>
    </main>
  );
}
