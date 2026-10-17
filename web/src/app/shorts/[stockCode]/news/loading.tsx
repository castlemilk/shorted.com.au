export default function NewsLoading() {
  return (
    <div
      role="status"
      aria-busy="true"
      aria-label="Loading"
      className="flex flex-col gap-4"
    >
      <div className="h-10 animate-pulse rounded-lg bg-muted/40" />
      <div className="h-64 animate-pulse rounded-lg bg-muted/40" />
      <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
        {Array.from({ length: 6 }, (_, i) => (
          <div key={i} className="h-40 animate-pulse rounded-lg bg-muted/40" />
        ))}
      </div>
    </div>
  );
}
