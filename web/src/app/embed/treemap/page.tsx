"use client";

import { Suspense } from "react";
import dynamic from "next/dynamic";
import { useSearchParams } from "next/navigation";

const IndustryTreeMapView = dynamic(
  () =>
    import("~/app/treemap/treeMap").then((m) => m.IndustryTreeMapView),
  {
    ssr: false,
    loading: () => (
      <div className="h-[500px] w-full bg-muted animate-pulse rounded" />
    ),
  },
);

function EmbedTreemapInner() {
  const searchParams = useSearchParams();
  const period = searchParams.get("period") ?? "3m";

  return (
    <div className="p-2">
      <h2 className="text-sm font-semibold mb-2">
        ASX Short Positions by Industry
      </h2>
      <IndustryTreeMapView initialPeriod={period} />
    </div>
  );
}

/**
 * Embeddable industry treemap widget.
 * Usage: <iframe src="https://shorted.com.au/embed/treemap?period=3m" />
 */
export default function EmbedTreemap() {
  return (
    <Suspense
      fallback={
        <div className="h-[500px] w-full bg-muted animate-pulse rounded" />
      }
    >
      <EmbedTreemapInner />
    </Suspense>
  );
}
