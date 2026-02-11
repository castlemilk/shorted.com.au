import { Skeleton } from "~/@/components/ui/skeleton";

export function ReportSkeleton() {
  return (
    <div className="space-y-8">
      {/* Breadcrumb */}
      <Skeleton className="h-4 w-48" />

      {/* Back link */}
      <Skeleton className="h-4 w-24" />

      {/* Hero */}
      <div className="border-b border-border/40 pb-8">
        <div className="flex items-center gap-3 mb-4">
          <Skeleton className="h-14 w-14 rounded-lg" />
          <div className="space-y-2 flex-1">
            <Skeleton className="h-9 w-3/4" />
            <Skeleton className="h-5 w-48" />
          </div>
        </div>
        <Skeleton className="h-4 w-full max-w-3xl" />
        <Skeleton className="h-4 w-2/3 max-w-2xl mt-1" />
      </div>

      {/* Stats grid */}
      <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-5 gap-4">
        {Array.from({ length: 5 }).map((_, i) => (
          <Skeleton key={i} className="h-24 rounded-lg" />
        ))}
      </div>

      {/* Analysis section */}
      <Skeleton className="h-32 rounded-lg" />

      {/* Top stocks table */}
      <div className="space-y-3">
        <Skeleton className="h-7 w-64" />
        <div className="rounded-lg border border-border/60 overflow-hidden">
          <Skeleton className="h-10 w-full" />
          {Array.from({ length: 10 }).map((_, i) => (
            <Skeleton key={i} className="h-14 w-full" />
          ))}
        </div>
      </div>

      {/* Movers sections */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-8">
        <div className="space-y-3">
          <Skeleton className="h-7 w-40" />
          {Array.from({ length: 5 }).map((_, i) => (
            <Skeleton key={i} className="h-12 w-full rounded-lg" />
          ))}
        </div>
        <div className="space-y-3">
          <Skeleton className="h-7 w-40" />
          {Array.from({ length: 5 }).map((_, i) => (
            <Skeleton key={i} className="h-12 w-full rounded-lg" />
          ))}
        </div>
      </div>

      {/* Narrative blocks */}
      <Skeleton className="h-24 rounded-lg" />
      <Skeleton className="h-20 rounded-lg" />
    </div>
  );
}

export function ReportCardsSkeleton() {
  return (
    <div className="space-y-8">
      <Skeleton className="h-4 w-48" />
      <div className="space-y-2">
        <Skeleton className="h-10 w-96" />
        <Skeleton className="h-5 w-64" />
      </div>

      {/* Report type sections */}
      {Array.from({ length: 3 }).map((_, section) => (
        <div key={section} className="space-y-4">
          <Skeleton className="h-7 w-48" />
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4">
            {Array.from({ length: 4 }).map((_, i) => (
              <Skeleton key={i} className="h-32 rounded-lg" />
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}
