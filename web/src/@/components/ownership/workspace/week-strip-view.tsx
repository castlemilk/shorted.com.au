import Link from "next/link";
import { countScale, lensFill } from "~/@/components/ownership/desk/desk-scales";
import { weekDateLabel } from "~/@/components/ownership/desk/movement-heatmap-static";
import type { WeekBar } from "./inspector-types";
import { weekTitle } from "./week-strip";

/*
 * The notices-by-week strip (backlog C6): one bar per week, its height the count over the largest
 * week, its fill the heatmap's count bin. A PLAIN MODULE: no "use client", no hooks, no Connect, so
 * the server and the island draw the same markup. The bars are drawn in a fixed box (260 by 40), so
 * the strip's height never depends on its counts.
 */

/** Bar width and the step from one bar to the next (the width and a 2 unit gap). */
const BAR_WIDTH = 8;
const BAR_STEP = 10;
/** The plot's height in the box's units; a week with the largest count fills it. */
const PLOT_HEIGHT = 40;
const VIEW_WIDTH = 260;

export interface WeekStripProps {
  weeks: readonly WeekBar[];
  /** The strip's name for a reader, the section's title, e.g. "Notices by week". */
  label: string;
}

/**
 * The strip. Each bar is a link to the feed for its week; the bars take the keyboard out of the tab
 * order, because the list under the strip carries the same links for a keyboard or a screen reader.
 * A quiet week is a 1 unit hairline in the paper, so an empty week is still a slot on the strip.
 */
export function WeekStrip({ weeks, label }: WeekStripProps) {
  if (weeks.length === 0) return null;
  const largest = Math.max(0, ...weeks.map((week) => week.count));
  // The count bins are the heatmap's, scaled to this strip's largest week.
  const scale = countScale(largest);
  const first = weeks[0];
  const last = weeks[weeks.length - 1];
  return (
    <div role="group" aria-label={label}>
      <svg
        aria-hidden="true"
        viewBox={`0 0 ${VIEW_WIDTH} ${PLOT_HEIGHT}`}
        className="h-auto w-full overflow-visible text-muted-foreground"
      >
        {weeks.map((week, index) => {
          const quiet = week.count === 0;
          const height = quiet || largest <= 0 ? 1 : Math.max(1, (week.count / largest) * PLOT_HEIGHT);
          return (
            <Link
              key={week.weekStart}
              href={week.href}
              prefetch={false}
              rel="nofollow"
              tabIndex={-1}
            >
              <title>{weekTitle(week)}</title>
              <rect
                x={index * BAR_STEP}
                y={PLOT_HEIGHT - height}
                width={BAR_WIDTH}
                height={height}
                fill={lensFill(week.count, scale) ?? "none"}
                stroke={quiet ? "currentColor" : undefined}
                strokeWidth={quiet ? 0.5 : undefined}
              />
            </Link>
          );
        })}
      </svg>
      {first && last ? (
        <div className="mt-1 flex justify-between font-mono text-[10px] tabular-nums text-muted-foreground">
          <span>{weekDateLabel(first.weekStart)}</span>
          <span>{weekDateLabel(last.weekStart)}</span>
        </div>
      ) : null}
      {/* Each link is hidden until it takes the focus, so a keyboard user sees the one they are on, in the rail's own type. */}
      <ol className="m-0 list-none p-0">
        {weeks.map((week) => (
          <li key={week.weekStart}>
            <Link href={week.href} prefetch={false} rel="nofollow" className="sr-only font-mono text-xs focus:not-sr-only">
              {weekTitle(week)}
            </Link>
          </li>
        ))}
      </ol>
    </div>
  );
}
