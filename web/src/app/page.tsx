import { type Metadata } from "next";
import { siteConfig } from "~/@/config/site";
import { HomeContent } from "./home-content";

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
        alt: "Shorted - ASX Short Position Tracker",
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

export default function Page() {
  return (
    <main className="min-h-screen flex flex-col bg-transparent">
      {/* Page header with SEO-optimized content */}
      <header className="container mx-auto px-4 pt-8 pb-4">
        <h1 className="text-2xl md:text-3xl font-bold tracking-tight text-foreground">
          ASX Short Position Tracker
        </h1>
        <p className="text-muted-foreground mt-2 max-w-2xl">
          Daily ASIC short selling data for Australian stocks. Track the most shorted
          positions, analyze trends, and explore industry breakdowns.
        </p>
        {/* Extended description for SEO - visually hidden but accessible */}
        <p className="sr-only">
          Shorted.com.au provides free daily short position data sourced from ASIC,
          featuring interactive charts, industry heatmaps, and comprehensive analysis
          of the most shorted stocks in Australia. Monitor short interest trends,
          compare positions across industries, and make informed investment decisions
          with real-time ASX short selling data.
        </p>
      </header>

      {/* Interactive dashboard content */}
      <HomeContent />
    </main>
  );
}
