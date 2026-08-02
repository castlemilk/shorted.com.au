import { AMBER_STEPS } from "@/lib/politics/analytics-palette";
import { ScreenReaderTable } from "@/components/politicians/explorer/screen-reader-table";

export interface SparkTrendPoint {
  month: string;
  count: number;
}

export interface SparkTrendProps {
  points: SparkTrendPoint[];
  /**
   * The member has declarations, but none of them carry a date we can plot.
   *
   * Only meaningful with no points: it is what lets the caller say "no dated
   * history" instead of the reader inferring "nothing declared" from an empty
   * cell. Rule: withhold rather than guess — this marker withholds out loud.
   */
  undatedOnly?: boolean;
}

const PLOT_LEFT = 8;
const PLOT_RIGHT = 152;
const PLOT_TOP = 8;
const PLOT_BOTTOM = 32;
const MID_Y = (PLOT_TOP + PLOT_BOTTOM) / 2;

function safeCount(count: number): number {
  return Number.isFinite(count) ? Math.max(0, Math.trunc(count)) : 0;
}

export function SparkTrend({ points, undatedOnly = false }: SparkTrendProps) {
  const values = points.map((point) => ({
    ...point,
    count: safeCount(point.count),
  }));
  const counts = values.map((point) => point.count);
  const first = counts[0];
  const isEmpty = values.length === 0;
  const isFlat = !isEmpty && counts.every((count) => count === first);

  /*
   * A FLAT SERIES IS DATA. It used to render the same muted dash as an empty
   * one — byte-for-byte identical markup — so a member steady at 12 a month and
   * a member with no dated history were indistinguishable in the hub table. The
   * dash now means one thing only: there is nothing to plot.
   *
   * A flat line sits at MID height rather than at its scaled level: with a
   * zero baseline every flat series would otherwise pin to the top of the band
   * and read as "at maximum", which is a claim about a level the row's own
   * scale cannot support. Mid reads as "steady", and the number itself is in
   * the aria-label, the table, and the count column beside it.
   */
  const max = Math.max(...counts, 0);
  const min = Math.min(...counts, 0);
  const range = max - min || 1;
  const polyline = isFlat
    ? `${PLOT_LEFT},${MID_Y} ${PLOT_RIGHT},${MID_Y}`
    : values
        .map((point, index) => {
          const x =
            PLOT_LEFT +
            (index / Math.max(values.length - 1, 1)) * (PLOT_RIGHT - PLOT_LEFT);
          const y =
            PLOT_BOTTOM - ((point.count - min) / range) * (PLOT_BOTTOM - PLOT_TOP);
          return `${x.toFixed(2)},${y.toFixed(2)}`;
        })
        .join(" ");

  const dataState = isEmpty
    ? undatedOnly
      ? "undated"
      : "empty"
    : isFlat
      ? "flat"
      : "trend";
  const ariaLabel = isEmpty
    ? undatedOnly
      ? "Monthly count trend: no dated history is available for these entries."
      : "Monthly count trend: no dated counts."
    : isFlat && values.length > 1
      ? `Monthly count trend: steady at ${first ?? 0} across ${values.length} months.`
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
        {isEmpty ? (
          <line
            x1={PLOT_LEFT}
            y1={MID_Y}
            x2={PLOT_RIGHT}
            y2={MID_Y}
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
      <ScreenReaderTable ariaLabel="Monthly count trend table">
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
              <th scope="row">
                {undatedOnly ? "No dated history" : "No dated entries"}
              </th>
              <td className="tabular-nums">0</td>
            </tr>
          )}
        </tbody>
      </ScreenReaderTable>
    </figure>
  );
}
