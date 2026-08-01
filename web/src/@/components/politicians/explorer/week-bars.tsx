/**
 * Weekly register events as paired bars — the activity explorer's strip.
 *
 * WHY A NEW KIT PIECE. `spark-trend` plots ONE monthly series as a line, and
 * `trend-area` plots one monthly area; this strip has to show TWO counts per
 * bucket (added, removed) at weekly resolution and keep them distinguishable
 * without a chart library, without green/red, and without implying that either
 * count is the good one.
 *
 * EDITORIAL, and these are the constraints that shaped it:
 *
 *   - TWO AMBER STEPS, NOT TWO HUES. The house rule is one sequential amber
 *     ramp plus party colours, and "there is no bad end here" — a green bar
 *     beside a red one would give a register event a polarity it does not have.
 *     Added and removed are told apart by lightness (two steps of the same
 *     ramp), by their legend, and by the sr-only table, which is the one that
 *     actually has to carry the meaning.
 *   - A REMOVAL IS NOT A TRANSACTION. Nothing here is captioned as a disposal
 *     or a sale, and the component takes no "net" or "change" measure it could
 *     be read as: it renders the two counts the register states and stops.
 *   - EVERY WEEK IN THE WINDOW IS A BAR, including the empty ones. Dropping
 *     empty weeks compresses the axis and makes a quiet fortnight look like a
 *     busy one; the caller passes what the backend returned and a zero week
 *     renders as an empty slot with no ink (the same reason ZERO_FILL exists
 *     for the heatmap).
 *
 * Props-only and client-safe, like the rest of this directory: no protobuf, no
 * chart library, `role="img"` with a full aria-label and a table fallback.
 */

import { AMBER_STEPS } from "@/lib/politics/analytics-palette";

export interface WeekBarsPoint {
  /** `YYYY-MM-DD`, the Monday the week starts on. */
  weekStart: string;
  addedCount: number;
  removedCount: number;
}

export interface WeekBarsProps {
  weeks: WeekBarsPoint[];
  /**
   * How the window is worded in the labels, e.g. "the last 90 days". The
   * component never computes it: the window it is describing is the one the
   * RESPONSE reported, which the caller holds and this component does not.
   */
  windowLabel: string;
  /**
   * What the buckets are narrowed to, e.g. "under the filters set above" or
   * "across all members".
   *
   * THE SAME SCOPE THE VISIBLE CAPTION CARRIES. These bars are drawn above a
   * filtered feed, so a screen-reader user who hears only "Register events by
   * week over the last 90 days" is told the parliament's counts where a sighted
   * reader is told the filter's — the exact misattribution the caption exists to
   * prevent. Optional so an unscoped caller still renders truthfully; supplied by
   * the explorer, which knows the filter and this component does not.
   */
  scopeNote?: string;
}

/** The lighter step reads as the first of the pair; both are the house amber. */
const ADDED_FILL = AMBER_STEPS[1];
const REMOVED_FILL = AMBER_STEPS[4];

const VIEW_HEIGHT = 64;
const PLOT_TOP = 6;
const PLOT_BOTTOM = 52;
const BASELINE_Y = PLOT_BOTTOM;
const SLOT_WIDTH = 14;
const BAR_WIDTH = 5;
const BAR_GAP = 1.5;

function safeCount(count: number): number {
  return Number.isFinite(count) ? Math.max(0, Math.trunc(count)) : 0;
}

/** `2026-06-29` -> `29 Jun`. Falls back to the raw label rather than guessing. */
export function weekLabel(weekStart: string): string {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(weekStart)) return weekStart;
  const date = new Date(`${weekStart}T00:00:00Z`);
  if (Number.isNaN(date.getTime())) return weekStart;
  return date.toLocaleDateString("en-AU", { day: "numeric", month: "short", timeZone: "UTC" });
}

export function WeekBars({ weeks, windowLabel, scopeNote = "" }: WeekBarsProps) {
  const scope = scopeNote.trim();
  /** "the last 90 days, across all members" — one phrase, used in both labels. */
  const scopedWindow = scope ? `${windowLabel}, ${scope}` : windowLabel;
  const points = weeks.map((week) => ({
    weekStart: week.weekStart,
    addedCount: safeCount(week.addedCount),
    removedCount: safeCount(week.removedCount),
  }));

  const totalAdded = points.reduce((sum, week) => sum + week.addedCount, 0);
  const totalRemoved = points.reduce((sum, week) => sum + week.removedCount, 0);
  const max = points.reduce(
    (highest, week) => Math.max(highest, week.addedCount, week.removedCount),
    0,
  );

  const width = Math.max(points.length * SLOT_WIDTH, SLOT_WIDTH);

  // A zero-height bar is drawn as nothing at all, not as a hairline: a week with
  // no events must not read as a week with one.
  const barHeight = (count: number) =>
    max <= 0 || count <= 0 ? 0 : ((PLOT_BOTTOM - PLOT_TOP) * count) / max;

  const ariaLabel = points.length
    ? `Register events by week over ${scopedWindow}: ${totalAdded} entries added and ${totalRemoved} entries removed across ${points.length} ${points.length === 1 ? "week" : "weeks"}. Dated events only.`
    : `Register events by week over ${scopedWindow}: no dated events.`;

  return (
    <figure className="space-y-1.5">
      <svg
        viewBox={`0 0 ${width} ${VIEW_HEIGHT}`}
        preserveAspectRatio="none"
        role="img"
        aria-label={ariaLabel}
        data-state={points.length === 0 ? "empty" : "weeks"}
        className="h-16 w-full"
      >
        {points.map((week, index) => {
          const slotX = index * SLOT_WIDTH;
          const addedHeight = barHeight(week.addedCount);
          const removedHeight = barHeight(week.removedCount);
          const addedX = slotX + (SLOT_WIDTH - (BAR_WIDTH * 2 + BAR_GAP)) / 2;
          return (
            <g key={week.weekStart} data-week={week.weekStart}>
              {addedHeight > 0 ? (
                <rect
                  x={addedX}
                  y={BASELINE_Y - addedHeight}
                  width={BAR_WIDTH}
                  height={addedHeight}
                  fill={ADDED_FILL}
                />
              ) : null}
              {removedHeight > 0 ? (
                <rect
                  x={addedX + BAR_WIDTH + BAR_GAP}
                  y={BASELINE_Y - removedHeight}
                  width={BAR_WIDTH}
                  height={removedHeight}
                  fill={REMOVED_FILL}
                />
              ) : null}
            </g>
          );
        })}
        <line
          x1={0}
          y1={BASELINE_Y}
          x2={width}
          y2={BASELINE_Y}
          stroke="hsl(var(--border))"
          strokeWidth="1"
        />
      </svg>

      <figcaption className="flex flex-wrap items-center gap-x-4 gap-y-1 text-[11px] text-muted-foreground">
        <span className="inline-flex items-center gap-1.5">
          <span
            aria-hidden
            className="inline-block h-2 w-2 rounded-sm"
            style={{ backgroundColor: ADDED_FILL }}
          />
          <span className="tabular-nums">{totalAdded}</span> added
        </span>
        <span className="inline-flex items-center gap-1.5">
          <span
            aria-hidden
            className="inline-block h-2 w-2 rounded-sm"
            style={{ backgroundColor: REMOVED_FILL }}
          />
          <span className="tabular-nums">{totalRemoved}</span> removed
        </span>
        {points.length ? (
          <span>
            {weekLabel(points[0]?.weekStart ?? "")} &ndash;{" "}
            {weekLabel(points[points.length - 1]?.weekStart ?? "")}
          </span>
        ) : null}
      </figcaption>

      {/* The table's own name carries the scope too: an aria-label OVERRIDES the
          caption, so a scoped caption under an unscoped label is heard as
          unscoped. */}
      <table className="sr-only" aria-label={`Register events by week over ${scopedWindow}`}>
        <caption>
          Register events by week over {scopedWindow}, dated events only
        </caption>
        <thead>
          <tr>
            <th scope="col">Week beginning</th>
            <th scope="col">Entries added</th>
            <th scope="col">Entries removed</th>
          </tr>
        </thead>
        <tbody>
          {points.length ? (
            points.map((week) => (
              <tr key={week.weekStart}>
                <th scope="row">{week.weekStart}</th>
                <td className="tabular-nums">{week.addedCount}</td>
                <td className="tabular-nums">{week.removedCount}</td>
              </tr>
            ))
          ) : (
            <tr>
              <th scope="row">No dated events in this window</th>
              <td className="tabular-nums">0</td>
              <td className="tabular-nums">0</td>
            </tr>
          )}
        </tbody>
      </table>
    </figure>
  );
}
