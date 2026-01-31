import { Skeleton } from "~/@/components/ui/skeleton";

export function TopPageSkeleton() {
  return (
    <div className="min-h-screen bg-background">
      {/* Hero skeleton */}
      <div className="border-b border-border/40 bg-gradient-to-b from-background to-muted/20">
        <div className="container mx-auto px-4 py-12">
          <Skeleton className="h-12 w-96 mb-4" />
          <Skeleton className="h-6 w-[600px] max-w-full mb-8" />
          <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
            {Array.from({ length: 4 }).map((_, i) => (
              <Skeleton key={i} className="h-24 rounded-lg" />
            ))}
          </div>
        </div>
      </div>
      {/* Movers skeleton */}
      <div className="border-b border-border/40 bg-muted/30">
        <div className="container mx-auto px-4 py-8">
          <Skeleton className="h-6 w-32 mb-6" />
          <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
            {Array.from({ length: 3 }).map((_, i) => (
              <Skeleton key={i} className="h-64 rounded-lg" />
            ))}
          </div>
        </div>
      </div>
      {/* Table skeleton */}
      <div className="container mx-auto px-4 py-8">
        <div className="space-y-2">
          {Array.from({ length: 15 }).map((_, i) => (
            <Skeleton key={i} className="h-16 rounded-lg" />
          ))}
        </div>
      </div>
    </div>
  );
}
