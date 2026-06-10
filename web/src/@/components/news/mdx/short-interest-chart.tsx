"use client";

import { useQuery } from "@tanstack/react-query";
import { Skeleton } from "~/@/components/ui/skeleton";
import { fetchStockDataClient } from "~/@/lib/client-api";
import { type TimeSeriesPoint } from "~/gen/stocks/v1alpha1/stocks_pb";
import { ArticleSeriesChart, type SeriesPoint } from "./article-series-chart";

type Window = "1m" | "3m" | "6m" | "1y";

function toSeriesPoints(points: TimeSeriesPoint[]): SeriesPoint[] {
  const result: SeriesPoint[] = [];
  for (const p of points) {
    const ts = p.timestamp;
    if (!ts) continue;
    const date =
      typeof ts === "string" ? new Date(ts) : new Date(Number(ts.seconds ?? 0) * 1000);
    if (Number.isNaN(date.getTime())) continue;
    result.push({ date, value: p.shortPosition ?? 0 });
  }
  return result.sort((a, b) => a.date.getTime() - b.date.getTime());
}

async function fetchPoints(code: string, win: Window): Promise<SeriesPoint[]> {
  const resp = await fetchStockDataClient(code, win);
  return toSeriesPoints(resp?.points ?? []);
}

export function ShortInterestChart({
  code,
  window: win = "6m",
}: {
  code: string;
  window?: Window;
}) {
  const { data: points, isLoading, isError } = useQuery({
    queryKey: ["mdx-short-interest", code, win],
    queryFn: () => fetchPoints(code, win),
    staleTime: 5 * 60 * 1000,
    retry: 1,
  });

  if (isError) return null;
  if (isLoading) return <Skeleton className="my-8 h-[280px] w-full" />;
  if ((points?.length ?? 0) < 2) return null;

  return (
    <figure className="my-8">
      <figcaption className="mb-2 text-xs uppercase tracking-wider text-muted-foreground">
        {code} short interest — {win}
      </figcaption>
      <ArticleSeriesChart
        points={points!}
        height={280}
        formatValue={(v) => `${v.toFixed(1)}%`}
        gradientId={`short-interest-gradient-${code}`}
        ariaLabel={`${code} short interest over ${win}`}
      />
    </figure>
  );
}
