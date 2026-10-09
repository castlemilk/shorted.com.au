export default function StrategyLoading() {
  return (
    <div
      role="status"
      aria-busy="true"
      aria-label="Loading"
      className="flex flex-col gap-4 md:gap-6"
    >
      <div className="h-16 animate-pulse rounded-lg bg-muted/40" />
      <div className="h-[360px] animate-pulse rounded-lg bg-muted/40" />
      <div className="h-64 animate-pulse rounded-lg bg-muted/40" />
    </div>
  );
}
