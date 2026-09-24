import { type Metadata } from "next";
import Container from "~/@/components/ui/container";
import { HeroPost } from "~/@/components/ui/hero-post";
import { Intro } from "~/@/components/ui/intro";
import { MoreStories } from "~/@/components/ui/more-stories";
import { getAllPosts } from "~/@/lib/api";
import { MDXRemote } from "next-mdx-remote/rsc";
import remarkGfm from "remark-gfm";
import { type Post } from "~/@/interfaces/post";
import Info from "~/@/components/ui/info";
// Use client wrapper to avoid SSR issues with protobuf imports
import RegisterEmailClient from "~/@/components/ui/register-email-client";
// Lazy load Prism CSS only for blog pages
import "prismjs/themes/prism-tomorrow.css";
import { siteConfig } from "~/@/config/site";
// Live housing series for the house-price posts. Already an ssr:false client
// island (housing-charts.tsx), so it is safe to hand to MDX from this server
// component — the same posture as RegisterEmailClient below.
import { HousingSeriesChart } from "~/@/components/housing/housing-charts";

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

  const components = {
    // The index already carries the page's one <h1> (Intro); a post's own
    // title heading demotes to <h2> here, as it does on /blog/[slug]. The
    // crawl flagged this page for two H1s.
    h1: ({ children, ...props }: React.HTMLAttributes<HTMLHeadingElement>) => <h2 className="text-4xl font-bold mt-8 mb-4" {...props}>{children}</h2>,
    h2: ({ children, ...props }: React.HTMLAttributes<HTMLHeadingElement>) => <h2 className="text-3xl font-semibold mt-6 mb-3" {...props}>{children}</h2>,
    h3: ({ children, ...props }: React.HTMLAttributes<HTMLHeadingElement>) => <h3 className="text-2xl font-medium mt-4 mb-2" {...props}>{children}</h3>,
    h4: ({ children, ...props }: React.HTMLAttributes<HTMLHeadingElement>) => <h4 className="text-xl font-medium mt-3 mb-2" {...props}>{children}</h4>,
    h5: ({ children, ...props }: React.HTMLAttributes<HTMLHeadingElement>) => <h5 className="text-lg font-medium mt-2 mb-1" {...props}>{children}</h5>,
    h6: ({ children, ...props }: React.HTMLAttributes<HTMLHeadingElement>) => <h6 className="text-base font-medium mt-2 mb-1" {...props}>{children}</h6>,
    a: ({ children, ...props }: React.HTMLAttributes<HTMLAnchorElement>) => <a className="text-primary hover:underline" {...props}>{children}</a>,
    p: (props: React.HTMLAttributes<HTMLParagraphElement>) => <p className="mt-4 mb-4" {...props} />,
    ul: (props: React.HTMLAttributes<HTMLUListElement>) => <ul className="list-disc list-inside mt-2 mb-2" {...props} />,
    ol: (props: React.HTMLAttributes<HTMLOListElement>) => <ol className="list-decimal list-inside mt-2 mb-2" {...props} />,
    li: (props: React.HTMLAttributes<HTMLLIElement>) => <li className="mt-1 mb-1" {...props} />,
    table: (props: React.HTMLAttributes<HTMLTableElement>) => <table className="w-full mt-4 mb-4" {...props} />,
    tr: (props: React.HTMLAttributes<HTMLTableRowElement>) => <tr className="border-b border-border" {...props} />,
    th: (props: React.HTMLAttributes<HTMLTableCellElement>) => <th className="px-4 py-2 text-left" {...props} />,
    td: (props: React.HTMLAttributes<HTMLTableCellElement>) => <td className="px-4 py-2 text-left" {...props} />,
    RegisterEmail: (props: Record<string, unknown>) => <RegisterEmailClient {...props} />,
    Info: (props: { title: string; children: React.ReactNode }) => <Info {...props} />,
    HousingChart: (props: { regionCode: string; measure: string; dwellingType?: string; format?: "aud" | "percent" | "index"; ariaLabel: string; height?: number }) => (
      <HousingSeriesChart {...props} />
    ),
  };

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
