"use client";

import { sectionTitle, eyebrow } from "@/lib/typography";
import { cn } from "@/lib/utils";

/**
 * Plain-object mirror of the generated `DropIndexPoint` proto message — kept
 * structural (not imported from the gen module) so this client component's
 * props stay trivially serializable across the RSC boundary.
 */
export interface DropIndexPointView {
  snapshotDate: string;
  dropRate: number;
  medianDropPct: number;
  panelSuburbs: number;
  coverageRatio: number;
  isGap: boolean;
  activeAddresses: number;
  droppedAddresses: number;
  withdrawnThenRelisted: number;
  delistedCount: number;
}

export interface DropIndexHeroProps {
  points: DropIndexPointView[];
  trackingSince: string;
  /**
   * Serializable formatter key — never pass a formatter function as a prop
   * from a server page (functions cannot cross the RSC boundary). The only
   * value today is "percent"; the prop exists so a server page can select a
   * unit without importing this "use client" module's internals.
   */
  format?: "percent";
}

// A small dead-band so day-to-day noise in the equal-weighted rate isn't
// reported as a trend reversal.
const TREND_DEAD_BAND = 0.005; // 0.5 percentage points

// Tracking only started 2026-08-13 (see dropIndexTrackingSince in
// house_prices.go), so early on there are only a handful of trustworthy daily
// points. Five points cannot support a rising/falling/flat claim — that reads
// as manufactured precision off noise. Below this count we still show the
// current level (a real, single-day reading) but withhold any direction
// claim until there is enough history to make one honestly.
const MIN_POINTS_FOR_DIRECTION = 14;

function fmtDate(isoDate: string): string {
  const d = new Date(`${isoDate}T00:00:00Z`);
  if (Number.isNaN(d.getTime())) return isoDate;
  // The snapshot dates are plain UTC calendar dates — format in UTC so an
  // AEST reader never sees the date shifted back a day.
  return d.toLocaleDateString("en-AU", {
    day: "numeric",
    month: "short",
    timeZone: "UTC",
  });
}

function fmtPercent(fraction: number): string {
  return `${(fraction * 100).toFixed(1)}%`;
}

/**
 * The /price-drops headline: an equal-weighted discounting-rate index over
 * time. Gap days from a crawl outage (isGap: true) are filtered out before
 * plotting rather than drawn as a rate of zero — plotting them would render
 * as a market crash that never happened. Renders null when nothing is left
 * to plot (e.g. an empty or all-gap response).
 */
export function DropIndexHero({ points, trackingSince, format = "percent" }: DropIndexHeroProps) {
  void format; // reserved for future non-percent grains; documented as a serializable key above

  const plotted = points.filter((p) => !p.isGap);
  if (plotted.length === 0) return null;

  const latest = plotted[plotted.length - 1]!;
  const earliest = plotted[0]!;
  const delta = latest.dropRate - earliest.dropRate;
  const hasEnoughHistoryForDirection = plotted.length >= MIN_POINTS_FOR_DIRECTION;

  let direction: "rising" | "falling" | "flat" = "flat";
  if (delta > TREND_DEAD_BAND) direction = "rising";
  else if (delta < -TREND_DEAD_BAND) direction = "falling";

  const directionLabel = !hasEnoughHistoryForDirection
    ? `Not enough history yet to call a direction — tracking since ${fmtDate(trackingSince || earliest.snapshotDate)}`
    : direction === "rising"
      ? `up ${fmtPercent(Math.abs(delta))} since ${fmtDate(earliest.snapshotDate)}`
      : direction === "falling"
        ? `down ${fmtPercent(Math.abs(delta))} since ${fmtDate(earliest.snapshotDate)}`
        : `flat since ${fmtDate(earliest.snapshotDate)}`;

  return (
    <div className="rounded-xl border border-border bg-card p-6">
      <p className={eyebrow}>Discounting index</p>
      <div className="mt-2 flex flex-wrap items-baseline gap-3">
        <span className="font-mono text-4xl font-semibold tabular-nums text-foreground">
          {fmtPercent(latest.dropRate)}
        </span>
        <span
          className={cn(
            "text-sm font-medium",
            !hasEnoughHistoryForDirection && "text-muted-foreground",
            hasEnoughHistoryForDirection && direction === "rising" && "text-destructive",
            hasEnoughHistoryForDirection &&
              direction === "falling" &&
              "text-emerald-600 dark:text-emerald-400",
            hasEnoughHistoryForDirection && direction === "flat" && "text-muted-foreground",
          )}
        >
          {directionLabel}
        </span>
      </div>
      <h2 className={cn(sectionTitle, "sr-only")}>Discounting index over time</h2>
      <p className="mt-2 text-sm text-muted-foreground">
        Tracking since {fmtDate(trackingSince || earliest.snapshotDate)} · {latest.panelSuburbs} suburbs ·
        equal-weighted across suburbs
      </p>
      <span className="sr-only" data-testid="drop-index-plotted-count">
        {plotted.length}
      </span>
    </div>
  );
}
