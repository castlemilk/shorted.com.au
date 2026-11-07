import { type Metadata } from "next";
import { Activity } from "lucide-react";
import { DashboardLayout } from "~/@/components/layouts/dashboard-layout";
import { BreadcrumbListSchema } from "~/@/components/seo/enhanced-structured-data";
import { Breadcrumbs } from "~/@/components/seo/breadcrumbs";
import { MarketMovesList } from "~/@/components/market-moves/market-moves-list";
import { siteConfig } from "~/@/config/site";
import { formatMarketDate } from "~/@/lib/market-moves/format";
import { groupMarketMovesByDate } from "~/@/lib/market-moves/view";
import { pageTitle } from "~/@/lib/typography";
import { bailOnEmptyRender } from "~/app/actions/config";
import { getMarketMovesFeed } from "~/app/actions/market-moves/getMarketMoves";

const description =
  "What moved on the ASX and why: stocks, indices and sectors, each with its move, the time it was observed and its sources. Written by an AI market-moves workflow; not financial advice.";

export const metadata: Metadata = {
  // No brand: the root layout's `%s | Shorted` template appends it.
  title: "ASX Market Moves",
  description,
  openGraph: {
    title: "ASX Market Moves",
    description,
    url: `${siteConfig.url}/market-moves`,
    siteName: siteConfig.name,
    type: "website",
    locale: "en_AU",
  },
  twitter: {
    site: "@shorted___",
    creator: "@shorted___",
    card: "summary_large_image",
    title: "ASX Market Moves",
    description,
  },
  alternates: {
    canonical: `${siteConfig.url}/market-moves`,
  },
};

// ISR, five minutes. The real refresh is on demand: the API revalidates the
// "market-moves" tag and this path after each post or retraction. The page
// reads no request data, so it stays static.
export const revalidate = 300;

const breadcrumbs = [
  { name: "Home", url: siteConfig.url },
  { name: "Market moves", url: `${siteConfig.url}/market-moves` },
];

export default async function MarketMovesPage() {
  const moves = await getMarketMovesFeed();
  // Unread is not empty: a failed read (or the build prerender) says the moves
  // are unavailable, holds the render for a minute, and is marked as a shell
  // for the post-deploy warm sweep. An empty list is a real answer.
  if (moves === undefined) await bailOnEmptyRender();
  const groups = moves ? groupMarketMovesByDate(moves) : [];

  return (
    <DashboardLayout>
      {moves === undefined && <span hidden data-isr-shell="empty" />}
      <BreadcrumbListSchema items={breadcrumbs} />

      <div className="mx-auto w-full max-w-4xl space-y-8">
        <div className="mb-4">
          <Breadcrumbs
            items={[{ label: "Market moves", href: "/market-moves" }]}
          />
        </div>

        <section className="border-b border-border/40 pb-6">
          <div className="mb-3 flex items-center gap-3">
            <div className="rounded-lg bg-primary/10 p-3">
              <Activity className="h-8 w-8 text-primary" aria-hidden="true" />
            </div>
            <div>
              <h1 className={pageTitle}>Market moves</h1>
              <p className="mt-1 text-muted-foreground">
                What moved on the ASX and why, newest first
              </p>
            </div>
          </div>
          <p className="max-w-[70ch] text-sm text-muted-foreground">
            Each move is written by an AI market-moves workflow from what it
            observed at the time shown on the move, with the sources it cites. A
            move may be revised as the day goes on, and is marked when it has
            been. It is not financial advice.
          </p>
        </section>

        {moves === undefined ? (
          <p
            role="status"
            className="rounded-lg border bg-card px-4 py-6 text-sm text-muted-foreground"
          >
            Market moves are unavailable right now. Try again in a minute.
          </p>
        ) : groups.length === 0 ? (
          <p className="rounded-lg border bg-card px-4 py-6 text-sm text-muted-foreground">
            No market moves posted yet.
          </p>
        ) : (
          groups.map((group) => (
            <section
              key={group.marketDate}
              aria-labelledby={`moves-${group.marketDate}`}
              className="space-y-3"
            >
              <h2
                id={`moves-${group.marketDate}`}
                className="text-sm font-medium text-muted-foreground"
              >
                <time dateTime={group.marketDate}>
                  {formatMarketDate(group.marketDate)}
                </time>
              </h2>
              <MarketMovesList moves={group.moves} headingLevel={3} />
            </section>
          ))
        )}
      </div>
    </DashboardLayout>
  );
}
