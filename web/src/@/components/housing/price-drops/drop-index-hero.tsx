"use client";

import { fmtDropsDate } from "@/lib/housing/drops-freshness";
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
  /** Set when medianDropPct is withheld (fewer than 3 dropped addresses). */
  medianWithheld?: boolean;
}

export interface DropIndexHeroProps {
  points: DropIndexPointView[];
  trackingSince: string;
  /**
   * ISO instant the series' crawl data runs to (GetDropIndexSeries'
   * data_through). An ISO string, not the Timestamp message, so the prop stays
   * serializable across the RSC boundary.
   */
  dataThroughIso?: string;
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
  // Snapshot dates are plain calendar dates. UTC midnight falls on the same
  // calendar day in Sydney, so the shared formatter never shifts them.
  const d = new Date(`${isoDate}T00:00:00Z`);
  if (Number.isNaN(d.getTime())) return isoDate;
  return fmtDropsDate(d, { withYear: false });
}

function fmtPercent(fraction: number): string {
  return `${(fraction * 100).toFixed(1)}%`;
}

/**
 * A change between two rates is a difference of percentages: percentage
 * POINTS, never "%". 3.9% -> 6.4% is "up 2.5 percentage points", not "up 2.5%"
 * (which would be a 64% rise).
 */
function fmtPoints(fraction: number): string {
  return `${(Math.abs(fraction) * 100).toFixed(1)} percentage points`;
}

export interface DropIndexReading {
  /** The latest publishable (non-gap) point. */
  latest: DropIndexPointView;
  /** "Reading for 22 Sep" or "Last reliable reading 26 Aug". */
  label: string;
  /**
   * Set when newer snapshots exist but every one of them is a gap: the date
   * of the first gap day after the reading. The reading is then older than the
   * series and must say so.
   */
  gapsSince?: string;
  /**
   * Set when the crawl data behind the reading ends on an earlier day than
   * the reading's own snapshot date: the day it ends.
   */
  dataTo?: string;
}

/**
 * Dates the reading both the hero and the capitulation board show. Gap days
 * are dropped before plotting, so when the crawl's coverage falls below the
 * index's threshold the "latest" reading silently becomes an old one — on
 * 2026-09-23 the page showed 26 Aug's figures, undated, a month after every
 * later day had been a gap. Returns undefined when nothing is publishable.
 */
export function describeReading(
  points: DropIndexPointView[],
  dataThroughIso?: string,
): DropIndexReading | undefined {
  const usable = points.filter((p) => !p.isGap);
  const latest = usable[usable.length - 1];
  if (!latest) return undefined;
  const dataTo = crawlEndsBefore(latest.snapshotDate, dataThroughIso);
  const newest = points[points.length - 1]!;
  if (newest.snapshotDate === latest.snapshotDate) {
    return { latest, label: `Reading for ${fmtDate(latest.snapshotDate)}`, dataTo };
  }
  const firstGap = points.find((p) => p.snapshotDate > latest.snapshotDate);
  return {
    latest,
    label: `Last reliable reading ${fmtDate(latest.snapshotDate)}`,
    gapsSince: firstGap ? fmtDate(firstGap.snapshotDate) : undefined,
    dataTo,
  };
}

/**
 * The collector writes a snapshot every day whether or not the crawl ran, and
 * the 14-day sweep window keeps coverage above the gap threshold for up to ~13
 * days after the crawl stops — so "Reading for 23 Sep" can sit over data that
 * ended on 15 Sep (measured on prod 2026-09-24, VIC). Returns the day the data
 * ends when that is before the snapshot date. Both are compared as UTC
 * calendar days: snapshot dates are UTC dates (the collector's `from` is
 * yesterday in UTC).
 */
function crawlEndsBefore(snapshotDate: string, dataThroughIso?: string): string | undefined {
  if (!dataThroughIso) return undefined;
  const through = new Date(dataThroughIso);
  if (Number.isNaN(through.getTime())) return undefined;
  const throughDay = through.toISOString().slice(0, 10);
  return throughDay < snapshotDate ? fmtDate(throughDay) : undefined;
}

/** The reading's date line: label, plus why it should be read with care. */
export function readingCaption(reading: DropIndexReading): string {
  const notes: string[] = [];
  if (reading.gapsSince) {
    notes.push(`crawl coverage has been too thin to publish a reading since ${reading.gapsSince}`);
  }
  if (reading.dataTo) {
    notes.push(`the listing data behind it runs only to ${reading.dataTo}`);
  }
  return notes.length > 0 ? `${reading.label} — ${notes.join("; ")}` : reading.label;
}

/**
 * The /price-drops headline: an equal-weighted discounting-rate index over
 * time. Gap days from a crawl outage (isGap: true) are filtered out before
 * plotting rather than drawn as a rate of zero — plotting them would render
 * as a market crash that never happened. Renders null when nothing is left
 * to plot (e.g. an empty or all-gap response).
 */
export function DropIndexHero({
  points,
  trackingSince,
  dataThroughIso,
  format = "percent",
}: DropIndexHeroProps) {
  void format; // reserved for future non-percent grains; documented as a serializable key above

  const plotted = points.filter((p) => !p.isGap);
  const reading = describeReading(points, dataThroughIso);
  if (!reading) return null;

  const { latest } = reading;
  const earliest = plotted[0]!;
  const delta = latest.dropRate - earliest.dropRate;
  const hasEnoughHistoryForDirection = plotted.length >= MIN_POINTS_FOR_DIRECTION;

  let direction: "rising" | "falling" | "flat" = "flat";
  if (delta > TREND_DEAD_BAND) direction = "rising";
  else if (delta < -TREND_DEAD_BAND) direction = "falling";

  const directionLabel = !hasEnoughHistoryForDirection
    ? `Not enough history yet to call a direction — tracking since ${fmtDate(trackingSince || earliest.snapshotDate)}`
    : direction === "rising"
      ? `up ${fmtPoints(delta)} since ${fmtDate(earliest.snapshotDate)}`
      : direction === "falling"
        ? `down ${fmtPoints(delta)} since ${fmtDate(earliest.snapshotDate)}`
        : `flat since ${fmtDate(earliest.snapshotDate)}`;

  return (
    <div className="rounded-xl border border-border bg-card p-6">
      <p className={eyebrow}>Discounting index</p>
      <p
        className={cn(
          "mt-1 text-sm font-medium",
          reading.gapsSince !== undefined || reading.dataTo !== undefined
            ? "text-amber-700 dark:text-amber-400"
            : "text-muted-foreground",
        )}
        data-testid="drop-index-reading-date"
      >
        {readingCaption(reading)}
      </p>
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
      <p className="mt-1 text-xs text-muted-foreground">
        The index averages each suburb&apos;s share of homes cut in the trailing 30 days, so a small
        suburb counts as much as a large one; the &ldquo;share of listings cut&rdquo; tile below pools
        every listing instead, which is why the two figures differ.
      </p>
      <span className="sr-only" data-testid="drop-index-plotted-count">
        {plotted.length}
      </span>
    </div>
  );
}
