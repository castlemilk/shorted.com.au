import { type Metadata } from "next";
import Link from "next/link";

import { cn } from "~/@/lib/utils";
import { pageTitle, eyebrow } from "~/@/lib/typography";
import { siteConfig } from "~/@/config/site";
import { DashboardLayout } from "~/@/components/layouts/dashboard-layout";
import { Breadcrumbs } from "~/@/components/seo/breadcrumbs";
import {
  BreadcrumbListSchema,
  ItemListStructuredData,
} from "~/@/components/seo/enhanced-structured-data";
import { THEMES } from "~/@/lib/themes/registry";
import { getThemeHubStats } from "~/app/actions/getThemeData";
import { bailOnEmptyRender } from "~/app/actions/config";

export const metadata: Metadata = {
  title: "ASX Stock Themes — Short Interest by Sector Basket",
  description:
    "Short interest across curated ASX baskets: lithium, uranium, rare earths, gold, iron ore, battery metals, software, AI and data centres, banks and biotech. Official ASIC data.",
  keywords: [
    "asx stock themes",
    "asx sector short interest",
    "lithium stocks asx",
    "uranium stocks asx",
    "rare earth stocks asx",
  ],
  openGraph: {
    title: "ASX Stock Themes | Shorted",
    description:
      "Short interest across curated ASX baskets — lithium, uranium, rare earths, gold, banks, biotech and more.",
    url: `${siteConfig.url}/themes`,
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
    title: "ASX Stock Themes",
    description:
      "Short interest across curated ASX baskets, from official ASIC data.",
  },
  alternates: {
    canonical: `${siteConfig.url}/themes`,
    languages: {
      "en-AU": `${siteConfig.url}/themes`,
      "x-default": `${siteConfig.url}/themes`,
    },
  },
};

// Static ISR rather than /scans' force-dynamic: the hub's body is registry
// copy that is correct with or without a backend, and the one live read is a
// single batched screener call per hour. bailOnEmptyRender() below is what
// keeps a cold/failed regeneration from baking stat-less cards for the window.
// No searchParams are read here — doing so would silently force dynamic
// rendering and throw the ISR away.
export const revalidate = 3600;

const breadcrumbs = [
  { name: "Home", url: siteConfig.url },
  { name: "Themes", url: `${siteConfig.url}/themes` },
];

export default async function ThemesIndexPage() {
  const themes = Object.values(THEMES);
  const stats = await getThemeHubStats(themes.map((theme) => theme.slug));
  if (Object.keys(stats).length === 0) bailOnEmptyRender();

  return (
    <DashboardLayout>
      <BreadcrumbListSchema items={breadcrumbs} />
      <ItemListStructuredData
        name="ASX Stock Themes"
        description="Curated ASX stock baskets ranked by short interest, from official ASIC data."
        items={themes.map((theme) => ({
          name: theme.h1,
          url: `${siteConfig.url}/themes/${theme.slug}`,
          description: theme.dek,
        }))}
      />
      <div className="space-y-8">
        <div className="mb-4">
          <Breadcrumbs items={[{ label: "Themes", href: "/themes" }]} />
        </div>

        <section className="border-b border-border/40 pb-6">
          <p className={cn(eyebrow, "mb-2 font-medium")}>Themes</p>
          <h1 className={cn(pageTitle, "leading-[1.1]")}>ASX Stock Themes</h1>
          <p className="mt-2 max-w-3xl text-muted-foreground">
            Hand-curated baskets of ASX codes — the lithium complex, the magnet
            stocks, the uranium restarts, the software multiples — each ranked
            by how much of its register is sold short. For a rule-based cut of
            the whole market instead, use the{" "}
            <Link href="/scans" className="text-primary hover:underline">
              daily scans
            </Link>{" "}
            or the{" "}
            <Link href="/screener" className="text-primary hover:underline">
              screener
            </Link>
            .
          </p>
        </section>

        <section aria-label="Available themes">
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            {themes.map((theme) => {
              const stat = stats[theme.slug];
              return (
                <Link
                  key={theme.slug}
                  href={`/themes/${theme.slug}`}
                  prefetch={false}
                  className="group block"
                >
                  <article className="flex h-full flex-col rounded-lg border border-border/60 bg-card/50 p-5 transition-colors hover:border-primary/40">
                    <h2 className="font-semibold leading-snug transition-colors group-hover:text-primary">
                      {theme.h1}
                    </h2>
                    <p className="mt-2 flex-1 text-sm leading-relaxed text-muted-foreground">
                      {theme.dek}
                    </p>
                    <p className="mt-3 text-xs text-muted-foreground">
                      {stat ? (
                        <>
                          <span className="font-medium tabular-nums text-foreground">
                            {stat.medianShortPct.toFixed(2)}%
                          </span>{" "}
                          median short interest ·{" "}
                        </>
                      ) : null}
                      {stat?.constituents ?? theme.tickers.length} stocks
                    </p>
                  </article>
                </Link>
              );
            })}
          </div>
        </section>

        <section className="border-t border-border/40 pt-6 text-sm text-muted-foreground">
          <p>
            Membership is curated by hand and verified against company metadata,
            not inferred from a sector label — a wrong member is worse than a
            missing one. Short positions come from official ASIC reports with a
            T+4 trading-day delay. See also:{" "}
            <Link href="/top" className="text-primary hover:underline">
              most shorted ASX stocks
            </Link>
            {" · "}
            <Link href="/scans" className="text-primary hover:underline">
              short interest scans
            </Link>
            {" · "}
            <Link
              href="/industry-intelligence"
              className="text-primary hover:underline"
            >
              industry intelligence
            </Link>
            .
          </p>
        </section>
      </div>
    </DashboardLayout>
  );
}
