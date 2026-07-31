import { AMBER_STEPS } from "@/lib/politics/analytics-palette";

export interface SparkTrendPoint {
  month: string;
  count: number;
}

export interface SparkTrendProps {
  points: SparkTrendPoint[];
}

function safeCount(count: number): number {
  return Number.isFinite(count) ? Math.max(0, Math.trunc(count)) : 0;
}

export function SparkTrend({ points }: SparkTrendProps) {
  const values = points.map((point) => ({
    ...point,
    count: safeCount(point.count),
  }));
  const counts = values.map((point) => point.count);
  const isEmpty = values.length === 0;
  const isFlat = !isEmpty && counts.every((count) => count === counts[0]);
  const max = Math.max(...counts, 0);
  const min = Math.min(...counts, 0);
  const range = max - min || 1;
  const polyline = values
    .map((point, index) => {
      const x =
        values.length <= 1 ? 80 : 8 + (index / (values.length - 1)) * 144;
      const y = 32 - ((point.count - min) / range) * 24;
      return `${x.toFixed(2)},${y.toFixed(2)}`;
    })
    .join(" ");
  const dataState = isEmpty ? "empty" : isFlat ? "flat" : "trend";
  const ariaLabel = isEmpty
    ? "Monthly count trend: no dated counts."
    : `Monthly count trend: ${values
        .map((point) => `${point.month} ${point.count}`)
        .join(", ")}.`;

  return (
    <figure>
      <svg
        viewBox="0 0 160 40"
        role="img"
        aria-label={ariaLabel}
        data-state={dataState}
        className="h-10 w-full max-w-52 text-muted-foreground"
      >
        {isEmpty || isFlat ? (
          <line
            x1="8"
            y1="20"
            x2="152"
            y2="20"
            stroke="hsl(var(--muted-foreground))"
            strokeWidth="1.5"
            strokeDasharray="3 3"
          />
        ) : (
          <polyline
            fill="none"
            stroke={AMBER_STEPS[3] ?? AMBER_STEPS[0]}
            strokeWidth="2"
            strokeLinejoin="round"
            strokeLinecap="round"
            points={polyline}
          />
        )}
      </svg>
      <table className="sr-only" aria-label="Monthly count trend table">
        <caption>Monthly count trend</caption>
        <thead>
          <tr>
            <th scope="col">Month</th>
            <th scope="col">Count</th>
          </tr>
        </thead>
        <tbody>
          {values.length ? (
            values.map((point) => (
              <tr key={point.month}>
                <th scope="row">{point.month}</th>
                <td className="tabular-nums">{point.count}</td>
              </tr>
            ))
          ) : (
            <tr>
              <th scope="row">No dated entries</th>
              <td className="tabular-nums">0</td>
            </tr>
          )}
        </tbody>
      </table>
    </figure>
  );
}
