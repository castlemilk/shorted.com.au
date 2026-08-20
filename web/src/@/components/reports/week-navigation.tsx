import Link from "next/link";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { weeklyReportPath } from "~/@/lib/reports/weekly-slug";

interface WeekNavigationProps {
  /** DB form, e.g. "2026-W06" (links emit canonical paths). */
  currentSlug: string;
  /**
   * DB-form slugs of reports KNOWN to be published, newest first (what
   * ListReports returns). When the current slug appears in this list the
   * prev/next targets are its real neighbours — no blind links into weeks
   * that were never generated. When it's absent (an archive week older than
   * the fetched window) or the list is unavailable, we fall back to week
   * arithmetic, which is safe because a missing report hard-404s in
   * generateMetadata rather than rendering an empty shell.
   */
  availableSlugs?: string[];
}

/**
 * How many weekly reports to pull for neighbour resolution / the archive.
 *
 * 100 exactly: ListReports is server-capped at 100 (maxReportListLimit), so a
 * larger number silently returns 100 anyway, and using the same value
 * everywhere keeps the unstable_cache key identical — the report page and the
 * /reports/weekly index share ONE cached fetch instead of warming two.
 */
export const WEEKLY_ARCHIVE_LIMIT = 100;

function parseWeekSlug(slug: string): { year: number; week: number } | null {
  const match = slug.match(/^(\d{4})-W(\d{2})$/);
  if (!match?.[1] || !match[2]) return null;
  return { year: parseInt(match[1], 10), week: parseInt(match[2], 10) };
}

function formatSlug(year: number, week: number): string {
  return `${year}-W${String(week).padStart(2, "0")}`;
}

/**
 * ISO-8601 week count for a year: 53 when 1 January falls on a Thursday, or
 * on a Wednesday in a leap year; 52 otherwise. The previous implementation
 * hardcoded 52, so every "week 1 → previous week" link in a 53-week year
 * (2020, 2026, 2032 …) pointed at a week that does not exist.
 */
export function isoWeeksInYear(year: number): number {
  const jan1Dow = new Date(Date.UTC(year, 0, 1)).getUTCDay();
  const isLeap = (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
  if (jan1Dow === 4 || (isLeap && jan1Dow === 3)) return 53;
  return 52;
}

function getPrevWeek(year: number, week: number): string {
  if (week <= 1) return formatSlug(year - 1, isoWeeksInYear(year - 1));
  return formatSlug(year, week - 1);
}

function getNextWeek(year: number, week: number): string {
  if (week >= isoWeeksInYear(year)) return formatSlug(year + 1, 1);
  return formatSlug(year, week + 1);
}

function formatWeekLabel(slug: string): string {
  const parsed = parseWeekSlug(slug);
  if (!parsed) return slug;
  return `Week ${parsed.week}, ${parsed.year}`;
}

/** Sort key so week comparisons don't depend on string padding luck. */
function weekOrdinal(slug: string): number {
  const parsed = parseWeekSlug(slug);
  return parsed ? parsed.year * 100 + parsed.week : -1;
}

/**
 * Real neighbours from the published list when the current week is in it.
 * Returns null when we can't answer from data (caller falls back to
 * arithmetic).
 */
function neighboursFromList(
  currentSlug: string,
  availableSlugs: string[] | undefined,
): { prev: string | null; next: string | null } | null {
  if (!availableSlugs || availableSlugs.length === 0) return null;
  const ordered = availableSlugs
    .filter((s) => parseWeekSlug(s) !== null)
    .sort((a, b) => weekOrdinal(a) - weekOrdinal(b));
  const idx = ordered.indexOf(currentSlug);
  if (idx < 0) return null;
  return {
    prev: idx > 0 ? ordered[idx - 1]! : null,
    next: idx < ordered.length - 1 ? ordered[idx + 1]! : null,
  };
}

export function WeekNavigation({
  currentSlug,
  availableSlugs,
}: WeekNavigationProps) {
  const parsed = parseWeekSlug(currentSlug);
  if (!parsed) return null;

  const fromList = neighboursFromList(currentSlug, availableSlugs);

  let prevSlug: string | null;
  let nextSlug: string | null;

  if (fromList) {
    prevSlug = fromList.prev;
    nextSlug = fromList.next;
  } else {
    prevSlug = getPrevWeek(parsed.year, parsed.week);
    nextSlug = getNextWeek(parsed.year, parsed.week);

    // Don't offer a week that hasn't happened yet. ISO week of "today",
    // computed the ISO way (Thursday-anchored) rather than the day-of-year
    // approximation this used to run.
    const now = new Date();
    const anchor = new Date(
      Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()),
    );
    anchor.setUTCDate(anchor.getUTCDate() + 4 - (anchor.getUTCDay() || 7));
    const yearStart = new Date(Date.UTC(anchor.getUTCFullYear(), 0, 1));
    const currentOrdinal =
      anchor.getUTCFullYear() * 100 +
      Math.ceil(((anchor.getTime() - yearStart.getTime()) / 86400000 + 1) / 7);
    if (weekOrdinal(nextSlug) > currentOrdinal) nextSlug = null;
  }

  if (!prevSlug && !nextSlug) return null;

  return (
    <nav
      className="flex items-center justify-between gap-4 border-t border-border/40 pt-6"
      aria-label="Weekly report navigation"
    >
      {prevSlug ? (
        <Link
          href={weeklyReportPath(prevSlug)}
          rel="prev"
          prefetch={false}
          className="inline-flex items-center gap-2 text-sm text-muted-foreground transition-colors hover:text-foreground"
        >
          <ChevronLeft className="h-4 w-4 shrink-0" />
          <span>
            <span className="hidden sm:inline">
              The 10 most shorted ASX stocks —{" "}
            </span>
            {formatWeekLabel(prevSlug)}
          </span>
        </Link>
      ) : (
        <span />
      )}
      {nextSlug && (
        <Link
          href={weeklyReportPath(nextSlug)}
          rel="next"
          prefetch={false}
          className="inline-flex items-center gap-2 text-right text-sm text-muted-foreground transition-colors hover:text-foreground"
        >
          <span>
            <span className="hidden sm:inline">
              The 10 most shorted ASX stocks —{" "}
            </span>
            {formatWeekLabel(nextSlug)}
          </span>
          <ChevronRight className="h-4 w-4 shrink-0" />
        </Link>
      )}
    </nav>
  );
}
