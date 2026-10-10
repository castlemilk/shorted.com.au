import { notFound } from "next/navigation";
import { DashboardLayout } from "~/@/components/layouts/dashboard-layout";
import { StockBreadcrumbs } from "~/@/components/company/stock-breadcrumbs";
import { StockHeader } from "~/@/components/company/stock-header";
import { StockTabNav } from "~/@/components/company/stock-tab-nav";
import { getLatestShortDate } from "~/app/actions/getLatestShortDate";
import { getShortInterestDeltas } from "./short-interest-summary";
import { loadStockOrFail } from "./stock-page-data";
import { STOCK_CODE_PATTERN } from "./stock-page-shared";

// The segment is ISR; the pages beneath export the trio (revalidate,
// dynamicParams, generateStaticParams). Everything fetched here runs inside
// unstable_cache (getStock, the daily series, the header logo's company
// details) — no searchParams, cookies or headers, or the whole segment goes
// dynamic.
export const revalidate = 3600;

interface LayoutProps {
  children: React.ReactNode;
  params: Promise<{ stockCode: string }>;
}

/**
 * The chrome above every tab of /shorts/[stockCode]: the breadcrumbs, the
 * compact header, the sticky tab bar, then the tab itself. Each is a block with
 * a 16px gap beneath it. What a tab shows beyond that is the tab's own, its
 * chart included: the layout renders and loads none.
 *
 * What a tab LOADS is another matter, as measured on this build. Company and
 * News load no chart code. Financials and Community still load the Overview
 * page's chart chunks, because their client reference manifests carry the
 * Overview page's client modules and chunk list (scripts/bundle-budget.mjs
 * has the figures). Before this branch every tab loaded the chart from the
 * layout. Follow-up: moving the Overview page into a route group, e.g.
 * (overview)/page.tsx, would stop that inheritance.
 */
export default async function StockLayout({ children, params }: LayoutProps) {
  const { stockCode: raw } = await params;
  const stockCode = raw.toUpperCase();
  if (!STOCK_CODE_PATTERN.test(stockCode)) notFound();

  // The daily series needs only the code, so its two readers start BEFORE the
  // stock is awaited: a regeneration then waits for the slower of the two
  // round-trips, not for one after the other. They feed the header's "as of"
  // date and its 30-day change. Neither reader rejects (getShortInterestDeltas
  // returns all-nulls, getLatestShortDate is caught here). The handler below is
  // for the path where the stock read throws first and nothing awaits these:
  // attached now, a late rejection from either could never surface as
  // unhandled.
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

  return (
    <DashboardLayout>
      <div className="mb-4">
        <StockBreadcrumbs stockCode={stockCode} />
      </div>

      <StockHeader
        stockCode={stockCode}
        stock={stock}
        change30d={deltas.change30d}
        asOf={latestShortDate}
      />

      <StockTabNav stockCode={stockCode} />

      {children}
    </DashboardLayout>
  );
}
