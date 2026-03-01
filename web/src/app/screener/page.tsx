import { type Metadata } from "next";
import { Suspense } from "react";
import dynamic from "next/dynamic";
import { siteConfig } from "~/@/config/site";

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

  const title = presetMeta
    ? `${presetMeta.title} | ${siteConfig.name}`
    : `Stock Screener | ${siteConfig.name}`;
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
    },
    alternates: {
      canonical: preset
        ? `${siteConfig.url}/screener?preset=${preset}`
        : `${siteConfig.url}/screener`,
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

export default function ScreenerPage() {
  return (
    <main className="min-h-[calc(100vh-4rem)]">
      <Suspense fallback={<ScreenerSkeleton />}>
        <ScreenerPageClient />
      </Suspense>
    </main>
  );
}
