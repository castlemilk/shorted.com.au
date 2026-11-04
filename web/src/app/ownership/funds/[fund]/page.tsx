import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { cache } from "react";
import { DashboardLayout } from "~/@/components/layouts/dashboard-layout";
import { Breadcrumbs } from "~/@/components/seo/breadcrumbs";
import { FundChangesTable } from "~/@/components/ownership/funds/fund-changes-table";
import { FundPortfolioMap } from "~/@/components/ownership/funds/fund-portfolio-map";
import { UrlTabs } from "~/@/components/ownership/funds/url-tabs";
import { SectorConcentration as SectorBars } from "~/@/components/ownership/funds/sector-concentration";
import {
  defaultPair,
  fundKeyFromSegment,
  FUND_TAB_LABELS,
  fundKindLabel,
  type FundPortfolio,
  fundLabel,
} from "~/@/components/ownership/funds/fund-model";
import { formatPct } from "~/@/lib/fundamentals/format";
import { FundRail } from "~/@/components/ownership/funds/fund-rail";
import { HolderLogo } from "~/@/components/ownership/workspace/holder-logo";
import { WorkspacePage } from "~/@/components/ownership/workspace/workspace-page";
import { fundHref, isInstitutionSlug } from "~/@/lib/ownership/kinds";
import { safeExternalHref } from "~/@/lib/safe-external-href";
import { eyebrow, lede, pageTitle } from "@/lib/typography";
import { bailOnEmptyRender } from "~/app/actions/config";
import {
  compareFundSnapshots,
  loadFundPortfolio,
  resolveChangeSelection,
  resolveFundSelection,
} from "~/app/actions/ownershipFunds";

// On-demand ISR: a fund page is rendered on first visit and cached for an hour. The
// empty generateStaticParams keeps the segment static (the institution page's rule).
// The page reads no search parameter: the tab is an island's, read from the URL.
export const revalidate = 3600;
export const dynamicParams = true;
export function generateStaticParams(): Array<{ fund: string }> {
  return [];
}

interface PageProps {
  params: Promise<{ fund: string }>;
}

/**
 * The fund's portfolio, read once per render. A fund the record does not hold is
 * `missing` (the page's 404); an outage is an empty page, never a 404, so a transient
 * failure is not cached as a missing fund. React's cache shares the read between
 * generateMetadata and the page.
 */
const readFund = cache((fundKey: string) => loadFundPortfolio({ fundKey }));

export async function generateMetadata({ params }: PageProps): Promise<Metadata> {
  const key = fundKeyFromSegment((await params).fund);
  if (key === "") return { title: "Fund not found", robots: { index: false, follow: true } };
  const page = await readFund(key);
  const fund = page.fund;
  // Only a fund the record does not hold is not found. An outage is a neutral page that
  // is not indexed, so the title never claims a fund is missing when it is only unread.
  if (!fund) {
    return page.missing
      ? { title: "Fund not found", robots: { index: false, follow: true } }
      : { title: "Fund portfolio", robots: { index: false, follow: true } };
  }
  const url = `https://shorted.com.au${fundHref(fund.key)}`;
  const title = `${fundLabel(fund)} fund portfolio`;
  const description = `${fund.name}: the ASX holdings in its latest file, ${fund.holdingsTotal} reported equities, from ${fund.institutionName}.`;
  return {
    title,
    description,
    alternates: { canonical: url },
    openGraph: { type: "website", url, title, description, siteName: "Shorted", locale: "en_AU" },
    twitter: { card: "summary_large_image", site: "@shorted___", creator: "@shorted___" },
  };
}

/** The fund's file dates, its source and its registry row, as the Sources tab reads them. */
function FundSources({ fund }: { fund: FundPortfolio }) {
  const dates = [...fund.snapshotDates].reverse();
  // The file's URL is stored data: it is a link only as an http(s) URL, else its label is text.
  const source = safeExternalHref(fund.sourceUrl);
  return (
    <div className="grid gap-6 md:grid-cols-2">
      <dl className="divide-y divide-border border-y border-border text-sm">
        <div className="flex justify-between gap-4 py-2">
          <dt className="text-muted-foreground">Manager</dt>
          <dd>
            {isInstitutionSlug(fund.institutionSlug) ? (
              <Link href={`/ownership/${fund.institutionSlug}`} prefetch={false} className="underline underline-offset-4">
                {fund.institutionName}
              </Link>
            ) : (
              fund.institutionName
            )}
          </dd>
        </div>
        <div className="flex justify-between gap-4 py-2">
          <dt className="text-muted-foreground">Type</dt>
          <dd>{fundKindLabel(fund)}</dd>
        </div>
        <div className="flex justify-between gap-4 py-2">
          <dt className="text-muted-foreground">Fund code</dt>
          <dd className="font-mono">{fund.ticker.trim() !== "" ? fund.ticker.trim() : "n/a"}</dd>
        </div>
      </dl>
      <div className="space-y-3 text-sm">
        <p className={eyebrow}>File dates</p>
        {dates.length === 0 ? (
          <p className="text-muted-foreground">No file date is on record.</p>
        ) : (
          <ul className="space-y-1 font-mono tabular-nums">
            {dates.map((date) => (
              <li key={date}>
                <Link href={`?tab=portfolio&as=${date}`} scroll={false} prefetch={false} className="underline underline-offset-4">
                  {date}
                </Link>
              </li>
            ))}
          </ul>
        )}
        {source ? (
          <a href={source} target="_blank" rel="noopener noreferrer" className="inline-block underline underline-offset-4">
            View holdings source ↗
          </a>
        ) : fund.sourceUrl !== "" ? (
          <p>View holdings source</p>
        ) : null}
      </div>
    </div>
  );
}

export default async function FundPage({ params }: PageProps) {
  const key = fundKeyFromSegment((await params).fund);
  // Only an empty or malformed segment is the site's 404; a key the record does not hold is the workspace's own card (spec 14.9).
  if (key === "") notFound();
  const page = await readFund(key);
  if (page.missing) {
    return (
      <DashboardLayout fullWidth>
        <WorkspacePage>
          <section aria-labelledby="fund-not-found" className="space-y-3 rounded-md border border-dashed p-6">
            <h1 id="fund-not-found" className="font-mono text-sm">
              {`No tracked fund named ${key}.`}
            </h1>
            <Link href="/ownership/funds" prefetch={false} className="text-sm text-primary underline-offset-4 hover:underline">
              Browse the funds →
            </Link>
          </section>
        </WorkspacePage>
      </DashboardLayout>
    );
  }
  const fund = page.fund;
  if (!fund) {
    // An outage: the page says so, and the cache is shortened so the fund shows once it is read.
    await bailOnEmptyRender();
    return (
      <DashboardLayout fullWidth>
        <WorkspacePage>
          <p className="text-muted-foreground">
            This fund could not be read just now. Nothing here is missing from the record: this is our end.
          </p>
        </WorkspacePage>
      </DashboardLayout>
    );
  }

  const pair = defaultPair(fund.snapshotDates);
  const comparison =
    pair.from !== "" && pair.to !== ""
      ? await compareFundSnapshots({ fundKey: fund.key, from: pair.from, to: pair.to })
      : { ok: false, error: "", from: "", to: "", sourceFrom: "", sourceTo: "", rows: [] };
  // A failed comparison is the Changes pane's own outage line; the page caches as usual (spec 14.7).
  const self = fundHref(fund.key);
  const crumbs = [
    { label: "Ownership", href: "/ownership" },
    { label: "Funds", href: "/ownership/funds" },
    { label: fundLabel(fund), href: self },
  ];
  const fundOption = { key: fund.key, ticker: fund.ticker, name: fund.name };

  return (
    <DashboardLayout fullWidth>
      <WorkspacePage
        inspector={
          <>
            <div className="mb-8">
              <SectorBars sectors={fund.sectorWeights} />
            </div>
            <FundRail
              resolve={resolveFundSelection}
              changes={resolveChangeSelection}
              defaults={{ from: pair.from, to: pair.to }}
              emptyText="Select a holding to inspect its weight."
            />
          </>
        }
      >
        <div className="space-y-6">
          <Breadcrumbs items={crumbs} />
          <header className="space-y-3">
            <div className="flex flex-wrap items-center gap-3">
              {fundLabel(fund) !== fund.name ? (
                <span className="rounded-[var(--radius)] border border-border px-2 py-1 font-mono text-sm font-semibold">
                  {fundLabel(fund)}
                </span>
              ) : null}
            </div>
            <h1 className={pageTitle}>{fund.name}</h1>
            <p className={lede}>
              Managed by{" "}
              <HolderLogo name={fund.institutionName} kind="" holderKey={fund.institutionSlug} size={20} className="mr-1 inline-block align-[-3px]" />
              {isInstitutionSlug(fund.institutionSlug) ? (
                <Link href={`/ownership/${fund.institutionSlug}`} prefetch={false} className="underline underline-offset-4">
                  {fund.institutionName}
                  <span aria-hidden="true"> ↗</span>
                </Link>
              ) : (
                fund.institutionName
              )}{" "}
              · {fundKindLabel(fund)} · AUD
            </p>
          </header>

          <div className="flex flex-wrap items-baseline gap-x-6 gap-y-2 border-y border-border py-3 font-mono text-sm tabular-nums">
            <p>
              <span className="font-semibold">{fund.holdingsTotal}</span> reported equities
            </p>
            <p>
              <span className="font-semibold">{formatPct(fund.top10Pct, { digits: 1 })}</span> in top 10
            </p>
            <p className="text-muted-foreground">Holdings: {fund.asAt || "n/a"}</p>
            <p className="ml-auto text-xs text-muted-foreground">
              Source-reported weights · Equity holdings shown · Cash excluded
            </p>
          </div>

          <UrlTabs
            label="Fund sections"
            defaultTab="portfolio"
            tabs={[
              {
                id: "portfolio",
                label: FUND_TAB_LABELS.portfolio,
                panel: <FundPortfolioMap portfolio={fund} loadPortfolio={loadFundPortfolio} />,
              },
              {
                id: "changes",
                label: FUND_TAB_LABELS.changes,
                panel: (
                  <FundChangesTable
                    funds={[fundOption]}
                    defaults={{ fund: fund.key, from: pair.from, to: pair.to }}
                    defaultDates={fund.snapshotDates}
                    initial={comparison}
                    loadPortfolio={loadFundPortfolio}
                    compare={compareFundSnapshots}
                  />
                ),
              },
              {
                id: "sources",
                label: FUND_TAB_LABELS.sources,
                panel: <FundSources fund={fund} />,
              },
            ]}
          />
        </div>
      </WorkspacePage>
    </DashboardLayout>
  );
}
