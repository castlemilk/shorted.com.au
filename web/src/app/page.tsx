import { type Metadata } from "next";
import { siteConfig } from "~/@/config/site";
import { HomeContent } from "./home-content";
import { FAQStructuredData } from "~/@/components/seo/enhanced-structured-data";

export const metadata: Metadata = {
  title: siteConfig.fullTitle,
  description: siteConfig.description,
  keywords: siteConfig.keywords,
  openGraph: {
    title: siteConfig.fullTitle,
    description: siteConfig.description,
    url: siteConfig.url,
    siteName: siteConfig.name,
    type: "website",
    locale: "en_AU",
    images: [
      {
        url: siteConfig.ogImage,
        width: 1200,
        height: 630,
        alt: "Shorted - Official ASIC Short Position Data for ASX Stocks",
      },
    ],
  },
  twitter: {
    card: "summary_large_image",
    title: siteConfig.fullTitle,
    description: siteConfig.description,
    images: [siteConfig.ogImage],
  },
  alternates: {
    canonical: siteConfig.url,
  },
};

// FAQ data for rich snippets - targets common search queries
const homeFAQs = [
  {
    question: "What are short positions on the ASX?",
    answer:
      "Short positions represent shares borrowed and sold by investors betting a stock's price will fall. On the ASX, short sellers must report positions exceeding $100,000 or 0.01% of issued capital to ASIC. This data is published with a T+4 trading day delay.",
  },
  {
    question: "Where does ASX short selling data come from?",
    answer:
      "ASX short selling data is sourced from ASIC (Australian Securities and Investments Commission). Market participants are required to report their short positions daily, and ASIC publishes aggregated data with a 4 trading day delay (T+4).",
  },
  {
    question: "What are the most shorted stocks on the ASX?",
    answer:
      "The most shorted ASX stocks change daily based on ASIC reports. Typically, heavily shorted stocks include companies in sectors facing headwinds like lithium miners, retail, and property. Use our tracker to see the current top 100 most shorted stocks updated daily.",
  },
  {
    question: "Why is there a T+4 delay on ASIC short position data?",
    answer:
      "ASIC publishes short position data with a T+4 (4 trading day) delay to balance market transparency with preventing potential market manipulation. This means the data shown reflects positions from 4 trading days ago, not real-time figures.",
  },
];

export default function Page() {
  return (
    <main className="min-h-screen flex flex-col bg-transparent">
      {/* FAQ Structured Data for rich snippets */}
      <FAQStructuredData faqs={homeFAQs} />

      {/* Page header with SEO-optimized content */}
      <header className="container mx-auto px-4 pt-8 pb-4">
        <h1 className="text-2xl md:text-3xl font-bold tracking-tight text-foreground">
          ASX Short Position Data from ASIC
        </h1>
        <p className="text-muted-foreground mt-2 max-w-2xl">
          Official ASIC short selling data updated daily with T+4 delay. Track the most
          shorted ASX stocks, analyze historical trends, and explore industry heatmaps.
        </p>
        {/* Extended description for SEO - visually hidden but accessible */}
        <p className="sr-only">
          Shorted.com.au provides free daily short position data sourced directly from
          ASIC (Australian Securities and Investments Commission). View the top 100 most
          shorted stocks on the ASX, interactive historical charts, industry sector
          breakdowns, and comprehensive analysis. Data is updated daily with T+4 trading
          day delay as published by ASIC. Track short interest trends, identify heavily
          shorted companies, and monitor bearish sentiment across the Australian market.
        </p>
      </header>

      {/* Interactive dashboard content */}
      <HomeContent />
    </main>
  );
}
