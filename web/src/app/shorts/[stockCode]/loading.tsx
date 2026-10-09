/** Overview skeleton: the layout above it is already on screen. */
export default function StockOverviewLoading() {
  return (
    <div
      role="status"
      aria-busy="true"
      aria-label="Loading"
      className="grid min-w-0 grid-cols-1 items-start gap-4 md:gap-6 lg:grid-cols-[minmax(0,1fr)_310px]"
    >
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
  );
}
