import { type Metadata } from "next";
import { Suspense } from "react";
import dynamic from "next/dynamic";
import { siteConfig } from "~/@/config/site";
import { pageTitle } from "~/@/lib/typography";
import { BreadcrumbListSchema } from "~/@/components/seo/enhanced-structured-data";
import { ScreenerFallback } from "./screener-fallback";

const ScreenerPageClient = dynamic(
  () =>
    import("./screener-page-client").then((mod) => mod.ScreenerPageClient),
  {
    loading: () => <ScreenerSkeleton />,
    ssr: true,
  },
);

// Preset-specific metadata for SEO
const PRESET_META: Record<string, { title: string; description: string }> = {
  "short-squeeze": {
    title: "Short Squeeze Candidates ASX",
    description:
      "Find ASX stocks with high short interest, declining positions, and director buying — potential short squeeze candidates. Screener uses official ASIC data.",
  },
  "dividend-pressure": {
    title: "Dividend Stocks Under Pressure ASX",
    description:
      "High-yield ASX stocks with rising short interest, signalling potential dividend risk. Screen dividend aristocrats facing bearish pressure.",
  },
  "small-cap-bears": {
    title: "Most Shorted Small Cap ASX Stocks",
    description:
      "Small-cap ASX stocks with high and rising short interest. Find bearish sentiment in the small-cap space using official ASIC data.",
  },
  "director-buying-shorted": {
    title: "Director Buying Heavily Shorted ASX Stocks",
    description:
      "Heavily shorted ASX stocks where directors are buying with conviction. Insider buying vs short seller conviction — a key contrarian signal.",
  },
  "hard-to-cover": {
    title: "Hard to Cover Stocks ASX — High Days to Cover",
    description:
      "ASX stocks with high days-to-cover ratios (>5 days). Short sellers in these positions would struggle to exit quickly if the price moves against them.",
  },
};

interface ScreenerPageProps {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}

export async function generateMetadata({
  searchParams,
}: ScreenerPageProps): Promise<Metadata> {
  const params = await searchParams;
  const preset = typeof params.preset === "string" ? params.preset : undefined;
  const presetMeta = preset ? PRESET_META[preset] : undefined;

  const title = presetMeta ? presetMeta.title : "ASX Short Interest Screener — Free Stock Filters";
  const description =
    presetMeta?.description ??
    "Screen ASX stocks using short positions, price changes, fundamentals, director trades, and news sentiment. Pre-built presets for short squeeze candidates, dividend pressure, and more.";

  return {
    title,
    description,
    openGraph: {
      title,
      description,
      url: preset
        ? `${siteConfig.url}/screener?preset=${preset}`
        : `${siteConfig.url}/screener`,
      siteName: siteConfig.name,
      type: "website",
      locale: "en_AU",
    // No `images` key: this route ships its own opengraph-image.tsx and an
    // explicit `images` here would SHADOW the file convention.
    },
    twitter: {
      card: "summary_large_image",
      title,
      description,
    },
    alternates: {
      canonical: preset
        ? `${siteConfig.url}/screener?preset=${preset}`
        : `${siteConfig.url}/screener`,
      languages: {
        "en-AU": preset
          ? `${siteConfig.url}/screener?preset=${preset}`
          : `${siteConfig.url}/screener`,
        "x-default": preset
          ? `${siteConfig.url}/screener?preset=${preset}`
          : `${siteConfig.url}/screener`,
      },
    },
  };
}

function ScreenerSkeleton() {
  return (
    <div className="container mx-auto px-4 py-6 max-w-7xl">
      <div className="space-y-6">
        {/* Header */}
        <div className="space-y-2">
          <div className="h-8 w-48 bg-muted animate-pulse rounded" />
          <div className="h-4 w-96 bg-muted animate-pulse rounded" />
        </div>
        {/* Presets */}
        <div className="flex gap-2">
          {Array.from({ length: 4 }).map((_, i) => (
            <div
              key={i}
              className="h-8 w-40 bg-muted animate-pulse rounded-full"
            />
          ))}
        </div>
        {/* Table skeleton */}
        <div className="border rounded-lg">
          <div className="h-12 bg-muted/50 border-b" />
          {Array.from({ length: 10 }).map((_, i) => (
            <div
              key={i}
              className="h-12 border-b last:border-b-0 flex items-center px-4"
            >
              <div className="h-4 w-full bg-muted animate-pulse rounded" />
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

const breadcrumbs = [
  { name: "Home", url: siteConfig.url },
  { name: "Stock Screener", url: `${siteConfig.url}/screener` },
];

const webApplicationSchema = {
  "@context": "https://schema.org",
  "@type": "WebApplication",
  name: "ASX Stock Screener",
  description:
    "Screen ASX stocks by short interest, price changes, director trades, and news sentiment using official ASIC data.",
  url: `${siteConfig.url}/screener`,
  applicationCategory: "FinanceApplication",
  operatingSystem: "All",
  offers: {
    "@type": "Offer",
    price: "0",
    priceCurrency: "AUD",
  },
  provider: {
    "@type": "Organization",
    name: siteConfig.name,
    url: siteConfig.url,
  },
};

export default function ScreenerPage() {
  return (
    <main className="min-h-[calc(100vh-4rem)]">
      <BreadcrumbListSchema items={breadcrumbs} />
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: JSON.stringify(webApplicationSchema) }}
      />
      <div className="container mx-auto px-4 pt-6 pb-2 max-w-7xl">
        <h1 className={pageTitle}>
          ASX Short Interest Screener
        </h1>
        <p className="text-muted-foreground mt-2 max-w-2xl text-sm leading-relaxed">
          Filter and screen ASX-listed stocks by short interest levels, price
          movements, director trades, and news sentiment. Use pre-built presets
          to find short squeeze candidates, dividend stocks under pressure, or
          hard-to-cover positions. All data is sourced from official ASIC short
          position reports, updated daily with a T+4 trading day delay.
        </p>
      </div>
      <ScreenerFallback />
      <Suspense fallback={<ScreenerSkeleton />}>
        <ScreenerPageClient />
      </Suspense>
    </main>
  );
}
