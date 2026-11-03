// Server-safe and client-safe: no "use client", no Connect import, a type import
// of the loader's row. Drawn from the rows the series loader returns.
//
// One stock's weight in each tracked fund over the snapshot dates (spec 13.5):
// small multiples, one panel per fund, each a line with a dot at every file date
// it has. The panels share one scale, so a larger weight reads as larger across
// the grid, and the axis is the snapshot dates, shared by every panel. A date a
// fund has no weight for, or has no file for, is a gap in its line, never a point
// at zero: the line breaks there and joins only consecutive snapshot dates.

import type { FundSeriesRow } from "~/app/actions/ownershipDesk";
import { ScreenReaderTable } from "~/@/components/politicians/explorer/screen-reader-table";
import { formatPct, NOT_AVAILABLE } from "~/@/lib/fundamentals/format";
import { asAtRange, formatFundWeight } from "~/@/lib/ownership/kinds";

/** The drawing's units. The SVG scales to its panel; the text beside it is HTML. */
export const SERIES_WIDTH = 240;
export const SERIES_HEIGHT = 64;
const PAD = 6;

export interface SeriesPoint {
  /** The snapshot date this point is for, YYYY-MM-DD. */
  asAt: string;
  weightPct: number | null;
  valueAud: number | null;
  /** The point's place on the shared axis, by snapshot index. */
  x: number;
  /** The drawn height, or null where the fund states no weight. */
  y: number | null;
}

export interface SeriesPanel {
  institutionName: string;
  fundName: string;
  /** The first and last file dates this fund has for the stock. */
  first: string;
  last: string;
  points: SeriesPoint[];
  /** The line as SVG path data: a move at the start of each run of weights. */
  path: string;
}

export interface SeriesLayout {
  /** Every snapshot date any fund has for the stock, oldest first. */
  dates: string[];
  /** The largest weight on the shared scale; 0 when no fund states one. */
  max: number;
  panels: SeriesPanel[];
}

/**
 * The shared layout of the small multiples. The x axis is the snapshot index, so
 * the snapshot dates are evenly spaced whatever the gap between them, and every
 * panel reads the same column for the same date.
 */
export function seriesLayout(funds: readonly FundSeriesRow[]): SeriesLayout {
  const dates = [...new Set(funds.flatMap((fund) => fund.points.map((p) => p.asAt)))].sort();
  const index = new Map(dates.map((date, i) => [date, i] as const));
  const weights = funds.flatMap((fund) =>
    fund.points.map((p) => p.weightPct).filter((w): w is number => w !== null && Number.isFinite(w)),
  );
  const max = weights.reduce((top, w) => Math.max(top, w), 0);
  const scale = max > 0 ? max : 1;
  const xOf = (i: number) => (dates.length > 1 ? PAD + (i / (dates.length - 1)) * (SERIES_WIDTH - 2 * PAD) : SERIES_WIDTH / 2);
  const yOf = (w: number) => SERIES_HEIGHT - PAD - (w / scale) * (SERIES_HEIGHT - 2 * PAD);

  const panels = funds.map((fund) => {
    const ordered = [...fund.points].sort((a, b) => (a.asAt < b.asAt ? -1 : a.asAt > b.asAt ? 1 : 0));
    const points: SeriesPoint[] = ordered.map((p) => {
      const weight = p.weightPct !== null && Number.isFinite(p.weightPct) ? p.weightPct : null;
      return {
        asAt: p.asAt,
        weightPct: weight,
        valueAud: p.valueAud,
        x: xOf(index.get(p.asAt) ?? 0),
        y: weight === null ? null : yOf(weight),
      };
    });
    let path = "";
    // The snapshot index of the point drawn last, or null when the line is broken.
    let previous: number | null = null;
    for (const point of points) {
      if (point.y === null) {
        previous = null;
        continue;
      }
      const at = index.get(point.asAt) ?? 0;
      path += `${previous !== null && previous === at - 1 ? "L" : "M"}${point.x.toFixed(1)} ${point.y.toFixed(1)} `;
      previous = at;
    }
    return {
      institutionName: fund.institutionName,
      fundName: fund.fundName,
      first: ordered[0]?.asAt ?? "",
      last: ordered.at(-1)?.asAt ?? "",
      points,
      path: path.trim(),
    };
  });
  return { dates, max, panels };
}

export interface FundSeriesProps {
  funds: readonly FundSeriesRow[];
}

export function FundSeries({ funds }: FundSeriesProps) {
  const layout = seriesLayout(funds);
  if (layout.panels.length === 0) return null;
  const first = layout.dates[0] ?? "";
  const last = layout.dates.at(-1) ?? "";
  // With no weight stated the shared scale has no top to name, so the caption names only the file dates.
  const scale = layout.max > 0 ? `Weight in each fund, one scale for all: 0% to ${formatPct(layout.max, { digits: 2 })}.` : "Weight in each fund.";

  return (
    <figure className="space-y-3">
      <figcaption className="text-[11px] tabular-nums text-muted-foreground">
        {`${scale} File dates ${first} to ${last}.`}
      </figcaption>
      <ul className="grid gap-4 sm:grid-cols-2">
        {layout.panels.map((panel) => (
          <li key={`${panel.institutionName}|${panel.fundName}`} className="space-y-1">
            <p className="text-sm">
              <span className="text-foreground">{panel.institutionName}</span>{" "}
              <span className="text-muted-foreground">{panel.fundName}</span>
            </p>
            <p className="text-[11px] tabular-nums text-muted-foreground">{asAtRange(panel.first, panel.last)}</p>
            <svg
              aria-hidden="true"
              viewBox={`0 0 ${SERIES_WIDTH} ${SERIES_HEIGHT}`}
              className="h-16 w-full overflow-visible"
            >
              <line
                x1={PAD}
                x2={SERIES_WIDTH - PAD}
                y1={SERIES_HEIGHT - PAD}
                y2={SERIES_HEIGHT - PAD}
                className="stroke-border"
                strokeWidth={1}
              />
              {panel.path ? (
                <path d={panel.path} fill="none" className="stroke-primary" strokeWidth={1.5} />
              ) : null}
              {panel.points.map((point) =>
                point.y === null ? null : (
                  <circle
                    key={point.asAt}
                    cx={point.x}
                    cy={point.y}
                    r={2.5}
                    data-date={point.asAt}
                    className="fill-primary"
                  />
                ),
              )}
            </svg>
          </li>
        ))}
      </ul>
      <ScreenReaderTable ariaLabel="Weight in each tracked fund, by file date">
        <caption>Weight in each tracked fund, by file date. n/a is a file date the fund has no weight for.</caption>
        <thead>
          <tr>
            <th scope="col">Fund</th>
            {layout.dates.map((date) => (
              <th key={date} scope="col">
                {date}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {layout.panels.map((panel) => (
            <tr key={`${panel.institutionName}|${panel.fundName}`}>
              <th scope="row">{`${panel.institutionName}, ${panel.fundName}`}</th>
              {layout.dates.map((date) => {
                const point = panel.points.find((p) => p.asAt === date);
                return (
                  <td key={date} className="tabular-nums">
                    {point ? formatFundWeight(point.weightPct, point.weightPct !== null, point.valueAud) : NOT_AVAILABLE}
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </ScreenReaderTable>
    </figure>
  );
}
