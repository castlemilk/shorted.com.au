export type HousingSeriesFormat = "aud" | "percent" | "index";
export type HousingSeriesTransform = "level" | "yoy";

export interface HousingSeriesPoint {
  date: Date;
  value: number;
}

interface ProtobufLikeSeriesPoint {
  period?: {
    seconds?: bigint | number | string;
  };
  value: number;
}

export function toSeriesPoints(points: readonly ProtobufLikeSeriesPoint[]): HousingSeriesPoint[] {
  const result: HousingSeriesPoint[] = [];

  for (const point of points) {
    if (point.period?.seconds === undefined) continue;

    const date = new Date(Number(point.period.seconds) * 1000);
    if (Number.isNaN(date.getTime())) continue;

    result.push({ date, value: point.value });
  }

  return result;
}

export function transformSeries(
  points: HousingSeriesPoint[],
  transform: HousingSeriesTransform,
): HousingSeriesPoint[] {
  if (transform === "level") return points;

  const pointsByMonth = new Map(
    points.map((point) => [
      `${point.date.getUTCFullYear()}-${point.date.getUTCMonth()}`,
      point.value,
    ]),
  );

  return points.flatMap((point) => {
    const priorValue = pointsByMonth.get(
      `${point.date.getUTCFullYear() - 1}-${point.date.getUTCMonth()}`,
    );
    if (priorValue === undefined || priorValue === 0) return [];

    return [{ date: point.date, value: ((point.value - priorValue) / priorValue) * 100 }];
  });
}

export function formatHousingValue(value: number, format: HousingSeriesFormat): string {
  if (format === "percent") {
    return `${value.toFixed(2).replace(/\.00$/, "").replace(/(\.\d)0$/, "$1")}%`;
  }
  if (format === "index") return value.toFixed(0);

  if (value >= 1_000_000_000_000) return `$${(value / 1_000_000_000_000).toFixed(2)}T`;
  if (value >= 1_000_000_000) return `$${(value / 1_000_000_000).toFixed(2)}B`;
  if (value >= 1_000_000) return `$${(value / 1_000_000).toFixed(2)}M`;
  if (value >= 1_000) return `$${Math.round(value / 1_000)}k`;
  return `$${Math.round(value)}`;
}
