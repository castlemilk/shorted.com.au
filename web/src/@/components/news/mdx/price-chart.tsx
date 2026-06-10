"use client";

import { useQuery } from "@tanstack/react-query";
import { Skeleton } from "~/@/components/ui/skeleton";
import {
  getHistoricalData,
  type HistoricalDataPoint,
} from "~/@/lib/stock-data-service";
import { ArticleSeriesChart, type SeriesPoint } from "./article-series-chart";

type Window = "1m" | "3m" | "6m" | "1y";

function toSeriesPoints(prices: HistoricalDataPoint[]): SeriesPoint[] {
  const result: SeriesPoint[] = [];
  for (const p of prices) {
    const date = new Date(p.date);
    if (Number.isNaN(date.getTime())) continue;
    result.push({ date, value: p.close });
  }
  return result.sort((a, b) => a.date.getTime() - b.date.getTime());
}

async function fetchPoints(code: string, win: Window): Promise<SeriesPoint[]> {
  const prices = await getHistoricalData(code, win);
  return toSeriesPoints(prices ?? []);
}

export function PriceChart({
  code,
  window: win = "6m",
}: {
  code: string;
  window?: Window;
}) {
  const { data: points, isLoading, isError } = useQuery({
    queryKey: ["mdx-price", code, win],
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
        {code} share price — {win}
      </figcaption>
      <ArticleSeriesChart
        points={points!}
        height={280}
        formatValue={(v) => `$${v.toFixed(2)}`}
        gradientId={`price-gradient-${code}`}
        ariaLabel={`${code} share price over ${win}`}
      />
    </figure>
  );
}
