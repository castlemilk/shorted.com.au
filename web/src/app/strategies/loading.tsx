// The explorer's loading boundary (design 10.1): the table's frame is drawn at once, so a
// cold visit announces that the page is loading and the layout does not jump when it lands.
export default function ExplorerLoading() {
  return (
    <div role="status" aria-busy="true" aria-label="Loading" className="mx-auto w-full max-w-[1400px] space-y-6 px-4 py-6 sm:px-8">
      <div className="h-10 w-80 max-w-full animate-pulse rounded-sm bg-muted" />
      <div className="h-8 w-full animate-pulse rounded-sm bg-muted" />
      <div className="h-96 w-full animate-pulse rounded-lg border border-border/60 bg-card" />
      <span className="sr-only">Loading the strategies</span>
    </div>
  );
}
