import { type Metadata } from "next";
import { EmbedDialog } from "~/@/components/ui/embed-dialog";
import Link from "next/link";
import { siteConfig } from "~/@/config/site";
import { cn } from "~/@/lib/utils";
import { pageTitle, sectionTitle, eyebrow } from "~/@/lib/typography";
import { DashboardLayout } from "~/@/components/layouts/dashboard-layout";
import { Breadcrumbs } from "~/@/components/seo/breadcrumbs";
import {
  BreadcrumbListSchema,
  DatasetStructuredData,
} from "~/@/components/seo/enhanced-structured-data";
import { LLMMeta } from "~/@/components/seo/llm-meta";
import {
  getShortStatistics,
  type ShortStatistics,
} from "~/app/actions/getShortStatistics";

export const metadata: Metadata = {
  title: "ASX Short Selling Statistics — Total Dollars Shorted Today",
  description:
    "How much money is short-selling the ASX right now? Live aggregate short interest statistics: total dollars shorted, the big-four bank basket, sector totals, and 4-week movers — from official ASIC data, updated daily.",
  keywords: [
    "ASX short selling statistics",
    "total short positions ASX",
    "how much is shorted on the ASX",
    "ASX short interest total",
    "dollars shorted ASX banks",
    "ASIC short position statistics",
    "Australian short selling data",
  ],
  openGraph: {
    title: "ASX Short Selling Statistics — Total Dollars Shorted | Shorted",
    description:
      "Live aggregate ASX short interest: total dollars shorted, bank basket, sector totals. Official ASIC data.",
    url: `${siteConfig.url}/statistics`,
    siteName: siteConfig.name,
    type: "website",
    locale: "en_AU",
    images: [
      {
        url: siteConfig.ogImage,
        width: 1200,
        height: 630,
        alt: "ASX Short Selling Statistics",
      },
    ],
  },
  twitter: {
    card: "summary_large_image",
    title: "ASX Short Selling Statistics — Total Dollars Shorted",
    description:
      "Live aggregate ASX short interest from official ASIC data, updated daily.",
    images: [siteConfig.ogImage],
  },
  alternates: {
    canonical: `${siteConfig.url}/statistics`,
    languages: {
      "en-AU": `${siteConfig.url}/statistics`,
      "x-default": `${siteConfig.url}/statistics`,
    },
  },
};

// ISR at 15min: every deploy prerenders the no-data shell (skipForBuild),
// and the shell is served while the page entry is fresh — a short page TTL
// caps that exposure window. The DATA layer stays cheap regardless (1h
// unstable_cache, tagged for on-demand busting when the daily sync lands).
export const revalidate = 900;

const breadcrumbs = [
  { name: "Home", url: siteConfig.url },
  { name: "Short Selling Statistics", url: `${siteConfig.url}/statistics` },
];

// "$28.4 billion" for the citable sentence; "$28.4B" for tiles/tables.
function formatAudLong(value: number): string {
  if (value >= 1e9) return `$${(value / 1e9).toFixed(1)} billion`;
  if (value >= 1e6) return `$${(value / 1e6).toFixed(0)} million`;
  return `$${Math.round(value).toLocaleString("en-AU")}`;
}

function formatAudShort(value: number): string {
  if (value >= 1e9) return `$${(value / 1e9).toFixed(1)}B`;
  if (value >= 1e6) return `$${(value / 1e6).toFixed(0)}M`;
  return `$${Math.round(value).toLocaleString("en-AU")}`;
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

function StatTile({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div className="rounded-lg border border-border/60 bg-card/50 p-4">
      <p className={cn(eyebrow, "font-medium")}>
        {label}
      </p>
      <p className="mt-1 text-2xl font-bold tabular-nums tracking-tight">
        {value}
      </p>
      {sub ? (
        <p className="mt-0.5 text-xs text-muted-foreground">{sub}</p>
      ) : null}
    </div>
  );
}

function DollarTable({
  rows,
  caption,
}: {
  rows: ShortStatistics["topByDollars"];
  caption: string;
}) {
  return (
    <div className="overflow-x-auto rounded-lg border border-border/60">
      <table className="w-full text-sm">
        <caption className="sr-only">{caption}</caption>
        <thead>
          <tr className="border-b bg-muted/40 text-left text-xs uppercase tracking-wider text-muted-foreground">
            <th className="px-3 py-2 font-medium">Code</th>
            <th className="px-3 py-2 font-medium">Company</th>
            <th className="px-3 py-2 text-right font-medium">Short %</th>
            <th className="px-3 py-2 text-right font-medium">$ Shorted</th>
          </tr>
        </thead>
        <tbody className="divide-y">
          {rows.map((s) => (
            <tr key={s.code}>
              <td className="px-3 py-2 font-semibold">
                <Link
                  href={`/shorts/${s.code}`}
                  className="text-primary hover:underline"
                >
                  {s.code}
                </Link>
              </td>
              <td className="px-3 py-2 text-muted-foreground">{s.name}</td>
              <td className="px-3 py-2 text-right tabular-nums">
                {s.shortPct.toFixed(2)}%
              </td>
              <td className="px-3 py-2 text-right font-medium tabular-nums">
                {formatAudShort(s.dollarsShorted)}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function MoverList({
  title,
  movers,
  positive,
}: {
  title: string;
  movers: ShortStatistics["risers"];
  positive: boolean;
}) {
  return (
    <div className="rounded-lg border border-border/60 bg-card/50 p-4">
      <h3 className="text-sm font-semibold">{title}</h3>
      <ul className="mt-2 space-y-1.5">
        {movers.map((m) => (
          <li key={m.code} className="flex items-baseline justify-between gap-3 text-sm">
            <span>
              <Link
                href={`/shorts/${m.code}`}
                className="font-medium text-primary hover:underline"
              >
                {m.code}
              </Link>{" "}
              <span className="text-xs text-muted-foreground">
                {m.shortPct.toFixed(2)}% short
              </span>
            </span>
            <span
              className={`tabular-nums text-xs font-semibold ${
                positive ? "text-red-500" : "text-emerald-500"
              }`}
            >
              {m.change4w > 0 ? "+" : ""}
              {m.change4w.toFixed(2)}pp / 4w
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}

export default async function StatisticsPage() {
  const stats = await getShortStatistics();
  const asOf = stats ? formatAsOf(stats.asOfDate) : "";

  const breadcrumbItems = [
    { label: "Short Selling Statistics", href: "/statistics" },
  ];

  return (
    <DashboardLayout>
      <BreadcrumbListSchema items={breadcrumbs} />
      <DatasetStructuredData
        datasetInfo={{
          name: "ASX Aggregate Short Selling Statistics",
          description:
            "Market-wide short selling statistics for the Australian Securities Exchange: total dollar value of short positions, bank basket, sector totals, and 4-week movers. Derived from official ASIC daily short position reports.",
          dateModified: stats?.asOfDate,
        }}
      />
      <LLMMeta
        title="ASX Short Selling Statistics — Aggregate Short Interest"
        description="Total dollars short-sold on the ASX, big-four bank short basket, sector totals, and short interest movers, computed daily from official ASIC data."
        keywords={[
          "ASX short selling statistics",
          "total short positions ASX",
          "ASX short interest total",
          "bank short positions Australia",
        ]}
        dataSource="ASIC"
        dataFrequency="daily"
      />

      <div className="space-y-10">
        <div className="mb-4">
          <Breadcrumbs items={breadcrumbItems} />
        </div>

        <section className="border-b border-border/40 pb-8">
          <p className={cn(eyebrow, "mb-2 font-medium")}>
            Market statistics
          </p>
          <h1 className={pageTitle}>
            ASX Short Selling Statistics
          </h1>
          {stats ? (
            <>
              {/* The citable sentence — crawlable text, updated daily. */}
              <p className="mt-4 max-w-3xl text-lg leading-relaxed">
                <strong className="text-2xl font-bold tabular-nums">
                  {formatAudLong(stats.totalDollarsShorted)}
                </strong>{" "}
                is currently short-sold across{" "}
                <strong>{stats.stockCount}</strong> ASX-listed companies, as of{" "}
                <time dateTime={stats.asOfDate}>{asOf}</time> — based on
                official ASIC short position reports.
              </p>
              <p className="mt-2 text-sm text-muted-foreground">
                Short positions against the big four banks (ANZ, CBA, NAB,
                WBC) total{" "}
                <strong className="text-foreground">
                  {formatAudLong(stats.bankBasketTotal)}
                </strong>
                .
              </p>
            </>
          ) : (
            <p className="mt-4 max-w-3xl text-muted-foreground">
              Live aggregate short-interest statistics for the Australian
              Securities Exchange — total dollars shorted, bank basket, and
              sector totals — computed daily from official ASIC short
              position reports. Data is temporarily unavailable; it refreshes
              automatically.
            </p>
          )}
        </section>

        {stats && (
          <>
            <section aria-label="Headline statistics">
              <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
                <StatTile
                  label="Total $ shorted"
                  value={formatAudShort(stats.totalDollarsShorted)}
                  sub={`across ${stats.stockCount} stocks`}
                />
                <StatTile
                  label="Bank basket"
                  value={formatAudShort(stats.bankBasketTotal)}
                  sub="ANZ · CBA · NAB · WBC"
                />
                <StatTile
                  label="Avg short interest"
                  value={`${stats.avgShortPct.toFixed(2)}%`}
                  sub="mean across shorted stocks"
                />
                <StatTile
                  label="Heavily shorted"
                  value={String(stats.stocksAbove10Pct)}
                  sub={`≥10% short (${stats.stocksAbove5Pct} ≥5%)`}
                />
              </div>
            </section>

            <section aria-labelledby="top-dollars">
              <h2 id="top-dollars" className={cn(sectionTitle, "mb-3")}>
                Largest short positions by dollar value
              </h2>
              <DollarTable
                rows={stats.topByDollars}
                caption="Top 10 ASX stocks by dollar value of short positions"
              />
              <p className="mt-2 text-xs text-muted-foreground">
                Ranked by estimated dollar value (short % × market
                capitalisation). See the{" "}
                <Link href="/top" className="text-primary hover:underline">
                  full most-shorted rankings
                </Link>{" "}
                for the percentage view.
              </p>
            </section>

            <section aria-labelledby="bank-basket">
              <div className="mb-3 flex items-center gap-2">
                <h2 id="bank-basket" className={sectionTitle}>
                  The bank short basket
                </h2>
                <EmbedDialog target={{ kind: "basket", basket: "banks" }} />
              </div>
              <p className="mb-3 max-w-3xl text-sm text-muted-foreground">
                Dollar value of reported short positions against
                Australia&apos;s big four banks — the market&apos;s
                highest-profile macro short.
              </p>
              <DollarTable
                rows={stats.bankBasket}
                caption="Short positions against ANZ, CBA, NAB and WBC"
              />
            </section>

            <section aria-labelledby="sector-totals">
              <h2 id="sector-totals" className={cn(sectionTitle, "mb-3")}>
                Short interest by sector
              </h2>
              <div className="overflow-x-auto rounded-lg border border-border/60">
                <table className="w-full text-sm">
                  <caption className="sr-only">
                    Dollar value of short positions by industry
                  </caption>
                  <thead>
                    <tr className="border-b bg-muted/40 text-left text-xs uppercase tracking-wider text-muted-foreground">
                      <th className="px-3 py-2 font-medium">Industry</th>
                      <th className="px-3 py-2 text-right font-medium">Stocks</th>
                      <th className="px-3 py-2 text-right font-medium">Avg short %</th>
                      <th className="px-3 py-2 text-right font-medium">$ Shorted</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y">
                    {stats.industries.map((i) => (
                      <tr key={i.industry}>
                        <td className="px-3 py-2 font-medium">{i.industry}</td>
                        <td className="px-3 py-2 text-right tabular-nums text-muted-foreground">
                          {i.stockCount}
                        </td>
                        <td className="px-3 py-2 text-right tabular-nums">
                          {i.avgShortPct.toFixed(2)}%
                        </td>
                        <td className="px-3 py-2 text-right font-medium tabular-nums">
                          {formatAudShort(i.dollarsShorted)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </section>

            <section aria-labelledby="movers">
              <h2 id="movers" className={cn(sectionTitle, "mb-3")}>
                Biggest 4-week moves in short interest
              </h2>
              <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
                <MoverList
                  title="Shorts building"
                  movers={stats.risers}
                  positive
                />
                <MoverList
                  title="Shorts covering"
                  movers={stats.fallers}
                  positive={false}
                />
              </div>
            </section>

            <section
              id="cite"
              aria-labelledby="cite-heading"
              className="rounded-lg border border-border/60 bg-card/50 p-5"
            >
              <h2 id="cite-heading" className="text-lg font-semibold">
                Citing these figures
              </h2>
              <p className="mt-2 max-w-3xl text-sm text-muted-foreground">
                Journalists and researchers are welcome to cite this page.
                Suggested attribution:{" "}
                <em>
                  &ldquo;According to Shorted.com.au, {formatAudLong(stats.totalDollarsShorted)}{" "}
                  was short-sold across the ASX as of {asOf}, including{" "}
                  {formatAudLong(stats.bankBasketTotal)} against the big four
                  banks.&rdquo;
                </em>{" "}
                Please link to{" "}
                <span className="font-mono text-xs">
                  https://shorted.com.au/statistics
                </span>
                . For historical series, bulk downloads and API access see the{" "}
                <Link href="/data" className="text-primary hover:underline">
                  open data hub
                </Link>
                ; for media enquiries email{" "}
                <a
                  href="mailto:ben@shorted.com.au"
                  className="text-primary hover:underline"
                >
                  ben@shorted.com.au
                </a>
                .
              </p>
            </section>
          </>
        )}

        <section
          id="methodology"
          aria-labelledby="methodology-heading"
          className="max-w-3xl scroll-mt-24 space-y-3 border-t border-border/40 pt-8"
        >
          <h2 id="methodology-heading" className="text-lg font-semibold">
            Methodology
          </h2>
          <p className="text-sm leading-relaxed text-muted-foreground">
            Every trading day ASIC publishes aggregate reported short
            positions for ASX-listed securities with a four trading-day lag
            (T+4). The dollar value of a stock&apos;s short position is
            estimated as its reported short percentage multiplied by its
            market capitalisation — both derive from the same issued-share
            count, so the product equals shares sold short × latest price.
            Totals cover equities only (ETFs and debt securities are
            excluded){stats && stats.excludedCount > 0 ? (
              <>
                {" "}and omit {stats.excludedCount} stocks with reported
                shorts but no market-capitalisation data
              </>
            ) : null}
            . Figures refresh daily when new ASIC data lands.
          </p>
          <p className="text-sm leading-relaxed text-muted-foreground">
            Explore the underlying data:{" "}
            <Link href="/top" className="text-primary hover:underline">
              most shorted stocks
            </Link>
            {" · "}
            <Link href="/battlegrounds" className="text-primary hover:underline">
              short squeeze candidates
            </Link>
            {" · "}
            <Link href="/scans" className="text-primary hover:underline">
              short interest scans
            </Link>
            {" · "}
            <Link href="/screener" className="text-primary hover:underline">
              screener
            </Link>
            {" · "}
            <Link href="/reports" className="text-primary hover:underline">
              weekly reports
            </Link>
            {" · "}
            <Link href="/data" className="text-primary hover:underline">
              downloads &amp; API
            </Link>
            .
          </p>
        </section>
      </div>
    </DashboardLayout>
  );
}
