import { type Metadata } from "next";
import { cn } from "~/@/lib/utils";
import { pageTitle, eyebrow, lede } from "~/@/lib/typography";
import dynamic from "next/dynamic";
import Link from "next/link";
import { siteConfig } from "~/@/config/site";
import {
  BreadcrumbListSchema,
  DatasetStructuredData,
  ItemListStructuredData,
} from "~/@/components/seo/enhanced-structured-data";
import { BattlegroundView } from "~/gen/shorts/v1alpha1/market_pb";
import { getBattlegrounds } from "~/app/actions/getBattlegrounds";
import { toBattlegroundRows, type BattlegroundRow } from "./types";

const BattlegroundsClient = dynamic(
  () =>
    import("./battlegrounds-client").then((mod) => mod.BattlegroundsClient),
  {
    loading: () => <BattlegroundsSkeleton />,
    ssr: true,
  },
);

// No "| Shorted" suffix — the root layout's title template appends it.
const TITLE = "ASX Short Squeeze Candidates — Battlegrounds Squeeze Radar";
const DESCRIPTION =
  "ASX short squeeze candidates scored daily: short interest, days to cover, price momentum, and short-position crowding combined into a 0-100 squeeze score. Official ASIC data, transparent methodology.";

export const metadata: Metadata = {
  title: TITLE,
  description: DESCRIPTION,
  keywords: [
    "short squeeze asx",
    "asx short squeeze candidates",
    "days to cover",
    "asx short squeeze stocks",
    "short squeeze australia",
    "asx squeeze radar",
    "battleground stocks asx",
    "asic short positions",
    "most shorted asx stocks",
  ],
  openGraph: {
    title: TITLE,
    description: DESCRIPTION,
    url: `${siteConfig.url}/battlegrounds`,
    siteName: siteConfig.name,
    type: "website",
    locale: "en_AU",
    images: [
      {
        url: siteConfig.ogImage,
        width: 1200,
        height: 630,
        alt: "ASX Short Squeeze Candidates — Shorted.com.au",
      },
    ],
  },
  twitter: {
    card: "summary_large_image",
    title: TITLE,
    description: DESCRIPTION,
    images: [siteConfig.ogImage],
  },
  alternates: {
    canonical: `${siteConfig.url}/battlegrounds`,
    languages: {
      "en-AU": `${siteConfig.url}/battlegrounds`,
      "x-default": `${siteConfig.url}/battlegrounds`,
    },
  },
};

function BattlegroundsSkeleton() {
  return (
    <div className="space-y-4">
      <div className="h-9 w-64 bg-muted animate-pulse rounded-lg" />
      <div className="h-4 w-96 bg-muted animate-pulse rounded" />
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
  );
}

const breadcrumbs = [
  { name: "Home", url: siteConfig.url },
  { name: "ASX Short Squeeze Candidates", url: `${siteConfig.url}/battlegrounds` },
];

/**
 * Server-rendered methodology — a citable, deep-linkable (#methodology)
 * explanation of the squeeze score. Keep in sync with the scoring SQL in
 * services/shorts/internal/store/shorts/postgres_battlegrounds.go.
 */
function MethodologySection() {
  return (
    <section
      id="methodology"
      aria-labelledby="methodology-heading"
      className="scroll-mt-24 border-t pt-8"
    >
      <h2
        id="methodology-heading"
        className="text-xl font-semibold tracking-tight"
      >
        How squeeze scores are calculated
      </h2>
      <div className="mt-3 max-w-3xl space-y-4 text-sm leading-relaxed text-muted-foreground">
        <p>
          Squeeze scores are recomputed daily from official ASIC short position
          reports — the same disclosures behind our{" "}
          <Link href="/top" className="underline underline-offset-2 hover:text-foreground">
            top 100 most shorted ASX stocks
          </Link>{" "}
          rankings. The universe is ASX equities (ETFs and debt securities are
          excluded) with reported short interest of at least 1% of issued
          capital. Each stock receives a score from 0 to 100, a weighted blend
          of four inputs:
        </p>
        <ul className="list-disc space-y-2 pl-5">
          <li>
            <strong className="font-medium text-foreground">
              Days-to-cover (35% weight)
            </strong>{" "}
            — reported short shares divided by the 20-trading-day average daily
            volume: an estimate of how many days of normal trading short
            sellers would need to buy back their entire position. Contribution
            is capped at 10 days. See{" "}
            <Link
              href="/glossary/days-to-cover"
              className="underline underline-offset-2 hover:text-foreground"
            >
              days to cover
            </Link>{" "}
            in the glossary.
          </li>
          <li>
            <strong className="font-medium text-foreground">
              Short interest (30%)
            </strong>{" "}
            — ASIC-reported short positions as a percentage of total shares on
            issue, capped at 15%.
          </li>
          <li>
            <strong className="font-medium text-foreground">
              Price momentum (20%)
            </strong>{" "}
            — the 1-month share price change. Only positive momentum
            contributes, since a rising price is what pressures short sellers;
            capped at +20%.
          </li>
          <li>
            <strong className="font-medium text-foreground">
              Crowding (15%)
            </strong>{" "}
            — the 4-week change in short interest. Only increases contribute,
            capped at +3 percentage points.
          </li>
        </ul>
        <p>
          A high score does not predict a squeeze — it flags the preconditions
          for one: a large, crowded short position that would take days of
          normal volume to unwind, in a stock already moving against the
          shorts. For how those preconditions turn into forced buying, see{" "}
          <Link
            href="/learn/short-squeeze-mechanics"
            className="underline underline-offset-2 hover:text-foreground"
          >
            short squeeze mechanics
          </Link>
          .
        </p>
        <p>
          The battlegrounds (divergence) view uses the same inputs differently:
          it surfaces only the stocks where the price rose over the past month
          while short interest also grew over the past four weeks, ranked by
          the intensity of that divergence.
        </p>
        <p>
          <strong className="font-medium text-foreground">
            A caveat on timing:
          </strong>{" "}
          ASIC publishes aggregate short positions with a T+4 trading-day
          delay, so the short interest behind these scores reflects positions
          from four trading days ago while prices are more recent. A
          fast-moving squeeze can be partially covered before it shows up in
          the data.
        </p>
      </div>
    </section>
  );
}

export default async function BattlegroundsPage() {
  // SSR-fetch the default squeeze view; on failure the client refetches
  const initial = await getBattlegrounds(BattlegroundView.SQUEEZE, 25, 0);
  const initialRows: BattlegroundRow[] | undefined = initial
    ? toBattlegroundRows(initial.stocks)
    : undefined;

  return (
    <main className="min-h-[calc(100vh-4rem)]">
      <BreadcrumbListSchema items={breadcrumbs} />
      <ItemListStructuredData
        name="Top ASX Short Squeeze Candidates"
        description="ASX stocks ranked by short squeeze score — days-to-cover, short interest, price momentum, and short-position crowding — computed daily from official ASIC short position data."
        items={(initialRows ?? []).slice(0, 10).map((row) => ({
          name: `${row.stockCode} - ${row.companyName}`,
          url: `${siteConfig.url}/shorts/${row.stockCode}`,
          description: `${row.stockCode} squeeze score ${row.squeezeScore.toFixed(1)}/100 — short interest ${row.shortPct.toFixed(1)}% of issued capital${row.daysToCover > 0 ? `, ${row.daysToCover.toFixed(1)} days to cover` : ""}`,
        }))}
      />
      <DatasetStructuredData
        datasetInfo={{
          name: "ASX Short Squeeze Candidates — Battlegrounds Squeeze Radar",
          description:
            "Daily 0-100 squeeze scores for ASX stocks, combining days-to-cover, short interest, price momentum, and short-position crowding from official ASIC short position reports.",
        }}
      />
      <div className="container mx-auto px-4 py-6 max-w-7xl space-y-6">
        <div>
          <p className={cn(eyebrow, "font-semibold")}>
            Battlegrounds
          </p>
          <h1 className={cn(pageTitle, "mt-1")}>
            ASX Short Squeeze Candidates
          </h1>
          <p className={cn(lede, "text-sm leading-relaxed")}>
            ASX short squeeze candidates, scored daily. The squeeze radar ranks
            stocks by squeeze risk — days-to-cover, short interest, price
            momentum, and short-position crowding — while the battlegrounds
            view surfaces live divergences where the price is rising even as
            shorts keep building. Sourced from official ASIC short position
            reports, updated daily with a T+4 trading day delay.{" "}
            <a
              href="#methodology"
              className="underline underline-offset-2 hover:text-foreground"
            >
              Read the methodology
            </a>
            .
          </p>
        </div>
        <BattlegroundsClient
          initialRows={initialRows}
          initialTotalCount={initial?.totalCount}
        />
        <MethodologySection />
      </div>
    </main>
  );
}
