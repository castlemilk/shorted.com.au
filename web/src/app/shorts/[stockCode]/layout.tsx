import nextDynamic from "next/dynamic";
import { notFound } from "next/navigation";
import { Suspense } from "react";
import CompanyProfile, {
  CompanyProfilePlaceholder,
} from "~/@/components/ui/companyProfile";
import CompanyStats, {
  CompanyStatsPlaceholder,
} from "~/@/components/ui/companyStats";
import { DashboardLayout } from "~/@/components/layouts/dashboard-layout";
import { LoginPromptBanner } from "~/@/components/ui/login-prompt-banner";
import { SignedOutOnly } from "~/@/components/ui/session-gates";
import { StockThemeChips } from "~/@/components/themes/theme-chips";
import { StockBreadcrumbs } from "~/@/components/company/stock-breadcrumbs";
import { StockTabNav } from "~/@/components/company/stock-tab-nav";
import { getLatestShortDate } from "~/app/actions/getLatestShortDate";
import {
  ShortInterestSummary,
  getShortInterestDeltas,
} from "./short-interest-summary";
import { loadStockOrFail } from "./stock-page-data";
import {
  STOCK_CODE_PATTERN,
  asOfClauseFor,
  cleanCompanyName,
} from "./stock-page-shared";

// Consolidated per-stock chart (price + short interest, dual-axis, volume,
// brush). Client-only: uses Connect-RPC + market-data hooks. It lives in the
// LAYOUT so switching tabs never remounts or refetches it.
const StockChartPanel = nextDynamic(
  () =>
    import("~/@/components/charts/StockChartPanel").then(
      (m) => m.StockChartPanel,
    ),
  {
    ssr: false,
    loading: () => (
      <div className="h-[420px] animate-pulse rounded-lg bg-muted/40" />
    ),
  },
);

// The segment is ISR; the pages beneath export the trio (revalidate,
// dynamicParams, generateStaticParams). Everything fetched here runs inside
// unstable_cache (getStock, the daily series) — no searchParams, cookies or
// headers, or the whole segment goes dynamic.
export const revalidate = 3600;

interface LayoutProps {
  children: React.ReactNode;
  params: Promise<{ stockCode: string }>;
}

export default async function StockLayout({ children, params }: LayoutProps) {
  const { stockCode: raw } = await params;
  const stockCode = raw.toUpperCase();
  if (!STOCK_CODE_PATTERN.test(stockCode)) notFound();

  // The daily series needs only the code, so its two readers start BEFORE the
  // stock is awaited: a regeneration then waits for the slower of the two
  // round-trips, not for one after the other. Neither reader rejects
  // (getShortInterestDeltas returns all-nulls, getLatestShortDate is caught
  // here). The handler below is for the path where the stock read throws first
  // and nothing awaits these: attached now, a late rejection from either could
  // never surface as unhandled.
  const seriesReads = Promise.all([
    getLatestShortDate(stockCode).catch((): Date | null => null),
    getShortInterestDeltas(stockCode),
  ]);
  seriesReads.catch(() => undefined);

  // 404s an unknown code and FAILS the render on a transient read, so a
  // degraded shell is never baked into the ISR cache (see stock-page-data.ts).
  // The series reads are abandoned, not awaited, on either path.
  const stock = await loadStockOrFail(stockCode);

  const [latestShortDate, deltas] = await seriesReads;
  const companyName = cleanCompanyName(stock.name || stockCode, stockCode);

  return (
    <DashboardLayout>
      <div className="mb-4">
        <StockBreadcrumbs stockCode={stockCode} />
      </div>

      {/* Signed-out breadcrumb to login — client-gated; the slot is always in
          the server HTML and critical CSS reserves its height under html.anon
          (see layout.tsx at the root) so it never shifts the page. */}
      <div className="login-slot">
        <SignedOutOnly>
          <div className="overflow-hidden rounded-lg border border-primary/20">
            <LoginPromptBanner />
          </div>
        </SignedOutOnly>
      </div>

      <div className="mb-6 grid grid-cols-1 items-start gap-4 md:grid-cols-3 md:gap-6">
        <div className="md:col-span-2">
          <Suspense fallback={<CompanyProfilePlaceholder />}>
            <CompanyProfile stockCode={stockCode} />
          </Suspense>
        </div>
        <div className="h-full md:col-span-1">
          <Suspense fallback={<CompanyStatsPlaceholder />}>
            <CompanyStats stockCode={stockCode} initialStock={stock} />
          </Suspense>
        </div>
      </div>

      <ShortInterestSummary
        stockCode={stockCode}
        companyName={companyName}
        industry={stock.industry || ""}
        shortPct={stock.percentageShorted ?? 0}
        shortPositions={stock.reportedShortPositions ?? 0}
        asOfClause={asOfClauseFor(latestShortDate)}
        deltas={deltas}
      />

      <StockThemeChips stockCode={stockCode} className="-mt-2 mb-6" />

      <section aria-labelledby="stock-chart-heading" className="mb-6 min-w-0">
        <div className="mb-2 flex flex-wrap items-baseline justify-between gap-x-6 gap-y-1">
          <h2 id="stock-chart-heading" className="text-lg font-semibold tracking-tight">
            Price &amp; short interest
          </h2>
          <span className="text-xs text-muted-foreground">
            Toggle series, zoom, and compare · ASIC daily, T+4
          </span>
        </div>
        <StockChartPanel stockCode={stockCode} />
      </section>

      <StockTabNav stockCode={stockCode} />

      {children}
    </DashboardLayout>
  );
}
