import { StockChartPanelSkeleton } from "~/@/components/charts/stock-chart-section";

/**
 * Overview skeleton: the layout above it is already on screen. It follows the
 * page block for block, so what loads in lands where its placeholder was: the
 * chart section (the heading's row, then the panel's own skeleton, the one the
 * chart's dynamic import shows too), the About card, the sign-in slot, then the
 * grid.
 *
 * The About placeholder is close to the card's measured height (BHP, signed
 * out: 522px at 390px wide, 363px at 1280px), 500px below `sm` and 360px from
 * it, so the grid below starts about where it will stay. The slot after it is
 * the page's own `.login-slot` div, empty: critical CSS reserves it under
 * `html.anon` (46px and a 1rem margin) exactly as it does for the page, and
 * reserves nothing without `.anon`, so a signed-in visitor sees no gap.
 */
export default function StockOverviewLoading() {
  return (
    <div
      role="status"
      aria-busy="true"
      aria-label="Loading"
      className="min-w-0"
    >
      <div className="mb-4 min-w-0">
        {/* StockChartHeading's row: a 28px line, and 8px beneath it. */}
        <div className="mb-2 h-7 w-56 animate-pulse rounded-md bg-muted/40" />
        <StockChartPanelSkeleton />
      </div>
      <div className="mb-4 h-[500px] animate-pulse rounded-lg bg-muted/40 sm:h-[360px]" />
      <div className="login-slot" />
      <div className="grid min-w-0 grid-cols-1 items-start gap-4 md:gap-6 lg:grid-cols-[minmax(0,1fr)_310px]">
        <div className="flex flex-col gap-4 md:gap-6">
          <div className="h-24 animate-pulse rounded-lg bg-muted/40" />
          <div className="h-40 animate-pulse rounded-lg bg-muted/40" />
          <div className="h-56 animate-pulse rounded-lg bg-muted/40" />
        </div>
        <div className="flex flex-col gap-4 md:gap-6">
          <div className="h-48 animate-pulse rounded-lg bg-muted/40" />
          <div className="h-32 animate-pulse rounded-lg bg-muted/40" />
        </div>
      </div>
    </div>
  );
}
