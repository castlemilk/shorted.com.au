"use client";

/**
 * dynamic(ssr:false) wrapper for the /themes charts.
 *
 * The visx chart measures on the client (ParentSize) and cannot server-render;
 * server components must import theme charts from this module only. Mirrors
 * industry-charts.tsx and housing-charts.tsx.
 */
import dynamic from "next/dynamic";

function ChartSkeleton({ height }: { height: number }) {
  return (
    <div
      className="w-full animate-pulse rounded-md bg-muted/40"
      style={{ height }}
      aria-hidden="true"
    />
  );
}

export const ThemeShortInterestChart = dynamic(
  () =>
    import("./theme-short-interest-chart").then(
      (m) => m.ThemeShortInterestChart,
    ),
  { ssr: false, loading: () => <ChartSkeleton height={260} /> },
);
