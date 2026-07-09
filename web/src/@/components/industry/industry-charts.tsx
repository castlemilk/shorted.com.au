"use client";

/**
 * dynamic(ssr:false) wrappers for the industry intelligence charts.
 *
 * The visx charts measure on the client (ParentSize) and sit in an import
 * graph adjacent to connect-web — both are SSR landmines (see the housing
 * dashboards.tsx precedent). Server components must import charts from this
 * module only.
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

export const IndustryCrowdingChart = dynamic(
  () =>
    import("./charts/industry-crowding-chart").then(
      (m) => m.IndustryCrowdingChart,
    ),
  { ssr: false, loading: () => <ChartSkeleton height={260} /> },
);

export const ChannelDetail = dynamic(
  () => import("./industry-channel-dashboards").then((m) => m.ChannelDetail),
  { ssr: false, loading: () => <ChartSkeleton height={360} /> },
);

export const EvidenceExportButton = dynamic(
  () =>
    import("./industry-channel-dashboards").then(
      (m) => m.EvidenceExportButton,
    ),
  { ssr: false, loading: () => null },
);
