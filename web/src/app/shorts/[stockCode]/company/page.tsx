import nextDynamic from "next/dynamic";
import { type Metadata } from "next";
import { notFound } from "next/navigation";
import { BreadcrumbStructuredData } from "~/@/components/seo/breadcrumbs";
import { EnrichedCompanySection } from "~/@/components/company/enriched-company-section";
import { PoliticianInterestsCard } from "~/@/components/company/politician-interests-card-loader";
import { StockEvidencePanelClient } from "~/@/components/company/stock-evidence-panel-client";
import { StockStateExposure } from "~/@/components/economy/stock-state-exposure";
import { stockTabMetadata } from "~/@/lib/seo/stock-tab-metadata";
import { stockTabHref, stockTabLabel } from "~/@/lib/stocks/stock-tabs";
import { getRelatedStocks } from "~/app/actions/getRelatedStocks";
import { getStateExposureIndex } from "~/app/actions/getEconomy";
import { loadStockOrFail } from "../stock-page-data";
import { STOCK_CODE_PATTERN, cleanCompanyName } from "../stock-page-shared";

// Client islands that import @connectrpc/connect: client-only, as the
// chart is in the layout.
const DirectorTradesTable = nextDynamic(
  () => import("~/@/components/company/director-trades-table").then((m) => m.DirectorTradesTable),
  { ssr: false },
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
    title: (company) => `${code} Company Profile: Directors, Insiders & Operations | ${company}`,
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
  // 404s an unknown code and FAILS the render on a transient read, so a
  // degraded page is never baked into the ISR cache (see stock-page-data.ts).
  // getRelatedStocks degrades to an empty result on its own and never rejects.
  const [stock, relatedData] = await Promise.all([
    loadStockOrFail(code),
    getRelatedStocks(code),
  ]);
  const exposures = (await stateExposureIndexPromise)[code] ?? [];
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
        {/* Every island here prints its own title (Company, Director trades,
            Declared political interests, Similar companies), so the directors
            section is named with an aria-label, not a second visible
            heading. */}
        <EnrichedCompanySection stockCode={code} />
        <section aria-label="Directors and insiders">
          <DirectorTradesTable stockCode={code} />
        </section>
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
