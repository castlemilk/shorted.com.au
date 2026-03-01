"use client";

import { Suspense } from "react";
import dynamic from "next/dynamic";
import { useSearchParams } from "next/navigation";

const Chart = dynamic(() => import("~/@/components/ui/chart"), {
  ssr: false,
  loading: () => (
    <div className="h-[400px] w-full bg-muted animate-pulse rounded" />
  ),
});

function EmbedChartInner() {
  const searchParams = useSearchParams();
  const code = searchParams.get("code")?.toUpperCase() ?? "BHP";

  return (
    <div className="p-2">
      <h2 className="text-sm font-semibold mb-2">
        {code} Short Position History
      </h2>
      <div className="h-[400px]">
        <Chart stockCode={code} />
      </div>
    </div>
  );
}

/**
 * Embeddable short position chart widget.
 * Usage: <iframe src="https://shorted.com.au/embed/chart?code=BHP" />
 */
export default function EmbedChart() {
  return (
    <Suspense
      fallback={
        <div className="h-[400px] w-full bg-muted animate-pulse rounded" />
      }
    >
      <EmbedChartInner />
    </Suspense>
  );
}
