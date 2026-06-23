"use client";

import { useQuery } from "@tanstack/react-query";
import { getHousePriceSeriesClient } from "~/app/actions/client/getHousingClient";
import { ArticleSeriesChart } from "@/components/news/mdx/article-series-chart";

// Formatter chosen by a serializable key — functions can't cross the
// server→client component boundary, so the server page passes `format`.
const FORMATTERS: Record<string, (v: number) => string> = {
  aud: (v) =>
    v >= 1_000_000
      ? `$${(v / 1_000_000).toFixed(2)}M`
      : v >= 1_000
        ? `$${Math.round(v / 1000)}k`
        : `$${Math.round(v)}`,
  percent: (v) => `${v.toFixed(0)}%`,
  index: (v) => v.toFixed(0),
};

/**
 * Fetches a single house-price series client-side and renders it as an amber
 * area chart. Loaded via housing-charts.tsx (dynamic, ssr:false) because it
 * pulls in connect-web.
 */
export function HousingSeriesChart({
  regionCode,
  measure,
  dwellingType = "",
  ariaLabel,
  format = "aud",
  height = 280,
}: {
  regionCode: string;
  measure: string;
  dwellingType?: string;
  ariaLabel: string;
  format?: "aud" | "percent" | "index";
  height?: number;
}) {
  const { data, isLoading } = useQuery({
    queryKey: ["housing-series", regionCode, measure, dwellingType],
    queryFn: () => getHousePriceSeriesClient(regionCode, measure, dwellingType),
    staleTime: 60 * 60 * 1000,
  });

  if (isLoading) {
    return <div className="w-full animate-pulse rounded bg-muted" style={{ height }} />;
  }

  const points = (data?.points ?? [])
    .map((p) => ({
      date: new Date(Number(p.period?.seconds ?? 0n) * 1000),
      value: p.value,
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
      gradientId={`housing-${regionCode}-${measure}`}
    />
  );
}
