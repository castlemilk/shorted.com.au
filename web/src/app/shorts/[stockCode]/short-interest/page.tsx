import nextDynamic from "next/dynamic";
import { type Metadata } from "next";
import { notFound } from "next/navigation";
import { Suspense } from "react";
import { BreadcrumbStructuredData } from "~/@/components/seo/breadcrumbs";
import { stockTabMetadata } from "~/@/lib/seo/stock-tab-metadata";
import { stockTabHref, stockTabLabel } from "~/@/lib/stocks/stock-tabs";
import { ShortInterestHistory } from "../short-interest-history";
import { loadStockOrFail } from "../stock-page-data";
import { STOCK_CODE_PATTERN, cleanCompanyName } from "../stock-page-shared";

// Client islands that import @connectrpc/connect: client-only, as the
// chart is in the layout.
const PeerComparisonTable = nextDynamic(
  () => import("~/@/components/company/peer-comparison-table").then((m) => m.PeerComparisonTable),
  { ssr: false },
);
const StockSignals = nextDynamic(
  () => import("~/@/components/company/stock-signals").then((m) => m.StockSignals),
  { ssr: false },
);
const StockVerdict = nextDynamic(
  () => import("~/@/components/company/stock-verdict").then((m) => m.StockVerdict),
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
    tab: "short-interest",
    title: (company) => `${code} Short Interest History & FAQ | ${company}`,
    description: (company) =>
      `${company} (ASX:${code}) short interest over time: trend, peak, peer comparison and the questions investors ask. Official ASIC data, T+4.`,
    keywords: [`${code} short interest history`, `${code} short position trend`, `${code} most shorted`, "ASIC short positions"],
    // The tab is one sentence for a stock ASIC reports no short position in,
    // and isStockIndexable would still index a named, enriched one. A predicate,
    // not a flag: the builder calls it only for a stock it could read, so a
    // getStock outage fails open instead of noindexing every stock.
    noindexWhen: (stock) => !(stock.percentageShorted > 0),
  });
}

export default async function ShortInterestPage({ params }: PageProps) {
  const code = (await params).stockCode.toUpperCase();
  if (!STOCK_CODE_PATTERN.test(code)) notFound();
  // 404s an unknown code and FAILS the render on a transient read, so a
  // degraded page is never baked into the ISR cache (see stock-page-data.ts).
  const stock = await loadStockOrFail(code);
  const companyName = cleanCompanyName(stock.name || code, code);
  // ShortInterestHistory renders nothing for a stock ASIC reports no short
  // position in, which would leave an empty card here: say so in a sentence
  // instead (the Overview block this tab replaces was gated the same way).
  const hasShortInterest = stock.percentageShorted > 0;

  return (
    <>
      <BreadcrumbStructuredData
        items={[
          { label: "Stocks", href: "/stocks" },
          { label: code, href: stockTabHref(code, "overview") },
          { label: stockTabLabel("short-interest"), href: stockTabHref(code, "short-interest") },
        ]}
      />
      <h1 className="sr-only">{companyName} ({code}) short interest history</h1>
      <div className="flex min-w-0 flex-col gap-4 md:gap-6">
        {/* The history and the peer table render their own titles, so their
            sections are named with an aria-label, not a second visible heading. */}
        {hasShortInterest ? (
          <section aria-label="Short interest history and FAQ" className="rounded-lg border bg-card px-4 py-3">
            <Suspense fallback={null}>
              <ShortInterestHistory stockCode={code} companyName={companyName} />
            </Suspense>
          </section>
        ) : (
          <p className="text-sm text-muted-foreground">
            ASIC reports no short position in {code} in the latest data.
          </p>
        )}
        <StockVerdict stockCode={code} />
        <StockSignals stockCode={code} />
        <section aria-label="Peer comparison">
          <PeerComparisonTable stockCode={code} />
        </section>
      </div>
    </>
  );
}
