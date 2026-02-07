import { type Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { Building2, ChevronRight, ArrowLeft } from "lucide-react";
import { siteConfig } from "~/@/config/site";
import { DashboardLayout } from "~/@/components/layouts/dashboard-layout";
import { Badge } from "~/@/components/ui/badge";
import {
  BreadcrumbListSchema,
} from "~/@/components/seo/enhanced-structured-data";
import { Breadcrumbs } from "~/@/components/seo/breadcrumbs";
import { cn } from "~/@/lib/utils";

const PRODUCTION_API_URL = "https://api.shorted.com.au";

interface TopShortsTimeSeries {
  productCode?: string;
  name?: string;
  latestShortPosition?: number;
}

interface TopShortsResponse {
  timeSeries: TopShortsTimeSeries[];
}

/**
 * Fetch all stocks via direct JSON fetch to GetTopShorts.
 * Uses plain fetch to avoid protobuf-es SSR initialization overhead
 * that causes timeouts on Vercel serverless functions.
 */
async function getAllStocksForDirectory(): Promise<
  Array<{ code: string; name: string; shortPercent: number }>
> {
  try {
    const baseUrl =
      process.env.NEXT_PUBLIC_SHORTS_SERVICE_ENDPOINT ??
      process.env.NEXT_PUBLIC_API_URL ??
      PRODUCTION_API_URL;

    const response = await fetch(
      `${baseUrl}/shorts.v1alpha1.ShortedStocksService/GetTopShorts`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ period: "1y", limit: 1000, offset: 0 }),
        next: { revalidate: 3600 },
      },
    );

    if (!response.ok) {
      console.warn(`Directory API returned ${response.status}`);
      return [];
    }

    const data = (await response.json()) as TopShortsResponse;

    return (data.timeSeries || [])
      .filter(
        (ts): ts is Required<TopShortsTimeSeries> =>
          typeof ts.productCode === "string" && ts.productCode.length > 0,
      )
      .map((ts) => ({
        code: ts.productCode,
        name: ts.name || ts.productCode,
        shortPercent: ts.latestShortPosition ?? 0,
      }));
  } catch (error) {
    console.error("Failed to fetch stocks for directory:", error);
    return [];
  }
}

const LETTERS = "abcdefghijklmnopqrstuvwxyz".split("");

interface PageProps {
  params: Promise<{ letter: string }>;
}

export async function generateStaticParams() {
  return LETTERS.map((letter) => ({ letter }));
}

export async function generateMetadata({ params }: PageProps): Promise<Metadata> {
  const { letter } = await params;
  const upperLetter = letter.toUpperCase();

  if (!LETTERS.includes(letter.toLowerCase())) {
    return { title: "Not Found" };
  }

  const title = `ASX Stocks Starting with ${upperLetter} | Stock Directory | ${siteConfig.name}`;
  const description = `Browse all ASX listed companies starting with "${upperLetter}" with current short position data from official ASIC reports.`;

  return {
    title,
    description,
    keywords: [
      `ASX stocks starting with ${upperLetter}`,
      `${upperLetter} ASX companies`,
      "ASX stock directory",
      "Australian stocks short positions",
    ],
    openGraph: {
      title,
      description,
      url: `${siteConfig.url}/directory/${letter}`,
      siteName: siteConfig.name,
      type: "website",
      locale: "en_AU",
    },
    twitter: {
      card: "summary",
      title,
      description,
    },
    alternates: {
      canonical: `${siteConfig.url}/directory/${letter}`,
    },
  };
}

export const revalidate = 3600; // Revalidate hourly — data fetches may fail on first build

export default async function DirectoryLetterPage({ params }: PageProps) {
  const { letter } = await params;
  const normalizedLetter = letter.toLowerCase();

  if (!LETTERS.includes(normalizedLetter)) {
    notFound();
  }

  const upperLetter = normalizedLetter.toUpperCase();

  // Fetch all stocks via direct JSON fetch (fast, avoids protobuf-es SSR overhead)
  const allStocks = await getAllStocksForDirectory();
  const stocks = allStocks
    .filter((s) => s.code.startsWith(upperLetter))
    .sort((a, b) => a.code.localeCompare(b.code));

  const breadcrumbItems = [
    { label: "Directory", href: "/directory" },
    { label: upperLetter, href: `/directory/${normalizedLetter}` },
  ];

  const breadcrumbsSchema = [
    { name: "Home", url: siteConfig.url },
    { name: "Directory", url: `${siteConfig.url}/directory` },
    { name: upperLetter, url: `${siteConfig.url}/directory/${normalizedLetter}` },
  ];

  // Prev/next letter navigation
  const letterIndex = LETTERS.indexOf(normalizedLetter);
  const prevLetter = letterIndex > 0 ? LETTERS[letterIndex - 1] : null;
  const nextLetter = letterIndex < LETTERS.length - 1 ? LETTERS[letterIndex + 1] : null;

  return (
    <DashboardLayout>
      <BreadcrumbListSchema items={breadcrumbsSchema} />

      <div className="space-y-8">
        {/* Breadcrumbs */}
        <div className="mb-4">
          <Breadcrumbs items={breadcrumbItems} />
        </div>

        {/* Back link */}
        <Link
          href="/directory"
          className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground transition-colors"
        >
          <ArrowLeft className="h-3.5 w-3.5" />
          Back to Directory
        </Link>

        {/* Hero */}
        <section className="border-b border-border/40 pb-8">
          <div className="flex items-center gap-3 mb-4">
            <div className="p-3 bg-primary/10 rounded-lg">
              <Building2 className="h-8 w-8 text-primary" />
            </div>
            <div>
              <h1 className="text-3xl md:text-4xl font-bold tracking-tight">
                ASX Stocks: {upperLetter}
              </h1>
              <p className="text-muted-foreground mt-1">
                {stocks.length} companies starting with &quot;{upperLetter}&quot;
              </p>
            </div>
          </div>
        </section>

        {/* Letter Navigation */}
        <section className="flex flex-wrap gap-1">
          {LETTERS.map((l) => (
            <Link
              key={l}
              href={`/directory/${l}`}
              className={cn(
                "flex items-center justify-center h-8 w-8 rounded text-sm font-semibold transition-colors",
                l === normalizedLetter
                  ? "bg-primary text-primary-foreground"
                  : "border border-border hover:bg-muted"
              )}
            >
              {l.toUpperCase()}
            </Link>
          ))}
        </section>

        {/* Stock Table */}
        {stocks.length > 0 ? (
          <section>
            <div className="rounded-lg border border-border/60 overflow-hidden bg-card/50 backdrop-blur-sm">
              {/* Header */}
              <div className="grid grid-cols-[80px_1fr_100px_48px] md:grid-cols-[100px_1fr_120px_48px] gap-4 px-4 py-3 bg-muted/50 border-b border-border/60 text-xs font-medium text-muted-foreground uppercase tracking-wider">
                <div>Code</div>
                <div>Company</div>
                <div className="text-right">Short %</div>
                <div></div>
              </div>

              {/* Rows */}
              <div className="divide-y divide-border/40">
                {stocks.map((stock) => (
                  <Link
                    key={stock.code}
                    href={`/shorts/${stock.code}`}
                    className="grid grid-cols-[80px_1fr_100px_48px] md:grid-cols-[100px_1fr_120px_48px] gap-4 px-4 py-3 items-center hover:bg-muted/50 transition-colors group"
                  >
                    <div className="font-semibold text-foreground group-hover:text-primary transition-colors">
                      {stock.code}
                    </div>
                    <div className="text-sm text-muted-foreground truncate">
                      {stock.name}
                    </div>
                    <div className="text-right">
                      <span
                        className={cn(
                          "inline-block px-2 py-0.5 rounded text-sm font-semibold tabular-nums",
                          stock.shortPercent >= 10 && "text-red-500",
                          stock.shortPercent >= 5 && stock.shortPercent < 10 && "text-orange-500",
                          stock.shortPercent < 5 && "text-foreground/70"
                        )}
                      >
                        {stock.shortPercent.toFixed(2)}%
                      </span>
                    </div>
                    <div className="flex justify-end">
                      <ChevronRight className="h-4 w-4 text-muted-foreground group-hover:text-foreground transition-colors" />
                    </div>
                  </Link>
                ))}
              </div>
            </div>
          </section>
        ) : (
          <section className="text-center py-12">
            <p className="text-muted-foreground">
              No stocks starting with &quot;{upperLetter}&quot; found with active short positions.
            </p>
          </section>
        )}

        {/* Prev/Next Navigation */}
        <section className="flex justify-between pt-4">
          {prevLetter ? (
            <Link href={`/directory/${prevLetter}`}>
              <Badge variant="outline" className="hover:bg-primary/10 cursor-pointer">
                <ArrowLeft className="h-3 w-3 mr-1" />
                Stocks: {prevLetter.toUpperCase()}
              </Badge>
            </Link>
          ) : (
            <div />
          )}
          {nextLetter ? (
            <Link href={`/directory/${nextLetter}`}>
              <Badge variant="outline" className="hover:bg-primary/10 cursor-pointer">
                Stocks: {nextLetter.toUpperCase()}
                <ChevronRight className="h-3 w-3 ml-1" />
              </Badge>
            </Link>
          ) : (
            <div />
          )}
        </section>
      </div>
    </DashboardLayout>
  );
}
