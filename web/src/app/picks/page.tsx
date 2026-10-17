import { type Metadata } from "next";
import Link from "next/link";

import { cn } from "~/@/lib/utils";
import { eyebrow, lede, pageTitle, sectionTitle } from "~/@/lib/typography";
import { siteConfig } from "~/@/config/site";
import { DashboardLayout } from "~/@/components/layouts/dashboard-layout";
import { Breadcrumbs } from "~/@/components/seo/breadcrumbs";
import {
  BreadcrumbListSchema,
  ItemListStructuredData,
} from "~/@/components/seo/enhanced-structured-data";
import { RegimeBanner } from "~/@/components/picks/regime-banner";
import { PicksProvenance } from "~/@/components/picks/picks-provenance";
import { RuleLegend, StatusLamp } from "~/@/components/picks/picks-table";
import { StatusChain } from "~/@/components/picks/status-chain";
import {
  StrategyCard,
  type StrategyCardProps,
} from "~/@/components/picks/strategy-card";
import { STRATEGIES, STRATEGY_SLUGS } from "~/@/lib/strategies/registry";
import { firstNonEmpty } from "~/@/lib/strategies/format";
import {
  STATUS_DESCRIPTIONS,
  STATUS_LABELS,
  countByStatus,
} from "~/@/lib/strategies/shortlist";
import { PICK_STATUSES } from "~/@/lib/strategies/types";
import { getStrategies } from "~/app/actions/getStrategies";
import {
  getStrategyPicks,
  type StrategyPicksResult,
} from "~/app/actions/getStrategyPicks";
import { bailOnEmptyRender } from "~/app/actions/config";

const TITLE = "ASX Stock Picker: Named Strategy Screens";
const DESCRIPTION =
  "Pick a strategy (Zanger breakouts, CAN SLIM, Minervini's Trend Template, crowded-short breakouts or quality compounders) and see which ASX stocks fit.";
const PAGE_URL = `${siteConfig.url}/picks`;

export const metadata: Metadata = {
  title: TITLE,
  description: DESCRIPTION,
  keywords: [
    "asx stock picker",
    "asx stock screener strategies",
    "breakout stocks asx",
    "can slim asx",
    "minervini trend template asx",
    "dan zanger strategy",
    "quality stocks asx",
    "high roe stocks asx",
  ],
  openGraph: {
    title: `${TITLE} | ${siteConfig.name}`,
    description: DESCRIPTION,
    url: PAGE_URL,
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
    title: TITLE,
    description: DESCRIPTION,
  },
  alternates: {
    canonical: PAGE_URL,
    languages: { "en-AU": PAGE_URL, "x-default": PAGE_URL },
  },
};

// Static ISR, like /themes/[slug]: the hub fans out to the API six ways
// (the list plus one picks read per strategy), which is worth paying per hour,
// not per request. The picks reads share their cache entries with the
// strategy pages. A cold or failed read is handled by bailOnEmptyRender()
// below rather than force-dynamic. No searchParams are read here.
export const revalidate = 3600;

const breadcrumbs = [
  { name: "Home", url: siteConfig.url },
  { name: "Stock picker", url: PAGE_URL },
];

/** How many names each row previews. */
const LEADERS_PER_CARD = 3;

function cardFor(
  slug: string,
  picks: StrategyPicksResult | null,
  apiStrategy: { name: string; author: string; tagline: string } | undefined,
): StrategyCardProps {
  const seo = STRATEGIES[slug]!;
  const strategy = picks?.strategy ?? apiStrategy;
  const counts = picks ? countByStatus(picks.picks, picks.totalCount) : null;
  return {
    slug,
    name: firstNonEmpty(strategy?.name, seo.label),
    author: strategy?.author ?? "",
    tagline: firstNonEmpty(strategy?.tagline, seo.dek),
    counts: counts ? { triggered: counts.triggered, setup: counts.setup } : null,
    leaders: (picks?.picks ?? [])
      .filter((row) => row.status === "triggered" || row.status === "setup")
      .slice(0, LEADERS_PER_CARD)
      .map((row) => ({
        code: row.code,
        name: row.name,
        logoUrl: row.logoUrl,
        status: row.status,
      })),
  };
}

export default async function PicksHubPage() {
  const [list, ...picks] = await Promise.all([
    getStrategies(),
    ...STRATEGY_SLUGS.map((slug) => getStrategyPicks(slug)),
  ]);

  // Any failed read would bake a degraded hub (no regime, cards without
  // counts) into the route cache for the whole hour: shorten this render's
  // lifetime instead so a recovered API shows up within a minute.
  if (!list || picks.some((result) => result === null)) {
    await bailOnEmptyRender();
  }

  const apiById = new Map((list?.strategies ?? []).map((s) => [s.id, s]));
  const cards = STRATEGY_SLUGS.map((slug, index) =>
    cardFor(slug, picks[index] ?? null, apiById.get(slug)),
  );
  const provenanceSource = picks.find((result): result is StrategyPicksResult =>
    Boolean(result),
  );

  return (
    <DashboardLayout>
      <BreadcrumbListSchema items={breadcrumbs} />
      <ItemListStructuredData
        name="ASX Stock Picker strategies"
        description={DESCRIPTION}
        itemType="WebPage"
        items={cards.map((card) => ({
          name: STRATEGIES[card.slug]!.h1,
          url: `${siteConfig.url}/picks/${card.slug}`,
          description: STRATEGIES[card.slug]!.description,
        }))}
      />

      <div className="space-y-8">
        <div className="mb-4">
          <Breadcrumbs items={[{ label: "Stock picker", href: "/picks" }]} />
        </div>

        {/* The desk switches on: a 320ms phosphor warm-up from 0.45 opacity,
            so the H1 is painted (and is the LCP) from the first frame. */}
        <section className="border-b border-border/40 pb-6 motion-safe:animate-phosphor-warm">
          <p className={cn(eyebrow, "mb-2 font-medium")}>Stock picker</p>
          <h1 className={cn(pageTitle, "leading-[1.1]")}>ASX Stock Picker</h1>
          <p className={cn(lede, "max-w-3xl")}>
            Choose a named strategy, then see the market regime and the ASX
            stocks that currently meet its rules. Every rule is shown for every
            stock as pass, fail or unknown, so you can see exactly why a name
            made the list and what it is still missing.
          </p>
          <div className="mt-3">
            <PicksProvenance
              asOf={provenanceSource?.asOf ?? ""}
              coverage={provenanceSource?.fundamentalsCoverageCount ?? 0}
              rowsCount={provenanceSource?.fundamentalsRowsCount ?? 0}
              universe={provenanceSource?.universeCount ?? 0}
            />
          </div>
        </section>

        <RegimeBanner regime={list?.regime ?? null} />

        {/* The rack: one hairline-divided chassis holding the five
            instruments as rows, which differ by glyph, counts and names
            rather than by chrome. One warm-up for the whole rack. */}
        <section aria-label="Strategies">
          <ol className="divide-y divide-border/60 overflow-hidden rounded-lg border border-border/60 bg-card motion-safe:animate-phosphor-warm motion-safe:[animation-delay:80ms]">
            {cards.map((card) => (
              <li key={card.slug}>
                <StrategyCard {...card} />
              </li>
            ))}
          </ol>
          {!list && picks.every((result) => result === null) ? (
            <p className="mt-3 text-sm text-muted-foreground">
              Live picks are temporarily unavailable; they refresh
              automatically.
            </p>
          ) : null}
        </section>

        <section aria-labelledby="how-heading" className="max-w-4xl space-y-3">
          <h2 id="how-heading" className={sectionTitle}>
            How the picks work
          </h2>
          <p className="max-w-3xl text-sm leading-relaxed text-muted-foreground">
            Each strategy is a fixed set of rules taken from its author and
            tested every trading day against daily prices, the S&amp;P/ASX 200,
            reported company fundamentals and ASIC short positions. A rule is
            unknown when the data is missing, or when the figure is not
            meaningful for the company (a bank&apos;s cash conversion, say),
            and unknown never counts as a pass. Stocks are ranked by status
            first, then by a 0 to 100 score.
          </p>
          {/* The printed key: each status beside what it looks like as rule
              outcomes, and the dot marks themselves, so both are taught
              before a reader reaches a table. */}
          <dl className="grid gap-px overflow-hidden rounded-lg border border-border/60 bg-border/60 sm:grid-cols-2 lg:grid-cols-4">
            {PICK_STATUSES.map((status) => (
              <div key={status} className="bg-card p-4">
                <dt className="flex items-center gap-2 text-sm font-semibold">
                  <StatusLamp status={status} />
                  {STATUS_LABELS[status]}
                  <StatusChain status={status} />
                </dt>
                <dd className="mt-1 text-xs leading-relaxed text-muted-foreground">
                  {STATUS_DESCRIPTIONS[status]}
                </dd>
              </div>
            ))}
            <div className="bg-card p-4">
              <dt className="text-sm font-semibold">Rule marks</dt>
              <dd className="mt-1">
                <RuleLegend rules={[]} />
              </dd>
            </div>
          </dl>
        </section>

        <section className="border-t border-border/40 pt-6 text-sm text-muted-foreground">
          <p>
            Not financial advice: these are mechanical readings of published
            rules, not recommendations. See also:{" "}
            <Link href="/scans" className="text-primary hover:underline">
              short interest scans
            </Link>
            {" · "}
            <Link href="/screener" className="text-primary hover:underline">
              the screener
            </Link>
            {" · "}
            <Link href="/battlegrounds" className="text-primary hover:underline">
              short squeeze candidates
            </Link>
            .
          </p>
        </section>
      </div>
    </DashboardLayout>
  );
}
