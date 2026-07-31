import { AMBER_STEPS } from "@/lib/politics/analytics-palette";

export interface CountDonutSegment {
  label: string;
  count: number;
  color?: string;
}

export interface CountDonutProps {
  segments: CountDonutSegment[];
  centerLabel: string;
  title: string;
}

function safeCount(count: number): number {
  return Number.isFinite(count) ? Math.max(0, Math.trunc(count)) : 0;
}

function segmentColor(segment: CountDonutSegment, index: number): string {
  return (
    segment.color ?? AMBER_STEPS[index % AMBER_STEPS.length] ?? AMBER_STEPS[0]
  );
}

export function CountDonut({ segments, centerLabel, title }: CountDonutProps) {
  const values = segments.map((segment) => ({
    ...segment,
    count: safeCount(segment.count),
  }));
  const total = values.reduce((sum, segment) => sum + segment.count, 0);
  const radius = 32;
  const circumference = 2 * Math.PI * radius;
  let offset = 0;
  const ariaDetails = values.length
    ? values.map((segment) => `${segment.label}: ${segment.count}`).join("; ")
    : "no segments";

  return (
    <figure className="space-y-2">
      <figcaption className="text-sm font-medium text-foreground">
        {title}
      </figcaption>
      <div className="relative mx-auto aspect-square max-w-52">
        <svg
          viewBox="0 0 100 100"
          role="img"
          aria-label={`${title}. ${ariaDetails}. Total: ${total} ${centerLabel}.`}
          className="h-full w-full"
        >
          <circle
            cx="50"
            cy="50"
            r={radius}
            fill="none"
            stroke="hsl(var(--border))"
            strokeWidth="16"
            className={total > 0 ? "opacity-40" : "opacity-80"}
          />
          <g transform="rotate(-90 50 50)">
            {values.map((segment, index) => {
              if (segment.count === 0 || total === 0) return null;
              const length = (segment.count / total) * circumference;
              const dash = `${length} ${circumference - length}`;
              const circle = (
                <circle
                  key={`${segment.label}-${index}`}
                  cx="50"
                  cy="50"
                  r={radius}
                  fill="none"
                  stroke={segmentColor(segment, index)}
                  strokeWidth="16"
                  strokeDasharray={dash}
                  strokeDashoffset={-offset}
                  strokeLinecap="butt"
                />
              );
              offset += length;
              return circle;
            })}
          </g>
          <text
            x="50"
            y="48"
            textAnchor="middle"
            className="text-xl font-semibold tabular-nums"
            fill="currentColor"
          >
            {total}
          </text>
          <text
            x="50"
            y="57"
            textAnchor="middle"
            className="text-[10px] text-muted-foreground"
            fill="currentColor"
          >
            {centerLabel}
          </text>
        </svg>
      </div>
      <table className="sr-only" aria-label={`${title} table`}>
        <caption>{title}</caption>
        <thead>
          <tr>
            <th scope="col">Category</th>
            <th scope="col">Count</th>
          </tr>
        </thead>
        <tbody>
          {values.map((segment, index) => (
            <tr key={`${segment.label}-${index}`}>
              <th scope="row">{segment.label}</th>
              <td className="tabular-nums">{segment.count}</td>
            </tr>
          ))}
          <tr>
            <th scope="row">Total</th>
            <td className="tabular-nums">{total}</td>
          </tr>
        </tbody>
      </table>
    </figure>
  );
}
