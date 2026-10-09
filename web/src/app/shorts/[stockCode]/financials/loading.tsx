export default function FinancialsLoading() {
  return (
    <div
      role="status"
      aria-busy="true"
      aria-label="Loading"
      className="flex flex-col gap-4 md:gap-6"
    >
      <div className="h-32 animate-pulse rounded-lg bg-muted/40" />
      <div className="h-48 animate-pulse rounded-lg bg-muted/40" />
      <div className="h-96 animate-pulse rounded-lg bg-muted/40" />
    </div>
  );
}
