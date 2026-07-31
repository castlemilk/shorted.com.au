import { CompareBars } from "./compare-bars";

export interface CompareRadarAxis {
  label: string;
  countA: number;
  countB: number;
}

export interface CompareRadarProps {
  axes: CompareRadarAxis[];
  colorA: string;
  colorB: string;
  nameA: string;
  nameB: string;
}

const WIDTH = 400;
const HEIGHT = 260;
const CENTER_X = 200;
const CENTER_Y = 118;
const RADIUS = 82;
/** Where the vertex labels sit — outside the outermost ring, never on it. */
const LABEL_RADIUS = RADIUS + 14;
/**
 * The margin every label must stay inside.
 *
 * The bottom label used to be clipped whenever the axis count was even: with an
 * even count one vertex lands due south, at CENTER_Y + RADIUS, and the label
 * was drawn a further 14 units below that — past the bottom of the viewBox. It
 * was invisible for exactly the inputs (2, 4, 6 grouped categories) the compare
 * page will actually pass.
 */
const LABEL_MARGIN = 10;

/** Below three axes a polygon has no area, so the radar stops being a radar. */
const MIN_RADAR_AXES = 3;

function safeCount(count: number): number {
  return Number.isFinite(count) ? Math.max(0, Math.trunc(count)) : 0;
}

function angleFor(index: number, count: number): number {
  return -Math.PI / 2 + (index * 2 * Math.PI) / Math.max(count, 1);
}

function pointFor(
  value: number,
  max: number,
  index: number,
  axisCount: number,
  radius = RADIUS,
) {
  const scale = max > 0 ? Math.sqrt(Math.max(0, value) / max) : 0;
  const angle = angleFor(index, axisCount);
  return {
    x: CENTER_X + Math.cos(angle) * radius * scale,
    y: CENTER_Y + Math.sin(angle) * radius * scale,
  };
}

function outerPoint(index: number, axisCount: number, radius = RADIUS) {
  const angle = angleFor(index, axisCount);
  return {
    x: CENTER_X + Math.cos(angle) * radius,
    y: CENTER_Y + Math.sin(angle) * radius,
  };
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

/**
 * Where a vertex label goes, and which way it reads from there.
 *
 * The anchor follows the vertex (text runs away from the chart, never across
 * it) and the baseline is nudged clear of the ring, then both coordinates are
 * clamped into the viewBox so no axis count can push a label out of frame.
 */
function labelLayout(index: number, axisCount: number) {
  const point = outerPoint(index, axisCount, LABEL_RADIUS);
  const dx = point.x - CENTER_X;
  const dy = point.y - CENTER_Y;
  const textAnchor: "start" | "middle" | "end" =
    dx < -2 ? "end" : dx > 2 ? "start" : "middle";
  const baselineNudge = dy < -2 ? -2 : dy > 2 ? 8 : 3;
  return {
    x: clamp(point.x, LABEL_MARGIN, WIDTH - LABEL_MARGIN),
    y: clamp(point.y + baselineNudge, LABEL_MARGIN, HEIGHT - LABEL_MARGIN),
    textAnchor,
  };
}

function pointsAttribute(points: { x: number; y: number }[]): string {
  return points
    .map((point) => `${point.x.toFixed(2)},${point.y.toFixed(2)}`)
    .join(" ");
}

function closedPath(points: { x: number; y: number }[]): string {
  return points.length ? `M ${pointsAttribute(points)} Z` : "";
}

export function CompareRadar({
  axes,
  colorA,
  colorB,
  nameA,
  nameB,
}: CompareRadarProps) {
  const values = axes.map((axis) => ({
    ...axis,
    countA: safeCount(axis.countA),
    countB: safeCount(axis.countB),
  }));

  /*
   * ONE OR TWO AXES IS A LINE, NOT A SHAPE.
   *
   * The polygon for a single axis is a point and for two axes a zero-area
   * segment: both render as nothing visible, while the empty-state fallback
   * only fired at zero axes — so "these two members declare one category
   * between them" looked identical to a broken chart. Rather than invent a
   * degenerate radar nobody can read, fall through to the paired bars, which
   * carry the same numbers, the same party colours and the same table, and are
   * the honest presentation at this size. The compare page can hand this kit
   * whatever the data gives it.
   */
  if (values.length > 0 && values.length < MIN_RADAR_AXES) {
    return (
      <CompareBars
        rows={values}
        colorA={colorA}
        colorB={colorB}
        nameA={nameA}
        nameB={nameB}
      />
    );
  }

  const maxCount = values.reduce(
    (max, axis) => Math.max(max, axis.countA, axis.countB),
    0,
  );
  const outerPoints = values.map((_, index) =>
    outerPoint(index, values.length),
  );
  const polygonA = values.map((axis, index) =>
    pointFor(axis.countA, maxCount, index, values.length),
  );
  const polygonB = values.map((axis, index) =>
    pointFor(axis.countB, maxCount, index, values.length),
  );
  const ariaAxes = values.length
    ? values
        .map(
          (axis) =>
            `${axis.label}: ${nameA} ${axis.countA}, ${nameB} ${axis.countB}`,
        )
        .join("; ")
    : "no categories";

  return (
    <figure className="space-y-2">
      <div className="space-y-2">
        <svg
          viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
          role="img"
          aria-label={`Radar comparison of ${nameA} and ${nameB}: ${ariaAxes}.`}
          className="h-auto w-full text-muted-foreground"
        >
          {values.length
            ? [0.33, 0.66, 1].map((level) => (
                <path
                  key={level}
                  d={closedPath(
                    values.map((_, index) =>
                      outerPoint(index, values.length, RADIUS * level),
                    ),
                  )}
                  fill="none"
                  stroke="hsl(var(--border))"
                  strokeWidth="1"
                  strokeDasharray={level === 1 ? undefined : "2 3"}
                />
              ))
            : null}
          {outerPoints.map((point, index) => (
            <line
              key={`axis-${index}`}
              x1={CENTER_X}
              y1={CENTER_Y}
              x2={point.x}
              y2={point.y}
              stroke="hsl(var(--border))"
              strokeWidth="1"
            />
          ))}
          {values.length ? (
            <>
              <polygon
                data-series="a"
                points={pointsAttribute(polygonA)}
                fill={colorA}
                fillOpacity="0.18"
                stroke={colorA}
                strokeWidth="2"
              />
              <polygon
                data-series="b"
                points={pointsAttribute(polygonB)}
                fill={colorB}
                fillOpacity="0.18"
                stroke={colorB}
                strokeWidth="2"
              />
            </>
          ) : (
            <line
              x1={CENTER_X - 50}
              y1={CENTER_Y}
              x2={CENTER_X + 50}
              y2={CENTER_Y}
              stroke="hsl(var(--muted-foreground))"
              strokeWidth="1.5"
              strokeDasharray="3 3"
            />
          )}
          {values.map((axis, index) => {
            const layout = labelLayout(index, values.length);
            return (
              <text
                key={`${axis.label}-${index}`}
                x={layout.x}
                y={layout.y}
                textAnchor={layout.textAnchor}
                data-axis-label={axis.label}
                className="text-[10px] text-muted-foreground"
                fill="currentColor"
              >
                {axis.label}
              </text>
            );
          })}
        </svg>
        <div className="flex flex-wrap gap-x-4 gap-y-1 text-[11px] text-muted-foreground">
          <span className="inline-flex items-center gap-1">
            <span
              aria-hidden
              className="h-2 w-2 rounded-full"
              style={{ backgroundColor: colorA }}
            />
            {nameA}
          </span>
          <span className="inline-flex items-center gap-1">
            <span
              aria-hidden
              className="h-2 w-2 rounded-full"
              style={{ backgroundColor: colorB }}
            />
            {nameB}
          </span>
        </div>
      </div>
      <table
        className="sr-only"
        aria-label={`Radar table for ${nameA} and ${nameB}`}
      >
        <caption>
          Radar comparison of {nameA} and {nameB}
        </caption>
        <thead>
          <tr>
            <th scope="col">Category</th>
            <th scope="col">{nameA}</th>
            <th scope="col">{nameB}</th>
          </tr>
        </thead>
        <tbody>
          {values.map((axis, index) => (
            <tr key={`${axis.label}-${index}`}>
              <th scope="row">{axis.label}</th>
              <td className="tabular-nums">{axis.countA}</td>
              <td className="tabular-nums">{axis.countB}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </figure>
  );
}
