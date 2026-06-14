import type { ChartPoint } from "./types";
import type { TimeSeriesData } from "~/gen/stocks/v1alpha1/stocks_pb";
import type { HistoricalDataPoint } from "@/lib/stock-data-service";

/** protobuf Timestamp → epoch ms (seconds is a bigint). */
function tsToMs(ts?: { seconds?: bigint; nanos?: number } | null): number {
  if (!ts) return 0;
  return Number(ts.seconds ?? 0) * 1000 + Number(ts.nanos ?? 0) / 1_000_000;
}

export function shortSeriesToPoints(d: TimeSeriesData | undefined): ChartPoint[] {
  if (!d?.points?.length) return [];
  return d.points
    .map((p) => ({ t: tsToMs(p.timestamp), v: p.shortPosition }))
    .filter((p) => p.t > 0 && Number.isFinite(p.v))
    .sort((a, b) => a.t - b.t);
}

export function historicalToPoints(rows: HistoricalDataPoint[] | undefined): {
  price: ChartPoint[];
  volume: ChartPoint[];
} {
  if (!rows?.length) return { price: [], volume: [] };
  const sorted = [...rows].sort(
    (a, b) => new Date(a.date).getTime() - new Date(b.date).getTime(),
  );
  const ok = (p: ChartPoint) => p.t > 0 && Number.isFinite(p.v);
  const price = sorted
    .map((r) => ({
      t: new Date(r.date).getTime(),
      v: r.close,
      open: r.open,
      high: r.high,
      low: r.low,
      close: r.close,
    }))
    .filter(ok);
  const volume = sorted
    .map((r) => ({ t: new Date(r.date).getTime(), v: r.volume }))
    .filter(ok);
  return { price, volume };
}

const dayKey = (t: number) => Math.floor(t / 86_400_000);

/** Inner join two ascending series by calendar day (for correlation/overlay). */
export function mergeByDay(
  a: ChartPoint[],
  b: ChartPoint[],
): { t: number; a: number; b: number }[] {
  const bByDay = new Map<number, number>();
  for (const p of b) bByDay.set(dayKey(p.t), p.v);
  const out: { t: number; a: number; b: number }[] = [];
  for (const p of a) {
    const bv = bByDay.get(dayKey(p.t));
    if (bv !== undefined) out.push({ t: p.t, a: p.v, b: bv });
  }
  return out;
}
