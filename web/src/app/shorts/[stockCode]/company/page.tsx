import nextDynamic from "next/dynamic";
import { type Metadata } from "next";
import { notFound } from "next/navigation";
import { BreadcrumbStructuredData } from "~/@/components/seo/breadcrumbs";
import { DirectorTradesSkeleton } from "~/@/components/company/director-trades-skeleton";
import {
  DIRECTOR_TRADES_LIMIT,
  DirectorTradesView,
} from "~/@/components/company/director-trades-view";
import { EnrichedCompanySection } from "~/@/components/company/enriched-company-section";
import { PoliticianInterestsCard } from "~/@/components/company/politician-interests-card-loader";
import { StockOwnershipView } from "~/@/components/ownership/stock-ownership-view";
import { StockEvidencePanelClient } from "~/@/components/company/stock-evidence-panel-client";
import { StockStateExposure } from "~/@/components/economy/stock-state-exposure";
import { cleanCompanyName } from "~/@/lib/company-name";
import { stockTabMetadata } from "~/@/lib/seo/stock-tab-metadata";
import { stockTabTitle } from "~/@/lib/seo/stock-tab-title";
import { stockTabHref, stockTabLabel } from "~/@/lib/stocks/stock-tabs";
import { getDirectorTrades } from "~/app/actions/getDirectorTrades";
import { getStockOwnership } from "~/app/actions/getOwnership";
import { getRelatedStocks } from "~/app/actions/getRelatedStocks";
import { getStateExposureIndex } from "~/app/actions/getEconomy";
import { loadStockOrFail } from "../stock-page-data";
import { STOCK_CODE_PATTERN } from "../stock-page-shared";

// Client islands that import @connectrpc/connect: client-only, as the chart
// panels on the Overview and Short interest tabs are. The directors table is
// the FALLBACK: the page reads the trades itself and draws them on the server
// (DirectorTradesView), and hands the section to this island only when that
// read comes back empty-handed. It holds its place with the card it draws
// while it loads (DirectorTradesSkeleton, a module with no Connect in it), so
// it does not pop in after the page and shift what is below it.
const DirectorTradesTable = nextDynamic(
  () => import("~/@/components/company/director-trades-table").then((m) => m.DirectorTradesTable),
  { ssr: false, loading: () => <DirectorTradesSkeleton /> },
);
const StockConnections = nextDynamic(
  () => import("~/@/components/company/stock-connections").then((m) => m.StockConnections),
  { ssr: false },
);

// On-demand ISR: the empty generateStaticParams is what makes the segment
// statically optimisable; without it revalidate is inert (see the overview).
export const revalidate = 3600;
export const dynamicParams = true;
export function generateStaticParams(): Array<{ stockCode: string }> {
  return [];
}

interface PageProps {
  params: Promise<{ stockCode: string }>;
}

export async function generateMetadata({ params }: PageProps): Promise<Metadata> {
  const code = (await params).stockCode.toUpperCase();
  return stockTabMetadata({
    code,
    tab: "company",
    title: (company) => stockTabTitle(code, "Company Profile: Directors & Insiders", company),
    description: (company) =>
      `${company} (ASX:${code}) in depth: what the company does, its history and risks, director trades, declared political interests and where it operates.`,
    keywords: [`${code} company profile`, `${code} director trades`, `${code} insider trading`, `${code} key people`],
  });
}

export default async function CompanyPage({ params }: PageProps) {
  const code = (await params).stockCode.toUpperCase();
  if (!STOCK_CODE_PATTERN.test(code)) notFound();
  // Cross-domain context must never take the page down: degrades to {}.
  const stateExposureIndexPromise = getStateExposureIndex().catch(
    (): Awaited<ReturnType<typeof getStateExposureIndex>> => ({}),
  );
  // The directors read starts with the page's others and is awaited below,
  // where the section renders, so the card is in the HTML at its final size (a
  // skeleton that collapsed to "No director trades found" shifted every card
  // beneath it). It resolves to undefined on any failure, and a rejection is
  // taken the same way: the section then falls back to the client island,
  // which reads for itself, rather than taking the page down.
  const directorTradesPromise = getDirectorTrades(
    code,
    DIRECTOR_TRADES_LIMIT,
  ).catch((): Awaited<ReturnType<typeof getDirectorTrades>> => undefined);
  // Who owns it: drawn on the server like the directors card, and left out
  // when the read fails or holds nothing, so it never holds a place it gives
  // back.
  const ownershipPromise = getStockOwnership(code).catch(
    (): Awaited<ReturnType<typeof getStockOwnership>> => undefined,
  );
  // 404s an unknown code and FAILS the render on a transient read, so a
  // degraded page is never baked into the ISR cache (see stock-page-data.ts).
  // getRelatedStocks degrades to an empty result on its own and never rejects.
  const [stock, relatedData] = await Promise.all([
    loadStockOrFail(code),
    getRelatedStocks(code),
  ]);
  const exposures = (await stateExposureIndexPromise)[code] ?? [];
  const directorTrades = await directorTradesPromise;
  const ownership = await ownershipPromise;
  const hasOwnership =
    ownership != null && (ownership.holders.length > 0 || ownership.fundHoldings.length > 0);
  const companyName = cleanCompanyName(stock.name || code, code);

  return (
    <>
      <BreadcrumbStructuredData
        items={[
          { label: "Stocks", href: "/stocks" },
          { label: code, href: stockTabHref(code, "overview") },
          { label: stockTabLabel("company"), href: stockTabHref(code, "company") },
        ]}
      />
      <h1 className="sr-only">{companyName} ({code}) company profile</h1>
      {/* The islands below print their own titles through CardTitle, an h3, and
          the first follows the h1 directly: this h2 keeps the outline from
          jumping a level. sr-only, and it names the group rather than an
          island, so no title is said twice. */}
      <h2 className="sr-only">Profile, insiders and operations</h2>
      <div className="flex min-w-0 flex-col gap-4 md:gap-6">
        {/* Every card here prints its own title (Company, Director trades,
            Declared political interests, Similar companies): the directors
            card is drawn by this page, the others are islands. So the
            directors section is named with an aria-label, not a second
            visible heading. */}
        <EnrichedCompanySection stockCode={code} companyName={companyName} />
        <section aria-label="Directors and insiders">
          {directorTrades ? (
            <DirectorTradesView
              trades={directorTrades.trades}
              totalCount={directorTrades.totalCount}
            />
          ) : (
            <DirectorTradesTable stockCode={code} />
          )}
        </section>
        {hasOwnership ? (
          <section aria-label="Ownership">
            <StockOwnershipView data={ownership} />
          </section>
        ) : null}
        <PoliticianInterestsCard stockCode={code} />
        {/* Its default -mt-3 mb-6 tucks it under the theme chips; in this
            column the gap sets the spacing. */}
        <StockStateExposure exposures={exposures} className="m-0" />
        <StockConnections stockCode={code} />
        {/* Gated: fetched client-side after the session resolves, never in
            the shared ISR payload. Signed-out visitors see the lock. */}
        <StockEvidencePanelClient
          stockCode={code}
          industry={relatedData.industry}
          industrySlug={relatedData.industrySlug}
          callbackUrl={stockTabHref(code, "company")}
        />
      </div>
    </>
  );
}
