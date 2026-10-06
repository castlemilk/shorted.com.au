/**
 * The 30-day move in a stock's short position, as a clause for a meta
 * description: ", up 0.64 points in 30 days".
 *
 * docs/seo-audit-2026-09.md §6.2: the per-ticker pages rank at positions 3
 * to 7 and convert 1 to 4% of impressions, and the description led with the
 * level alone ("short interest is 15.07% as of 30 Sept 2026"), the one
 * number the title already carries. The change is the fact a searcher cannot
 * get from the snippet of any competitor, so it goes first, before the
 * industry and the feature list. Measured page by page in Search Console.
 *
 * Pure and dependency-free so it is unit-testable and safe wherever the
 * metadata runs. The series is the daily ASIC record, oldest first, as
 * getDailyShortSeries returns it; the window is 30 calendar days back from
 * the latest report, taking the last report on or before that date, which is
 * exactly how the page's own history summary computes its 30-day figure.
 */
export interface DatedPct {
  /** YYYY-MM-DD report date. */
  date: string;
  pct: number;
}

const DAY_MS = 24 * 60 * 60 * 1000;
/** Below this the move is noise, and "unchanged" is the honest word. */
const FLAT_POINTS = 0.05;

/** The change over 30 days in percentage points, null when the record is too short. */
export function thirtyDayChange(points: readonly DatedPct[]): number | null {
  if (points.length < 2) return null;
  const latest = points[points.length - 1]!;
  const latestMs = Date.parse(`${latest.date}T00:00:00Z`);
  if (!Number.isFinite(latestMs)) return null;
  const target = latestMs - 30 * DAY_MS;
  for (let i = points.length - 2; i >= 0; i--) {
    const point = points[i]!;
    const ms = Date.parse(`${point.date}T00:00:00Z`);
    if (Number.isFinite(ms) && ms <= target) return latest.pct - point.pct;
  }
  return null;
}

/**
 * ", up 0.64 points in 30 days" / ", down 1.20 points in 30 days" /
 * ", unchanged over 30 days"; "" when the record cannot say.
 */
export function thirtyDayChangeClause(points: readonly DatedPct[]): string {
  const change = thirtyDayChange(points);
  if (change === null || !Number.isFinite(change)) return "";
  if (Math.abs(change) < FLAT_POINTS) return ", unchanged over 30 days";
  const word = change > 0 ? "up" : "down";
  return `, ${word} ${Math.abs(change).toFixed(2)} points in 30 days`;
}
