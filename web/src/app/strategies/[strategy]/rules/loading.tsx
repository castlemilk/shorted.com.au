/**
 * The Rules tab's skeleton. The profile's chrome (breadcrumbs, faceplate and
 * tab bar) comes from the layout, so this draws only the tab's own blocks: the
 * version, the parameter table and the changelog.
 */
export default function StrategyRulesLoading() {
  return (
    <div
      role="status"
      aria-busy="true"
      aria-label="Loading"
      className="flex flex-col gap-6 md:gap-8"
    >
      <div className="h-7 w-48 animate-pulse rounded-md bg-muted/40" />
      <div className="h-32 animate-pulse rounded-lg bg-muted/40" />
      <div className="h-72 animate-pulse rounded-lg bg-muted/40" />
      <div className="h-40 animate-pulse rounded-lg bg-muted/40" />
    </div>
  );
}
