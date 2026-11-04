/**
 * The Overview's skeleton. The profile's chrome (breadcrumbs, faceplate and tab
 * bar) comes from the layout and is already on screen, so this draws only the
 * tab's own blocks, in the order the Overview lays them out.
 */
export default function StrategyOverviewLoading() {
  return (
    <div
      role="status"
      aria-busy="true"
      aria-label="Loading"
      className="flex flex-col gap-4 md:gap-6"
    >
      <div className="h-7 w-48 animate-pulse rounded-md bg-muted/40" />
      <div className="h-64 animate-pulse rounded-lg bg-muted/40" />
      <div className="h-40 animate-pulse rounded-lg bg-muted/40" />
    </div>
  );
}
