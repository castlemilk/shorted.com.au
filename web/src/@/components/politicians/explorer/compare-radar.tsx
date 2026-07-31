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

const CENTER_X = 200;
const CENTER_Y = 132;
const RADIUS = 88;

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
          viewBox="0 0 400 230"
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
              x1="150"
              y1={CENTER_Y}
              x2="250"
              y2={CENTER_Y}
              stroke="hsl(var(--muted-foreground))"
              strokeWidth="1.5"
              strokeDasharray="3 3"
            />
          )}
          {values.map((axis, index) => {
            const point = outerPoints[index] ?? { x: CENTER_X, y: CENTER_Y };
            const textAnchor =
              point.x < CENTER_X - 2
                ? "end"
                : point.x > CENTER_X + 2
                  ? "start"
                  : "middle";
            const dy = point.y < CENTER_Y ? -6 : point.y > CENTER_Y ? 14 : 4;
            return (
              <text
                key={`${axis.label}-${index}`}
                x={point.x}
                y={point.y + dy}
                textAnchor={textAnchor}
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
