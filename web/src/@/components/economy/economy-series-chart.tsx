"use client";

import { useQuery } from "@tanstack/react-query";
import { getEconomicSeriesClient } from "~/app/actions/client/getEconomyClient";
import { ArticleSeriesChart } from "@/components/news/mdx/article-series-chart";

// Formatter chosen by a serializable key — functions can't cross the
// server→client component boundary, so the server page passes `format`.
const FORMATTERS: Record<string, (v: number) => string> = {
  aud: (v) =>
    Math.abs(v) >= 1_000_000_000
      ? `$${(v / 1_000_000_000).toFixed(1)}B`
      : Math.abs(v) >= 1_000_000
        ? `$${(v / 1_000_000).toFixed(0)}M`
        : `$${Math.round(v).toLocaleString()}`,
  percent: (v) => `${v.toFixed(1)}%`,
  index: (v) => v.toFixed(1),
  megalitres: (v) =>
    Math.abs(v) >= 1_000 ? `${(v / 1_000).toFixed(1)}GL` : `${v.toFixed(0)}ML`,
  usd: (v) => v.toFixed(2),
};

/**
 * Fetches a single economic series client-side and renders it as an amber
 * area chart. Loaded via economy-charts.tsx (dynamic, ssr:false) because it
 * pulls in connect-web. Same pattern as housing-series-chart.tsx.
 */
export function EconomySeriesChart({
  seriesKey,
  ariaLabel,
  format = "percent",
  height = 280,
}: {
  seriesKey: string;
  ariaLabel: string;
  format?: "aud" | "percent" | "index" | "megalitres" | "usd";
  height?: number;
}) {
  const { data, isLoading } = useQuery({
    queryKey: ["economy-series", seriesKey],
    queryFn: () => getEconomicSeriesClient([seriesKey]),
    staleTime: 60 * 60 * 1000,
  });

  if (isLoading) {
    return <div className="w-full animate-pulse rounded bg-muted" style={{ height }} />;
  }

  const points = (data?.series[0]?.observations ?? [])
    .map((obs) => ({
      date: new Date(Number(obs.period?.seconds ?? 0n) * 1000),
      value: obs.value,
    }))
    .filter((p) => !Number.isNaN(p.date.getTime()));

  if (points.length < 2) {
    return (
      <div
        className="flex items-center justify-center text-sm text-muted-foreground"
        style={{ height }}
      >
        No data available
      </div>
    );
  }

  return (
    <ArticleSeriesChart
      points={points}
      ariaLabel={ariaLabel}
      formatValue={FORMATTERS[format]}
      height={height}
      gradientId={`economy-${seriesKey.replace(/[^a-z0-9]/gi, "-")}`}
    />
  );
}
