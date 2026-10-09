import nextDynamic from "next/dynamic";
import { type Metadata } from "next";
import { notFound } from "next/navigation";
import { BreadcrumbStructuredData } from "~/@/components/seo/breadcrumbs";
import {
  FilingsListedNote,
  FinancialReportsSection,
} from "~/@/components/company/financial-reports-section";
import { FinancialsTab } from "~/@/components/stocks/financials-tab";
import { latestResultSourceDocument } from "~/@/components/stocks/fundamentals-model";
import { stockTabMetadata } from "~/@/lib/seo/stock-tab-metadata";
import { stockTabHref, stockTabLabel } from "~/@/lib/stocks/stock-tabs";
import { getStockFundamentals } from "~/app/actions/getStockFundamentals";
import { loadStockOrFail } from "../stock-page-data";
import { STOCK_CODE_PATTERN, cleanCompanyName } from "../stock-page-shared";

// Client islands: both fetch through Connect-RPC client modules, so neither is
// rendered on the server. A static import of the tax card made this route
// answer 500 for every stock in a production build ("Element type is invalid
// ... got: undefined", the SSR failure CLAUDE.md describes for @connectrpc).
const DividendHistory = nextDynamic(
  () => import("~/@/components/company/dividend-history").then((m) => m.DividendHistory),
  { ssr: false },
);
const CompanyTaxCard = nextDynamic(
  () => import("~/@/components/company/company-tax-card").then((m) => m.CompanyTaxCard),
  { ssr: false },
);

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
    tab: "financials",
    title: (company) => `${code} Financials: Results, Ratios & Statements | ${company}`,
    description: (company) =>
      `${company} (ASX:${code}) latest result, key ratios, income statement, balance sheet, cash flow, dividends and ATO tax transparency data.`,
    keywords: [`${code} financials`, `${code} results`, `${code} revenue`, `${code} dividend history`, `${code} annual report`],
  });
}

export default async function FinancialsPage({ params }: PageProps) {
  const code = (await params).stockCode.toUpperCase();
  if (!STOCK_CODE_PATTERN.test(code)) notFound();
  // Fundamentals: cached 24h, tag-busted by the picks job; null (the tab then
  // renders its filings and tax card only) on an older API or a failure.
  const fundamentalsPromise = getStockFundamentals(code).catch(
    (): Awaited<ReturnType<typeof getStockFundamentals>> => null,
  );
  // 404s an unknown code and FAILS the render on a transient read, so a
  // degraded page is never baked into the ISR cache (see stock-page-data.ts).
  const stock = await loadStockOrFail(code);
  const fundamentals = await fundamentalsPromise;
  const sourceDocument = latestResultSourceDocument(fundamentals);
  const companyName = cleanCompanyName(stock.name || code, code);

  return (
    <>
      <BreadcrumbStructuredData
        items={[
          { label: "Stocks", href: "/stocks" },
          { label: code, href: stockTabHref(code, "overview") },
          { label: stockTabLabel("financials"), href: stockTabHref(code, "financials") },
        ]}
      />
      <h1 className="sr-only">{companyName} ({code}) financials</h1>
      {/* Latest result, Key ratios, the statements island, the filings, then
          dividends and the tax card LAST (docs/plans/fundamentals-coverage.md §7.1). */}
      <FinancialsTab
        stockCode={code}
        fundamentals={fundamentals}
        filingsNote={<FilingsListedNote stockCode={code} />}
        reports={
          <FinancialReportsSection
            stockCode={code}
            sourceDocumentUrl={sourceDocument?.url ?? ""}
          />
        }
        taxCard={
          <>
            {/* DividendHistory renders its own "Dividends" title, so the section
                is named with an aria-label, not a second visible heading. */}
            <section aria-label="Dividends">
              <DividendHistory stockCode={code} />
            </section>
            <CompanyTaxCard stockCode={code} />
          </>
        }
      />
    </>
  );
}
