"use client";

import { useEffect, useState } from "react";
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

export function PriceChart({
  code,
  window: win = "6m",
}: {
  code: string;
  window?: Window;
}) {
  const [points, setPoints] = useState<SeriesPoint[] | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setPoints(null);
    setFailed(false);

    getHistoricalData(code, win)
      .then((prices) => {
        if (cancelled) return;
        setPoints(toSeriesPoints(prices ?? []));
      })
      .catch(() => {
        if (!cancelled) setFailed(true);
      });

    return () => {
      cancelled = true;
    };
  }, [code, win]);

  if (failed) return null;
  if (points === null) return <Skeleton className="my-8 h-[280px] w-full" />;
  if (points.length < 2) return null;

  return (
    <figure className="my-8">
      <figcaption className="mb-2 text-xs uppercase tracking-wider text-muted-foreground">
        {code} share price — {win}
      </figcaption>
      <ArticleSeriesChart
        points={points}
        height={280}
        formatValue={(v) => `$${v.toFixed(2)}`}
        gradientId={`price-gradient-${code}`}
      />
    </figure>
  );
}
