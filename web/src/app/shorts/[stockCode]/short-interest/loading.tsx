import { StockChartPanelSkeleton } from "~/@/components/charts/stock-chart-section";

/**
 * Short interest skeleton: the chart section first (the heading's row, then the
 * panel's own skeleton), then the blocks beneath it.
 */
export default function ShortInterestLoading() {
  return (
    <div
      role="status"
      aria-busy="true"
      aria-label="Loading"
      className="flex flex-col gap-4 md:gap-6"
    >
      <div className="min-w-0">
        {/* StockChartHeading's row: a 28px line, and 8px beneath it. */}
        <div className="mb-2 h-7 w-56 animate-pulse rounded-md bg-muted/40" />
        <StockChartPanelSkeleton />
      </div>
      <div className="h-72 animate-pulse rounded-lg bg-muted/40" />
      <div className="h-40 animate-pulse rounded-lg bg-muted/40" />
      <div className="h-64 animate-pulse rounded-lg bg-muted/40" />
    </div>
  );
}
