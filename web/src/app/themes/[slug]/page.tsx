import { type Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";

import { cn } from "~/@/lib/utils";
import { pageTitle, eyebrow } from "~/@/lib/typography";
import { siteConfig } from "~/@/config/site";
import { DashboardLayout } from "~/@/components/layouts/dashboard-layout";
import { Breadcrumbs } from "~/@/components/seo/breadcrumbs";
import {
  BreadcrumbListSchema,
  DatasetStructuredData,
  ItemListStructuredData,
} from "~/@/components/seo/enhanced-structured-data";
import { ShortInterestTable } from "~/@/components/shorts/short-interest-table";
import { ThemeShortInterestChart } from "~/@/components/themes/theme-charts";
import { getTheme, THEMES, THEME_SLUGS } from "~/@/lib/themes/registry";
import { createSlug } from "~/@/lib/industry-slug";
import { getThemeSnapshot, type ThemeStats } from "~/app/actions/getThemeData";
import { getStockHeadlines, type StockHeadline } from "~/app/actions/getStockNews";
import { bailOnEmptyRender } from "~/app/actions/config";

interface PageProps {
  params: Promise<{ slug: string }>;
}

// Static ISR with prerendered params. NOT /scans' force-dynamic: this page
// fans out to the backend three ways plus a news read per member, and paying
// that per request rather than per hour is the difference between a cheap page
// and an expensive one. The cold-build hazard force-dynamic exists to dodge
// (baking an empty shell that survives until the first good revalidation) is
// handled instead by bailOnEmptyRender() below, the same way /price-drops and
// /economy handle it.
//
// No searchParams are read here — reading them silently forces dynamic
// rendering and throws the ISR away.
export const revalidate = 3600;
// A cold Cloud Run start plus the constituent news fan-out must not run into
// the default function budget and 504.
export const maxDuration = 60;

export function generateStaticParams() {
  return THEME_SLUGS.map((slug) => ({ slug }));
}

// How many members contribute headlines to the news strip. Each is an
// unstable_cache'd read shared with that stock's own page, so the marginal
// cost of a warm cache is nil; the cap bounds the COLD case.
const NEWS_MEMBERS = 6;
const NEWS_ITEMS = 8;

export async function generateMetadata({
  params,
}: PageProps): Promise<Metadata> {
  const { slug } = await params;
  const theme = getTheme(slug);
  if (!theme) {
    notFound();
  }
  const url = `${siteConfig.url}/themes/${theme.slug}`;
  return {
    title: theme.title,
    description: theme.description,
    keywords: theme.keywords,
    openGraph: {
      title: `${theme.title} | ${siteConfig.name}`,
      description: theme.description,
      url,
      siteName: siteConfig.name,
      type: "website",
      locale: "en_AU",
      // No `images` key: this route ships its own opengraph-image.tsx and an
      // explicit `images` here would SHADOW the file convention.
    },
    twitter: {
      site: "@shorted___",
      creator: "@shorted___",
      card: "summary_large_image",
      title: theme.title,
      description: theme.description,
    },
    alternates: {
      canonical: url,
      languages: { "en-AU": url, "x-default": url },
    },
  };
}

function formatAsOf(iso: string): string {
  if (!iso) return "";
  const d = new Date(`${iso}T00:00:00`);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleDateString("en-AU", {
    day: "numeric",
    month: "long",
    year: "numeric",
  });
}

function StatTile({
  label,
  value,
  sub,
}: {
  label: string;
  value: string;
  sub?: string;
}) {
  return (
    <div className="rounded-lg border border-border/60 bg-card/50 p-4">
      <p className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
        {label}
      </p>
      <p className="mt-1.5 text-2xl font-semibold tabular-nums leading-none">
        {value}
      </p>
      {sub ? (
        <p className="mt-1.5 text-xs text-muted-foreground">{sub}</p>
      ) : null}
    </div>
  );
}

function StatTiles({ stats }: { stats: ThemeStats }) {
  return (
    <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
      <StatTile
        label="Median short"
        value={`${stats.medianShortPct.toFixed(2)}%`}
        sub={`across ${stats.constituents} constituents`}
      />
      <StatTile
        label="Most shorted"
        value={stats.mostShorted?.code ?? "—"}
        sub={
          stats.mostShorted
            ? `${stats.mostShorted.shortPct.toFixed(2)}% of issued capital`
            : "no live short data"
        }
      />
      <StatTile
        label="Biggest 4-week riser"
        value={stats.biggestRiser?.code ?? "—"}
        sub={
          stats.biggestRiser
            ? `+${stats.biggestRiser.changePp.toFixed(2)}pp in 4 weeks`
            : "nothing rose over 4 weeks"
        }
      />
      <StatTile
        label="Above 5% short"
        value={String(stats.aboveFivePct)}
        sub={`of ${stats.constituents} constituents`}
      />
    </div>
  );
}

/**
 * Latest headlines across the theme's most-shorted members, newest first.
 *
 * Bounded fan-out (NEWS_MEMBERS), and every member is independently
 * failure-tolerant: getStockHeadlines already swallows its own errors, and the
 * per-member catch here means that even if it ever stops doing so, one sick
 * constituent drops out of the strip instead of 500ing the whole theme page.
 * A bare Promise.all would turn one bad read into a dead route.
 */
async function fetchThemeNews(codes: string[]): Promise<
  (StockHeadline & { code: string })[]
> {
  const perStock = await Promise.all(
    codes.slice(0, NEWS_MEMBERS).map(async (code) => {
      try {
        const headlines = await getStockHeadlines(code, 3);
        return headlines.map((headline) => ({ ...headline, code }));
      } catch (err) {
        console.warn(`[ThemePage] headlines failed for ${code}:`, err);
        return [];
      }
    }),
  );
  return perStock
    .flat()
    .filter((item) => item.headline && item.url)
    .sort((a, b) => (b.publishedAtIso ?? "").localeCompare(a.publishedAtIso ?? ""))
    .slice(0, NEWS_ITEMS);
}

export default async function ThemePage({ params }: PageProps) {
  const { slug } = await params;
  const theme = getTheme(slug);
  if (!theme) {
    notFound();
  }

  const snapshot = await getThemeSnapshot(theme.slug);
  const rows = snapshot?.rows ?? [];
  const series = snapshot?.series ?? [];
  const asOf = snapshot ? formatAsOf(snapshot.asOfDate) : "";

  // A failed/cold snapshot must not bake the copy-only shell into the route
  // cache for the whole revalidate window.
  if (rows.length === 0) bailOnEmptyRender();

  // News follows the table's own ordering (most shorted first), so the strip
  // covers the names a reader is actually here for.
  const news = rows.length
    ? await fetchThemeNews(rows.map((row) => row.code))
    : [];

  const breadcrumbItems = [
    { label: "Themes", href: "/themes" },
    { label: theme.h1, href: `/themes/${theme.slug}` },
  ];
  const breadcrumbsSchema = [
    { name: "Home", url: siteConfig.url },
    { name: "Themes", url: `${siteConfig.url}/themes` },
    { name: theme.h1, url: `${siteConfig.url}/themes/${theme.slug}` },
  ];

  return (
    <DashboardLayout>
      <BreadcrumbListSchema items={breadcrumbsSchema} />
      <DatasetStructuredData
        datasetInfo={{
          name: theme.h1,
          description: theme.description,
          url: `${siteConfig.url}/themes/${theme.slug}`,
          dateModified: snapshot?.asOfDate,
        }}
      />
      {rows.length > 0 && (
        <ItemListStructuredData
          name={theme.h1}
          description={theme.description}
          items={rows.slice(0, 15).map((r) => ({
            name: `${r.code} - ${r.name}`,
            url: `${siteConfig.url}/shorts/${r.code}`,
            description: `${r.shortPct.toFixed(2)}% short interest, ${
              r.shortPctChange4w > 0 ? "+" : ""
            }${r.shortPctChange4w.toFixed(2)}pp over 4 weeks`,
          }))}
        />
      )}

      <div className="space-y-8">
        <div className="mb-4">
          <Breadcrumbs items={breadcrumbItems} />
        </div>

        <section className="border-b border-border/40 pb-6">
          <p className={cn(eyebrow, "mb-2 font-medium")}>
            <Link href="/themes" className="hover:text-foreground">
              Themes
            </Link>
          </p>
          <h1 className={cn(pageTitle, "leading-[1.1]")}>{theme.h1}</h1>
          <p className="mt-2 max-w-3xl text-muted-foreground">{theme.dek}</p>
          {asOf && (
            <p className="mt-3 text-sm text-muted-foreground">
              {rows.length} constituents · short positions as of{" "}
              <time
                dateTime={snapshot!.asOfDate}
                className="font-medium text-foreground"
              >
                {asOf}
              </time>{" "}
              · ASIC data, T+4 delay
            </p>
          )}
        </section>

        {snapshot && rows.length > 0 ? (
          <section aria-label={`${theme.h1} summary`}>
            <StatTiles stats={snapshot.stats} />
          </section>
        ) : null}

        {series.length > 0 ? (
          <section aria-labelledby="theme-chart-heading">
            <div className="mb-2 flex flex-wrap items-baseline justify-between gap-x-6 gap-y-1">
              <h2
                id="theme-chart-heading"
                className="text-lg font-semibold tracking-tight"
              >
                Theme short interest over time
              </h2>
              <span className="text-xs text-muted-foreground">
                Weekly average · shaded band is the constituent range
              </span>
            </div>
            <ThemeShortInterestChart points={series} themeName={theme.h1} />
          </section>
        ) : null}

        {rows.length > 0 ? (
          <section aria-label={`${theme.h1} constituents`}>
            <h2 className="mb-2 text-lg font-semibold tracking-tight">
              Constituents
            </h2>
            <ShortInterestTable rows={rows} caption={theme.h1} />
            <p className="mt-2 text-xs text-muted-foreground">
              Membership is curated and verified against company metadata — a
              wrong member is worse than a missing one. Refine further in the{" "}
              <Link href="/screener" className="text-primary hover:underline">
                screener
              </Link>
              .
            </p>
          </section>
        ) : (
          <section className="rounded-lg border border-border/60 bg-card/50 p-6 text-sm text-muted-foreground">
            {snapshot
              ? "No live short data for this theme's constituents — check back after the next ASIC data drop."
              : "Theme data is temporarily unavailable; it refreshes automatically."}
          </section>
        )}

        {news.length > 0 ? (
          <section aria-labelledby="theme-news-heading">
            <h2
              id="theme-news-heading"
              className="mb-2 text-lg font-semibold tracking-tight"
            >
              Latest {theme.name.toLowerCase()} news
            </h2>
            <ul className="divide-y rounded-lg border border-border/60">
              {news.map((item) => (
                <li key={`${item.code}-${item.id || item.url}`} className="px-4 py-2.5">
                  <a
                    href={item.url}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-sm leading-snug hover:text-primary hover:underline"
                  >
                    {item.headline}
                  </a>
                  <p className="mt-0.5 text-xs text-muted-foreground">
                    <Link
                      href={`/shorts/${item.code}`}
                      className="hover:text-foreground"
                    >
                      {item.code}
                    </Link>
                    {item.source ? ` · ${item.source}` : ""}
                    {item.publishedAtIso
                      ? ` · ${new Date(item.publishedAtIso).toLocaleDateString(
                          "en-AU",
                          { day: "numeric", month: "short", year: "numeric" },
                        )}`
                      : ""}
                  </p>
                </li>
              ))}
            </ul>
          </section>
        ) : null}

        <section
          id="about"
          aria-labelledby="about-heading"
          className="max-w-3xl space-y-3"
        >
          <h2 id="about-heading" className="text-lg font-semibold">
            About this theme
          </h2>
          <p className="text-sm leading-relaxed text-muted-foreground">
            {theme.blurb}
          </p>
          <p className="text-sm leading-relaxed text-muted-foreground">
            Short positions come from official ASIC short position reports
            (published with a T+4 trading-day delay) joined with daily price and
            volume data. The chart averages the constituents reporting in each
            week and shades the range between the least and most shorted of
            them; a member with no data that week is absent from the average
            rather than counted as zero.
          </p>
        </section>

        <section
          aria-labelledby="related-heading"
          className="border-t border-border/40 pt-6"
        >
          <h2
            id="related-heading"
            className="text-xs font-medium uppercase tracking-wider text-muted-foreground"
          >
            Related themes
          </h2>
          <ul className="mt-3 flex flex-wrap gap-x-6 gap-y-2 text-sm">
            {theme.relatedThemes.map((relSlug) => {
              const rel = THEMES[relSlug];
              if (!rel) return null;
              return (
                <li key={relSlug}>
                  <Link
                    href={`/themes/${rel.slug}`}
                    className="text-primary hover:underline"
                  >
                    {rel.h1}
                  </Link>
                </li>
              );
            })}
          </ul>

          {theme.relatedIndustries.length > 0 ? (
            <>
              <h2 className="mt-6 text-xs font-medium uppercase tracking-wider text-muted-foreground">
                Related industries
              </h2>
              <ul className="mt-3 flex flex-wrap gap-x-6 gap-y-2 text-sm">
                {theme.relatedIndustries.map((industry) => (
                  <li key={industry}>
                    <Link
                      href={`/industry/${createSlug(industry)}`}
                      className="text-primary hover:underline"
                    >
                      {industry}
                    </Link>
                  </li>
                ))}
              </ul>
            </>
          ) : null}

          <ul className="mt-6 flex flex-wrap gap-x-6 gap-y-2 text-sm">
            <li>
              <Link href="/themes" className="text-primary hover:underline">
                All themes
              </Link>
            </li>
            <li>
              <Link href="/scans" className="text-primary hover:underline">
                Short interest scans
              </Link>
            </li>
            <li>
              <Link href="/top" className="text-primary hover:underline">
                Most shorted ASX stocks
              </Link>
            </li>
            <li>
              <Link href="/statistics" className="text-primary hover:underline">
                ASX short selling statistics
              </Link>
            </li>
          </ul>
        </section>
      </div>
    </DashboardLayout>
  );
}
