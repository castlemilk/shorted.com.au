/**
 * The Backtest tab's skeleton: the window row, the growth chart's height, and the
 * summary column. It is the same height as the drawn page, so the mount moves nothing.
 */
export default function StrategyBacktestLoading() {
  return (
    <div
      role="status"
      aria-busy="true"
      aria-label="Loading"
      className="flex flex-col gap-6 md:gap-8"
    >
      <div className="h-8 w-80 animate-pulse rounded-md bg-muted/40" />
      <div className="grid gap-8 lg:grid-cols-[minmax(0,1fr)_340px]">
        <div className="h-[430px] animate-pulse rounded-lg bg-muted/40" />
        <div className="h-[430px] animate-pulse rounded-lg bg-muted/40" />
      </div>
    </div>
  );
}
