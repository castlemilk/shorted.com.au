/**
 * The Signals tab's skeleton. The profile's chrome (breadcrumbs, faceplate and
 * tab bar) comes from the layout, so this draws only the tab's own blocks: the
 * heading and provenance, the matrix, and the evidence panel beside it.
 */
export default function StrategySignalsLoading() {
  return (
    <div
      role="status"
      aria-busy="true"
      aria-label="Loading"
      className="flex flex-col gap-4 md:gap-6"
    >
      <div className="h-7 w-72 animate-pulse rounded-md bg-muted/40" />
      <div className="h-10 w-full animate-pulse rounded-md bg-muted/40" />
      <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(0,380px)]">
        <div className="h-96 animate-pulse rounded-lg bg-muted/40" />
        <div className="h-96 animate-pulse rounded-lg bg-muted/40" />
      </div>
    </div>
  );
}
