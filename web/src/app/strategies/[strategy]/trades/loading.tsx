/**
 * The Trades tab's skeleton: the summary's figures and the list's rows. The profile's
 * chrome comes from the layout.
 */
export default function StrategyTradesLoading() {
  return (
    <div
      role="status"
      aria-busy="true"
      aria-label="Loading"
      className="flex flex-col gap-6 md:gap-8"
    >
      <div className="h-7 w-44 animate-pulse rounded-md bg-muted/40" />
      <div className="h-32 animate-pulse rounded-lg bg-muted/40" />
      <div className="h-72 animate-pulse rounded-lg bg-muted/40" />
    </div>
  );
}
