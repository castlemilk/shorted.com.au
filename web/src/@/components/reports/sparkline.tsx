import { cn } from "~/@/lib/utils";

/**
 * Pure inline-SVG sparkline for ~13 weekly short-interest points.
 *
 * Server-renderable (no "use client"). Stroke colour follows the page's
 * red-equals-risk convention: rising short interest is red, falling is
 * green, flat is muted. Renders nothing for fewer than 3 points.
 */

export interface SparklineGeometry {
  /** SVG polyline `points` attribute */
  points: string;
  /** End-dot coordinates */
  end: { x: number; y: number };
  /** Net direction of the series */
  direction: "up" | "down" | "flat";
}

const EPSILON = 1e-9;

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

/**
 * Computes the polyline geometry for a sparkline. Exported for unit tests.
 * Returns null when there are fewer than 3 finite points.
 */
export function buildSparklineGeometry(
  data: number[],
  width: number,
  height: number,
): SparklineGeometry | null {
  const values = (data ?? []).filter((v) => Number.isFinite(v));
  if (values.length < 3) return null;

  const min = Math.min(...values);
  const max = Math.max(...values);
  const range = max - min;

  // Padding keeps the 1.5px stroke and the 2px end-dot inside the viewBox.
  const padX = 2.5;
  const padY = 3;
  const innerW = width - padX * 2;
  const innerH = height - padY * 2;

  const coords = values.map((v, i) => {
    const x = padX + (i / (values.length - 1)) * innerW;
    const y =
      range < EPSILON
        ? height / 2
        : padY + (1 - (v - min) / range) * innerH;
    return { x: round2(x), y: round2(y) };
  });

  const first = values[0]!;
  const last = values[values.length - 1]!;
  const delta = last - first;
  const direction: SparklineGeometry["direction"] =
    delta > EPSILON ? "up" : delta < -EPSILON ? "down" : "flat";

  return {
    points: coords.map((c) => `${c.x},${c.y}`).join(" "),
    end: coords[coords.length - 1]!,
    direction,
  };
}

interface SparklineProps {
  data: number[];
  width?: number;
  height?: number;
  className?: string;
  /** Accessible label context, e.g. "BHP 13-week short interest" */
  label?: string;
}

const DIRECTION_CLASS: Record<SparklineGeometry["direction"], string> = {
  up: "text-red-500",
  down: "text-green-600",
  flat: "text-muted-foreground",
};

export function Sparkline({
  data,
  width = 90,
  height = 24,
  className,
  label,
}: SparklineProps) {
  const geometry = buildSparklineGeometry(data, width, height);
  if (!geometry) return null;

  const first = data[0]!;
  const last = data[data.length - 1]!;
  const ariaLabel =
    label ??
    `Trend ${geometry.direction === "up" ? "rising" : geometry.direction === "down" ? "falling" : "flat"} from ${first.toFixed(2)}% to ${last.toFixed(2)}% over ${data.length} weeks`;

  return (
    <svg
      width={width}
      height={height}
      viewBox={`0 0 ${width} ${height}`}
      role="img"
      aria-label={ariaLabel}
      className={cn("shrink-0", DIRECTION_CLASS[geometry.direction], className)}
    >
      <polyline
        points={geometry.points}
        fill="none"
        stroke="currentColor"
        strokeWidth={1.5}
        strokeLinecap="round"
        strokeLinejoin="round"
        opacity={0.85}
      />
      <circle
        cx={geometry.end.x}
        cy={geometry.end.y}
        r={2}
        fill="currentColor"
      />
    </svg>
  );
}
