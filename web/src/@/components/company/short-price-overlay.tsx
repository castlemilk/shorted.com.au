"use client";

import { useEffect, useMemo, useState } from "react";
import { CandlestickChart, TrendingDown } from "lucide-react";
import {
  ShortPriceOverlayChart,
  type OverlayPoint,
} from "~/@/components/ui/short-price-overlay-chart";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "~/@/components/ui/card";
import { Skeleton } from "~/@/components/ui/skeleton";
import {
  ToggleGroup,
  ToggleGroupItem,
} from "~/@/components/ui/toggle-group";
import { fetchStockDataClient } from "~/@/lib/client-api";
import {
  getHistoricalData,
  type HistoricalDataPoint,
} from "~/@/lib/stock-data-service";
import { type TimeSeriesPoint } from "~/gen/stocks/v1alpha1/stocks_pb";

interface ShortPriceOverlayProps {
  stockCode: string;
  initialPeriod?: string;
}

const PERIODS = ["3m", "6m", "1y", "2y", "5y"] as const;
type Period = (typeof PERIODS)[number];

interface MergedSeries {
  points: OverlayPoint[];
  correlation: number | null;
}

const dayKey = (d: Date): string =>
  `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-${String(d.getUTCDate()).padStart(2, "0")}`;

function mergeSeries(
  shorts: TimeSeriesPoint[],
  prices: HistoricalDataPoint[],
): MergedSeries {
  // Index both series by ISO date string for a tight inner-join then a
  // left-outer-join on the union of dates. Most stocks have daily price
  // points; short positions are also daily (ASIC T+4) so the union is
  // tight.
  const byDate = new Map<string, OverlayPoint>();

  for (const s of shorts) {
    const ts = s.timestamp;
    if (!ts) continue;
    const seconds =
      typeof ts === "string"
        ? Math.floor(new Date(ts).getTime() / 1000)
        : Number(ts.seconds ?? 0);
    if (!seconds) continue;
    const d = new Date(seconds * 1000);
    const key = dayKey(d);
    byDate.set(key, {
      date: d,
      price: null,
      shortPct: s.shortPosition ?? 0,
    });
  }

  for (const p of prices) {
    const d = new Date(p.date);
    if (Number.isNaN(d.getTime())) continue;
    const key = dayKey(d);
    const existing = byDate.get(key);
    if (existing) {
      existing.price = p.close;
    } else {
      byDate.set(key, {
        date: d,
        price: p.close,
        shortPct: null,
      });
    }
  }

  const points = Array.from(byDate.values()).sort(
    (a, b) => a.date.getTime() - b.date.getTime(),
  );

  // Pearson correlation on overlapping days where BOTH series exist.
  const pairs = points.filter(
    (p) => p.price !== null && p.shortPct !== null,
  ) as Array<{ price: number; shortPct: number }>;
  let correlation: number | null = null;
  if (pairs.length >= 5) {
    const n = pairs.length;
    const meanX = pairs.reduce((s, p) => s + p.price, 0) / n;
    const meanY = pairs.reduce((s, p) => s + p.shortPct, 0) / n;
    let cov = 0;
    let varX = 0;
    let varY = 0;
    for (const p of pairs) {
      const dx = p.price - meanX;
      const dy = p.shortPct - meanY;
      cov += dx * dy;
      varX += dx * dx;
      varY += dy * dy;
    }
    if (varX > 0 && varY > 0) {
      correlation = cov / Math.sqrt(varX * varY);
    }
  }

  return { points, correlation };
}

export function ShortPriceOverlay({
  stockCode,
  initialPeriod = "1y",
}: ShortPriceOverlayProps) {
  const [period, setPeriod] = useState<Period>(
    (PERIODS as readonly string[]).includes(initialPeriod)
      ? (initialPeriod as Period)
      : "1y",
  );
  const [shortPoints, setShortPoints] = useState<TimeSeriesPoint[]>([]);
  const [pricePoints, setPricePoints] = useState<HistoricalDataPoint[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<Error | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);

    Promise.all([
      fetchStockDataClient(stockCode, period),
      getHistoricalData(stockCode, period),
    ])
      .then(([shortsResp, prices]) => {
        if (cancelled) return;
        setShortPoints(shortsResp?.points ?? []);
        setPricePoints(prices ?? []);
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setError(err instanceof Error ? err : new Error(String(err)));
        setShortPoints([]);
        setPricePoints([]);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [stockCode, period]);

  const merged = useMemo(
    () => mergeSeries(shortPoints, pricePoints),
    [shortPoints, pricePoints],
  );

  return (
    <Card className="overflow-hidden border-l-4 border-l-purple-500 shadow-lg transition-all duration-300 hover:shadow-xl">
      <CardHeader className="bg-gradient-to-r from-purple-50/50 to-transparent pb-4 dark:from-purple-950/20 dark:to-transparent">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-3">
            <div className="rounded-lg bg-purple-100 p-2.5 shadow-sm dark:bg-purple-900/40">
              <CandlestickChart className="h-6 w-6 text-purple-600 dark:text-purple-400" />
            </div>
            <div className="flex-1">
              <CardTitle className="text-xl text-purple-900 dark:text-purple-100">
                Price vs Short Interest
              </CardTitle>
              <CardDescription className="mt-1.5 text-sm">
                Daily closing price overlaid with ASIC short-position %.{" "}
                {merged.correlation !== null && (
                  <span className="font-medium text-foreground">
                    Correlation:{" "}
                    <span
                      className={
                        merged.correlation > 0.3
                          ? "text-emerald-600 dark:text-emerald-400"
                          : merged.correlation < -0.3
                            ? "text-rose-600 dark:text-rose-400"
                            : "text-muted-foreground"
                      }
                    >
                      {merged.correlation > 0 ? "+" : ""}
                      {merged.correlation.toFixed(2)}
                    </span>
                  </span>
                )}
              </CardDescription>
            </div>
          </div>

          <ToggleGroup
            type="single"
            value={period}
            onValueChange={(v) => {
              if (v) setPeriod(v as Period);
            }}
            size="sm"
          >
            {PERIODS.map((p) => (
              <ToggleGroupItem key={p} value={p} className="px-2.5 text-xs">
                {p}
              </ToggleGroupItem>
            ))}
          </ToggleGroup>
        </div>
      </CardHeader>

      <CardContent className="pt-4">
        {loading ? (
          <Skeleton className="h-[360px] w-full" />
        ) : error ? (
          <div className="flex h-[360px] flex-col items-center justify-center gap-2 text-sm text-muted-foreground">
            <TrendingDown className="h-6 w-6 text-rose-500" />
            <span>Overlay data unavailable right now.</span>
          </div>
        ) : (
          <ShortPriceOverlayChart
            data={merged.points}
            stockCode={stockCode}
            height={360}
          />
        )}

        {!loading && merged.correlation !== null && (
          <p className="mt-3 text-xs leading-relaxed text-muted-foreground">
            {merged.correlation > 0.3
              ? `Rising short interest coincided with rising price over the ${period} window (positive ${merged.correlation.toFixed(2)} correlation) — uncommon, often signals momentum traders crowding into the same shorts as the stock rallies.`
              : merged.correlation < -0.3
                ? `Rising short interest coincided with falling price over the ${period} window (negative ${merged.correlation.toFixed(2)} correlation) — the classic short-seller setup playing out.`
                : `Short interest and price moved largely independently over the ${period} window (correlation ${merged.correlation.toFixed(2)}).`}
          </p>
        )}
      </CardContent>
    </Card>
  );
}

export default ShortPriceOverlay;
