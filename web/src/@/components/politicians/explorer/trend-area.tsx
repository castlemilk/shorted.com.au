import { AMBER_STEPS } from "@/lib/politics/analytics-palette";

export interface TrendAreaPoint {
  month: string;
  count: number;
}

export interface TrendAreaProps {
  points: TrendAreaPoint[];
  undatedCount?: number;
}

const WIDTH = 640;
const HEIGHT = 240;
const PLOT_LEFT = 42;
const PLOT_RIGHT = 12;
const PLOT_TOP = 16;
const PLOT_BOTTOM = 198;
const PLOT_WIDTH = WIDTH - PLOT_LEFT - PLOT_RIGHT;
const PLOT_HEIGHT = PLOT_BOTTOM - PLOT_TOP;

function safeCount(count: number): number {
  return Number.isFinite(count) ? Math.max(0, Math.trunc(count)) : 0;
}

function yearFor(month: string): string {
  return month.match(/(?:19|20)\d{2}/)?.[0] ?? "Undated";
}

/**
 * The undated note. The verb agrees with the subject — the first cut read
 * "1 entry without a stated date are not plotted", and the tests locked that
 * wording in, which is how a typo becomes a contract.
 */
function footnoteFor(count: number): string | undefined {
  const value = Number.isFinite(count) ? Math.max(0, Math.trunc(count)) : 0;
  if (value <= 0) return undefined;
  return value === 1
    ? "1 entry without a stated date is not plotted."
    : `${value} entries without a stated date are not plotted.`;
}

export function TrendArea({ points, undatedCount = 0 }: TrendAreaProps) {
  const values = points
    .slice(-60)
    .map((point) => ({ ...point, count: safeCount(point.count) }));
  const maxCount = values.reduce((max, point) => Math.max(max, point.count), 0);
  const xFor = (index: number) =>
    values.length <= 1
      ? PLOT_LEFT + PLOT_WIDTH / 2
      : PLOT_LEFT + (index / (values.length - 1)) * PLOT_WIDTH;
  const yFor = (count: number) =>
    PLOT_BOTTOM - (maxCount > 0 ? (count / maxCount) * PLOT_HEIGHT : 0);
  const linePath = values
    .map((point, index) => `${xFor(index)},${yFor(point.count)}`)
    .join(" ");
  const areaPath = values.length
    ? `M ${xFor(0)} ${PLOT_BOTTOM} L ${linePath.replace(/ /g, " L ")} L ${xFor(
        values.length - 1,
      )} ${PLOT_BOTTOM} Z`
    : "";
  const yearTicks: { year: string; index: number }[] = [];
  const seenYears = new Set<string>();
  values.forEach((point, index) => {
    const year = yearFor(point.month);
    if (!seenYears.has(year)) {
      seenYears.add(year);
      yearTicks.push({ year, index });
    }
  });
  const yTicks = Array.from(
    new Set([0, Math.round(maxCount / 2), maxCount]),
  ).sort((a, b) => a - b);
  const singlePoint = values.length === 1 ? values[0] : undefined;
  const singleY = singlePoint ? yFor(singlePoint.count) : 0;
  // Keep the value label off the plot edges: below the dot when the dot is at
  // the top of the band (the usual single-point case, where the one value IS
  // the maximum), above it when the dot is sitting on the baseline.
  const singleLabelY = singleY < PLOT_TOP + 24 ? singleY + 18 : singleY - 10;
  const footnote = footnoteFor(undatedCount);
  const ariaData = values.length
    ? values.map((point) => `${point.month} ${point.count}`).join(", ")
    : "no dated entries";
  const ariaFootnote = footnote ? ` ${footnote}` : "";

  return (
    <figure className="space-y-2">
      <div className="overflow-x-auto">
        <svg
          viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
          role="img"
          aria-label={`Monthly declaration counts: ${ariaData}.${ariaFootnote}`}
          className="h-auto min-w-[32rem] w-full"
        >
          <line
            x1={PLOT_LEFT}
            y1={PLOT_BOTTOM}
            x2={WIDTH - PLOT_RIGHT}
            y2={PLOT_BOTTOM}
            stroke="hsl(var(--border))"
            strokeWidth="1"
          />
          {yTicks.map((tick) => (
            <g key={tick}>
              <line
                x1={PLOT_LEFT}
                y1={yFor(tick)}
                x2={WIDTH - PLOT_RIGHT}
                y2={yFor(tick)}
                stroke="hsl(var(--border))"
                strokeWidth="1"
                strokeDasharray="2 4"
                opacity="0.7"
              />
              <text
                x={PLOT_LEFT - 8}
                y={yFor(tick) + 4}
                textAnchor="end"
                className="text-[10px] tabular-nums text-muted-foreground"
                fill="currentColor"
              >
                {tick}
              </text>
            </g>
          ))}
          {yearTicks.map((tick) => (
            <text
              key={`${tick.year}-${tick.index}`}
              x={xFor(tick.index)}
              y={PLOT_BOTTOM + 22}
              textAnchor="middle"
              data-year-tick={tick.year}
              className="text-[10px] text-muted-foreground"
              fill="currentColor"
            >
              {tick.year}
            </text>
          ))}
          {singlePoint ? (
            /*
             * ONE MONTH IS NOT AN EMPTY CHART. A single point makes a
             * zero-width area and a one-vertex polyline, both of which draw
             * literally nothing — so a member with one dated month rendered a
             * blank plot, while the empty-state dash was suppressed because
             * `values.length` was truthy. A dot at the value with a reference
             * line across the plot says "one month, this many" instead.
             */
            <>
              <line
                data-single-point-level
                x1={PLOT_LEFT}
                y1={singleY}
                x2={WIDTH - PLOT_RIGHT}
                y2={singleY}
                stroke={AMBER_STEPS[2] ?? AMBER_STEPS[0]}
                strokeWidth="1.5"
              />
              <circle
                data-single-point
                cx={xFor(0)}
                cy={singleY}
                r="4"
                fill={AMBER_STEPS[4] ?? AMBER_STEPS[0]}
              />
              <text
                x={xFor(0)}
                y={singleLabelY}
                textAnchor="middle"
                className="text-[10px] tabular-nums text-muted-foreground"
                fill="currentColor"
              >
                {singlePoint.count}
              </text>
            </>
          ) : values.length ? (
            <>
              <path
                d={areaPath}
                fill={AMBER_STEPS[2] ?? AMBER_STEPS[0]}
                fillOpacity="0.2"
                stroke="none"
              />
              <polyline
                points={linePath}
                fill="none"
                stroke={AMBER_STEPS[4] ?? AMBER_STEPS[0]}
                strokeWidth="2"
                strokeLinejoin="round"
                strokeLinecap="round"
              />
            </>
          ) : (
            <line
              x1={PLOT_LEFT}
              y1={PLOT_BOTTOM / 2}
              x2={WIDTH - PLOT_RIGHT}
              y2={PLOT_BOTTOM / 2}
              stroke="hsl(var(--muted-foreground))"
              strokeWidth="1.5"
              strokeDasharray="3 3"
            />
          )}
        </svg>
      </div>
      <table className="sr-only" aria-label="Monthly declaration count table">
        <caption>Monthly declaration counts</caption>
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
      {footnote ? (
        <p className="text-[11px] text-muted-foreground">{footnote}</p>
      ) : null}
    </figure>
  );
}
