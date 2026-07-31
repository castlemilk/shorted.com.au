import { type Metadata } from "next";
import { pageTitle } from "~/@/lib/typography";
import Link from "next/link";
import { GraduationCap, Clock, ChevronRight, BookOpen } from "lucide-react";
import { siteConfig } from "~/@/config/site";
import { DashboardLayout } from "~/@/components/layouts/dashboard-layout";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "~/@/components/ui/card";
import { Badge } from "~/@/components/ui/badge";
import { BreadcrumbListSchema } from "~/@/components/seo/enhanced-structured-data";
import { LLMMeta } from "~/@/components/seo/llm-meta";

export const metadata: Metadata = {
  title: "Learn Short Selling on the ASX — Free Guides",
  description:
    "Free educational guides on ASX short selling. Learn about ASIC reporting, T+4 delay, short squeezes, and how to read short interest data. Beginner to advanced tutorials.",
  keywords: [
    "learn short selling",
    "short selling guide",
    "ASX short selling tutorial",
    "ASIC short position guide",
    "how to read short interest",
    "short squeeze explained",
    "T+4 delay explained",
    "Australian short selling education",
  ],
  openGraph: {
    title: "Learn Short Selling | Educational Guides & Tutorials",
    description:
      "Free educational guides on ASX short selling for beginners to advanced investors.",
    url: `${siteConfig.url}/learn`,
    siteName: siteConfig.name,
    type: "website",
    locale: "en_AU",
    // No `images` key: this route ships its own opengraph-image.tsx and an
    // explicit `images` here would SHADOW the file convention.
  },
  twitter: {
    card: "summary_large_image",
    title: "Learn Short Selling | Educational Guides & Tutorials",
    description:
      "Free educational guides on ASX short selling.",
  },
  alternates: {
    canonical: `${siteConfig.url}/learn`,
  },
};

const breadcrumbs = [
  { name: "Home", url: siteConfig.url },
  { name: "Learn", url: `${siteConfig.url}/learn` },
];

// Educational articles
const articles = [
  {
    slug: "how-to-short-the-asx",
    title: "How to Short the ASX — Shorting Australian Stocks",
    description:
      "The complete guide to shorting the ASX: direct share borrowing, CFDs, put and XJO index options, and inverse ETFs like BEAR and BBOZ. Compare costs and risks, understand the legal requirements, and run the pre-trade checklist before shorting Australian stocks.",
    readTime: "16 min read",
    level: "Beginner",
    topics: ["Shorting the ASX", "CFDs", "Options", "Inverse ETFs"],
  },
  {
    slug: "what-is-short-selling",
    title: "What is Short Selling on the ASX?",
    description:
      "A beginner's guide to short selling on the Australian Securities Exchange. Understand how short selling works, why investors do it, and the risks involved.",
    readTime: "8 min read",
    level: "Beginner",
    topics: ["Short Selling", "ASX Basics", "Investment Strategy"],
  },
  {
    slug: "understanding-t4-delay",
    title: "Understanding ASIC's T+4 Delay",
    description:
      "Learn why ASIC short position data is delayed by 4 trading days and how this affects your analysis. Includes tips for interpreting delayed data.",
    readTime: "5 min read",
    level: "Beginner",
    topics: ["ASIC", "Data Analysis", "T+4 Delay"],
  },
  {
    slug: "how-to-read-short-interest",
    title: "How to Read Short Interest Data",
    description:
      "Master the art of interpreting short interest percentages, changes over time, and what high or low short interest signals about market sentiment.",
    readTime: "10 min read",
    level: "Intermediate",
    topics: ["Short Interest", "Technical Analysis", "Market Sentiment"],
  },
  {
    slug: "short-squeeze-mechanics",
    title: "Short Squeeze Mechanics Explained",
    description:
      "Deep dive into how short squeezes occur, warning signs to watch for, and famous ASX short squeeze examples. Learn to identify potential squeeze candidates.",
    readTime: "12 min read",
    level: "Intermediate",
    topics: ["Short Squeeze", "Market Dynamics", "Trading Strategy"],
  },
  {
    slug: "risk-management-shorted-stocks",
    title: "Risk Management for Shorted Stocks",
    description:
      "Strategies for managing risk when trading heavily shorted stocks. Includes position sizing, stop losses, and portfolio considerations.",
    readTime: "15 min read",
    level: "Advanced",
    topics: ["Risk Management", "Portfolio Strategy", "Trading"],
  },
  {
    slug: "sector-analysis-short-selling",
    title: "Sector Analysis for Short Selling",
    description:
      "Learn which ASX sectors attract the most short selling activity and why. Understand cyclical patterns, sector-specific risks, and how to analyze short interest by industry.",
    readTime: "10 min read",
    level: "Intermediate",
    topics: ["Sector Analysis", "Industry Trends", "Market Cycles"],
  },
  {
    slug: "building-a-watchlist",
    title: "Building a Short Interest Watchlist",
    description:
      "How to create and maintain an effective watchlist of heavily shorted stocks. Learn filtering criteria, monitoring strategies, and when to act on short interest signals.",
    readTime: "8 min read",
    level: "Beginner",
    topics: ["Watchlists", "Stock Screening", "Monitoring"],
  },
  {
    slug: "asx-short-selling-history",
    title: "History of Short Selling on the ASX",
    description:
      "Explore the evolution of short selling regulation and notable events in Australian markets. From early regulations to modern ASIC reporting requirements.",
    readTime: "12 min read",
    level: "Beginner",
    topics: ["History", "Regulation", "Market Events"],
  },
  {
    slug: "securities-lending-explained",
    title: "Securities Lending Explained",
    description:
      "Understand how securities lending works and its role in short selling. Learn about lending fees, risks, and how institutional investors participate in the lending market.",
    readTime: "10 min read",
    level: "Intermediate",
    topics: ["Securities Lending", "Institutional Trading", "Borrowing Costs"],
  },
  {
    slug: "short-selling-vs-put-options",
    title: "Short Selling vs Put Options: Key Differences",
    description:
      "Compare short selling with put options as bearish strategies. Understand the pros, cons, and use cases for each approach when betting against stocks.",
    readTime: "11 min read",
    level: "Advanced",
    topics: ["Options", "Trading Strategies", "Derivatives"],
  },
  {
    slug: "asic-short-selling-regulations",
    title: "ASIC Short Selling Regulations & Reporting Requirements",
    description:
      "Comprehensive guide to Australian short selling regulations including the Corporations Act 2001, ASIC Regulatory Guide 196, reporting thresholds, and the ASX short sales report.",
    readTime: "14 min read",
    level: "Intermediate",
    topics: [
      "ASIC Regulations",
      "Corporations Act 2001",
      "Regulatory Guide 196",
      "Short Selling Compliance",
    ],
  },
  {
    slug: "reading-short-interest-changes",
    title: "Interpreting Short Interest Changes Over Time",
    description:
      "Learn to analyze short interest trends and what rapid changes signal. Understand the difference between short covering, new short positions, and normal fluctuations.",
    readTime: "9 min read",
    level: "Intermediate",
    topics: ["Trend Analysis", "Short Covering", "Market Signals"],
  },
  {
    slug: "how-to-view-asic-short-positions",
    title: "How to View ASIC Short Position Reports on the ASX",
    description:
      "Step-by-step guide to finding and reading ASIC short position reports. Learn where to access daily short selling data on the ASIC website, ASX website, and through Shorted.com.au.",
    readTime: "10 min read",
    level: "Beginner",
    topics: ["ASIC Reports", "Short Position Data", "ASX Short Sales", "Data Access"],
  },
  {
    slug: "covered-short-selling-australia",
    title: "Covered Short Selling in Australia: How Retail Brokers Handle Stock Borrowing",
    description:
      "Understand how covered short selling works for retail investors in Australia. Learn about the stock locate process, broker requirements, borrowing fees, and which ASX stocks are available to short.",
    readTime: "12 min read",
    level: "Intermediate",
    topics: ["Covered Short Selling", "Stock Borrowing", "Retail Brokers", "Borrow Fees"],
  },
];

const levelColors = {
  Beginner: "bg-green-500/10 text-green-600 border-green-500/30",
  Intermediate: "bg-yellow-500/10 text-yellow-600 border-yellow-500/30",
  Advanced: "bg-red-500/10 text-red-600 border-red-500/30",
};

export default function LearnIndexPage() {
  return (
    <DashboardLayout>
      <BreadcrumbListSchema items={breadcrumbs} />
      <LLMMeta
        title="Learn Short Selling - Educational Guides & Tutorials"
        description="Free educational guides on ASX short selling. Learn about ASIC reporting, T+4 delay, short squeezes, and how to read short interest data."
        keywords={[
          "learn short selling",
          "short selling guide",
          "ASX short selling tutorial",
          "ASIC short position guide",
        ]}
        dataSource="ASIC"
        dataFrequency="static"
      />

      <div className="space-y-8">
        {/* Hero Section */}
        <section className="relative border-b border-border/40 pb-8">
          <div className="flex items-center gap-3 mb-4">
            <div className="p-3 bg-primary/10 rounded-lg">
              <GraduationCap className="h-8 w-8 text-primary" />
            </div>
            <div>
              <h1 className={pageTitle}>
                Learn Short Selling
              </h1>
              <p className="text-muted-foreground mt-1">
                Free educational guides for ASX investors
              </p>
            </div>
          </div>
          <p className="text-muted-foreground text-lg max-w-2xl">
            Whether you&apos;re new to short selling or looking to deepen your understanding,
            our educational content covers everything from basics to advanced strategies.
          </p>
        </section>

        {/* Quick Stats */}
        <section className="grid grid-cols-3 gap-4">
          <div className="text-center p-4 rounded-lg border border-border/60 bg-card/50">
            <div className="text-2xl font-bold text-primary">{articles.length}</div>
            <div className="text-sm text-muted-foreground">Guides</div>
          </div>
          <div className="text-center p-4 rounded-lg border border-border/60 bg-card/50">
            <div className="text-2xl font-bold text-primary">
              {articles.filter((a) => a.level === "Beginner").length}
            </div>
            <div className="text-sm text-muted-foreground">Beginner</div>
          </div>
          <div className="text-center p-4 rounded-lg border border-border/60 bg-card/50">
            <div className="text-2xl font-bold text-primary">Free</div>
            <div className="text-sm text-muted-foreground">Always</div>
          </div>
        </section>

        {/* Articles Grid */}
        <section>
          <h2 className="text-xl font-semibold mb-4 flex items-center gap-2">
            <BookOpen className="h-5 w-5 text-primary" />
            All Guides
          </h2>
          <div className="grid gap-4">
            {articles.map((article) => (
              <Link key={article.slug} href={`/learn/${article.slug}`} className="group">
                <Card className="h-full hover:shadow-md transition-all duration-200 hover:border-primary/50">
                  <CardHeader className="pb-3">
                    <div className="flex items-start justify-between gap-4">
                      <div className="flex-1">
                        <div className="flex items-center gap-2 mb-2">
                          <Badge
                            variant="outline"
                            className={levelColors[article.level as keyof typeof levelColors]}
                          >
                            {article.level}
                          </Badge>
                          <span className="flex items-center gap-1 text-xs text-muted-foreground">
                            <Clock className="h-3 w-3" />
                            {article.readTime}
                          </span>
                        </div>
                        <CardTitle className="text-lg group-hover:text-primary transition-colors">
                          {article.title}
                        </CardTitle>
                        <CardDescription className="mt-2">
                          {article.description}
                        </CardDescription>
                      </div>
                      <ChevronRight className="h-5 w-5 text-muted-foreground group-hover:text-primary transition-colors flex-shrink-0 mt-1" />
                    </div>
                  </CardHeader>
                  <CardContent>
                    <div className="flex flex-wrap gap-1">
                      {article.topics.map((topic) => (
                        <span
                          key={topic}
                          className="text-xs px-2 py-1 rounded bg-muted text-muted-foreground"
                        >
                          {topic}
                        </span>
                      ))}
                    </div>
                  </CardContent>
                </Card>
              </Link>
            ))}
          </div>
        </section>

        {/* Related Resources */}
        <section className="mt-12 pt-8 border-t border-border/40">
          <h2 className="text-lg font-semibold mb-4">Related Resources</h2>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <Link href="/glossary">
              <Card className="hover:shadow-md transition-all duration-200 hover:border-primary/50">
                <CardContent className="pt-6">
                  <div className="flex items-center gap-3">
                    <BookOpen className="h-5 w-5 text-primary" />
                    <div>
                      <div className="font-medium">Short Selling Glossary</div>
                      <div className="text-sm text-muted-foreground">
                        Key terms and definitions
                      </div>
                    </div>
                    <ChevronRight className="h-4 w-4 text-muted-foreground ml-auto" />
                  </div>
                </CardContent>
              </Card>
            </Link>
            <Link href="/top">
              <Card className="hover:shadow-md transition-all duration-200 hover:border-primary/50">
                <CardContent className="pt-6">
                  <div className="flex items-center gap-3">
                    <GraduationCap className="h-5 w-5 text-primary" />
                    <div>
                      <div className="font-medium">Top 100 Shorted Stocks</div>
                      <div className="text-sm text-muted-foreground">
                        Apply your knowledge
                      </div>
                    </div>
                    <ChevronRight className="h-4 w-4 text-muted-foreground ml-auto" />
                  </div>
                </CardContent>
              </Card>
            </Link>
          </div>
        </section>
      </div>
    </DashboardLayout>
  );
}
