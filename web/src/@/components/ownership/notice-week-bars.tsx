import { NOT_AVAILABLE } from "~/@/lib/fundamentals/format";
import { ScreenReaderTable } from "~/@/components/politicians/explorer/screen-reader-table";

// Server-safe and client-safe: no "use client", no Connect import.
//
// The notice feed's weekly strip. One series, so one colour: the primary amber,
// which is ink on paper and light from the screen in its own room. Each bar is
// the notices released in a week, every event counted, and a week with none
// draws no ink at all, so a quiet week is not drawn as a busy one. The bars are
// presentational; the sr-only table carries the figures, week by week.
//
// Dates print as the API sends them (YYYY-MM-DD), each in a <time>. A label
// that reads "3 Nov" would drop the year across a New Year's window.

export interface NoticeWeekBar {
  /** YYYY-MM-DD, the Monday the week starts on. */
  weekStart: string;
  /** The notices released in the week, every event counted. */
  count: number;
}

export interface NoticeWeekBarsProps {
  weeks: readonly NoticeWeekBar[];
  /** How the window is worded, e.g. "the last 30 days". The caller holds the window the response reported. */
  windowLabel: string;
  /** What the counts are narrowed to, e.g. "under the filters set above". Optional, and said in both the label and the table. */
  scopeNote?: string;
}

const SLOT = 14;
const BAR = 8;
const VIEW_HEIGHT = 64;
const PLOT_TOP = 6;
const BASELINE = 58;
/** Below `sm` only the newest weeks are drawn, so each bar stays wide enough to read. */
const PHONE_WEEKS = 26;
const FILL = "hsl(var(--primary))";

function safeCount(count: number): number {
  return Number.isFinite(count) ? Math.max(0, Math.trunc(count)) : 0;
}

function bars(weeks: readonly { weekStart: string; count: number }[], max: number) {
  return weeks.map((week, index) => {
    const height = max > 0 && week.count > 0 ? ((BASELINE - PLOT_TOP) * week.count) / max : 0;
    return (
      <g key={week.weekStart} data-week={week.weekStart}>
        {height > 0 ? (
          <rect
            x={index * SLOT + (SLOT - BAR) / 2}
            y={BASELINE - height}
            width={BAR}
            height={height}
            fill={FILL}
          />
        ) : null}
      </g>
    );
  });
}

export function NoticeWeekBars({ weeks, windowLabel, scopeNote = "" }: NoticeWeekBarsProps) {
  const scope = scopeNote.trim();
  /** "the last 30 days, under the filters set above": one phrase, used in every label. */
  const scoped = scope ? `${windowLabel}, ${scope}` : windowLabel;
  const points = weeks.map((week) => ({ weekStart: week.weekStart, count: safeCount(week.count) }));
  const total = points.reduce((sum, week) => sum + week.count, 0);
  const max = points.reduce((highest, week) => Math.max(highest, week.count), 0);
  const phone = points.slice(-PHONE_WEEKS);
  const fullWidth = Math.max(points.length, 1) * SLOT;
  const phoneWidth = Math.max(phone.length, 1) * SLOT;
  const first = points[0]?.weekStart;
  const last = points.at(-1)?.weekStart;
  /** weeks.label (section 7): the image's name and the table's caption. The totals are printed beside the bars. */
  const name = `Notices by week over ${scoped}`;

  return (
    <figure className="space-y-1.5">
      <div role="img" aria-label={name} className="relative">
        <svg
          aria-hidden="true"
          focusable="false"
          viewBox={`0 0 ${phoneWidth} ${VIEW_HEIGHT}`}
          preserveAspectRatio="none"
          className="h-16 w-full sm:hidden"
        >
          {bars(phone, max)}
          <line
            x1={0}
            y1={BASELINE}
            x2={phoneWidth}
            y2={BASELINE}
            stroke="hsl(var(--border))"
            strokeWidth={1}
            vectorEffect="non-scaling-stroke"
          />
        </svg>
        <svg
          aria-hidden="true"
          focusable="false"
          viewBox={`0 0 ${fullWidth} ${VIEW_HEIGHT}`}
          preserveAspectRatio="none"
          className="hidden h-16 w-full sm:block"
        >
          {bars(points, max)}
          <line
            x1={0}
            y1={BASELINE}
            x2={fullWidth}
            y2={BASELINE}
            stroke="hsl(var(--border))"
            strokeWidth={1}
            vectorEffect="non-scaling-stroke"
          />
        </svg>
      </div>

      <figcaption className="flex flex-wrap items-center gap-x-4 gap-y-1 text-[11px] text-muted-foreground">
        <span className="inline-flex items-center gap-1.5">
          <span aria-hidden="true" className="inline-block h-2 w-2 rounded-sm bg-primary" />
          {points.length > 0 ? (
            <>
              <span className="tabular-nums">{total}</span> {total === 1 ? "notice" : "notices"}
            </>
          ) : (
            // No weeks is no count, so the line says n/a, never 0 (DESIGN.md's tabular rule).
            NOT_AVAILABLE
          )}
        </span>
        {first !== undefined && last !== undefined ? (
          <span className="tabular-nums">
            <time dateTime={first}>{first}</time>
            {/* A window of one week has one date: "2026-10-12 to 2026-10-12" would say the same thing twice. */}
            {first !== last ? (
              <>
                {" to "}
                <time dateTime={last}>{last}</time>
              </>
            ) : null}
          </span>
        ) : null}
      </figcaption>

      <ScreenReaderTable ariaLabel={name}>
        <caption>{name}</caption>
        <thead>
          <tr>
            <th scope="col">Week beginning</th>
            <th scope="col">Notices</th>
          </tr>
        </thead>
        <tbody>
          {points.length ? (
            points.map((week) => (
              <tr key={week.weekStart}>
                <th scope="row">
                  <time dateTime={week.weekStart}>{week.weekStart}</time>
                </th>
                <td className="tabular-nums">{week.count}</td>
              </tr>
            ))
          ) : (
            // No weeks is no figure, so the cell says n/a, never 0 (DESIGN.md's tabular rule).
            <tr>
              <th scope="row">No weeks in this window</th>
              <td className="tabular-nums">{NOT_AVAILABLE}</td>
            </tr>
          )}
        </tbody>
      </ScreenReaderTable>
    </figure>
  );
}
