export function StateSuburbExplorerSkeleton() {
  return (
    <div className="space-y-5" aria-hidden="true">
      <div className="grid grid-cols-2 gap-px overflow-hidden rounded-xl border border-border bg-border sm:grid-cols-4">
        {Array.from({ length: 4 }).map((_, index) => (
          <div key={index} className="bg-card p-3 sm:p-4">
            <div className="h-3 w-24 animate-pulse rounded bg-muted" />
            <div className="mt-2 h-6 w-20 animate-pulse rounded bg-muted" />
          </div>
        ))}
      </div>

      <div className="grid gap-6 lg:grid-cols-[300px_1fr]">
        <div className="order-last flex min-h-[420px] flex-col rounded-xl border border-border bg-card lg:order-first lg:min-h-[610px]">
          <div className="space-y-2.5 border-b border-border p-4">
            <div className="h-10 animate-pulse rounded-md bg-muted" />
            <div className="flex items-center gap-2">
              <div className="h-8 flex-1 animate-pulse rounded-md bg-muted" />
              <div className="h-8 w-24 animate-pulse rounded-md bg-muted" />
            </div>
            <div className="h-3 w-28 animate-pulse rounded bg-muted" />
          </div>
          <div className="space-y-2 p-2">
            {Array.from({ length: 8 }).map((_, index) => (
              <div key={index} className="h-9 animate-pulse rounded-md bg-muted" />
            ))}
          </div>
        </div>

        <div className="flex min-h-[560px] flex-col rounded-xl border border-border bg-card p-3 sm:p-5">
          <div className="mb-2 flex items-center gap-2">
            <div className="h-4 w-16 animate-pulse rounded bg-muted" />
            <div className="h-8 w-48 animate-pulse rounded-md bg-muted" />
          </div>
          <div className="min-h-[460px] flex-1 animate-pulse rounded-xl bg-muted" />
        </div>
      </div>
    </div>
  );
}
