export default function CompanyLoading() {
  return (
    <div aria-busy="true" aria-label="Loading" className="flex flex-col gap-4 md:gap-6">
      <div className="h-64 animate-pulse rounded-lg bg-muted/40" />
      <div className="h-48 animate-pulse rounded-lg bg-muted/40" />
      <div className="h-40 animate-pulse rounded-lg bg-muted/40" />
    </div>
  );
}
