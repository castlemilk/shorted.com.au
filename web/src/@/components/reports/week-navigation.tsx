import Link from "next/link";
import { ChevronLeft, ChevronRight } from "lucide-react";

interface WeekNavigationProps {
  currentSlug: string; // e.g., "2026-W06"
}

function parseWeekSlug(slug: string): { year: number; week: number } | null {
  const match = slug.match(/^(\d{4})-W(\d{2})$/);
  if (!match?.[1] || !match[2]) return null;
  return { year: parseInt(match[1]), week: parseInt(match[2]) };
}

function formatSlug(year: number, week: number): string {
  return `${year}-W${String(week).padStart(2, "0")}`;
}

function getPrevWeek(year: number, week: number): string {
  if (week <= 1) {
    return formatSlug(year - 1, 52);
  }
  return formatSlug(year, week - 1);
}

function getNextWeek(year: number, week: number): string {
  if (week >= 52) {
    return formatSlug(year + 1, 1);
  }
  return formatSlug(year, week + 1);
}

function formatWeekLabel(slug: string): string {
  const parsed = parseWeekSlug(slug);
  if (!parsed) return slug;
  return `Week ${parsed.week}, ${parsed.year}`;
}

export function WeekNavigation({ currentSlug }: WeekNavigationProps) {
  const parsed = parseWeekSlug(currentSlug);
  if (!parsed) return null;

  const prevSlug = getPrevWeek(parsed.year, parsed.week);
  const nextSlug = getNextWeek(parsed.year, parsed.week);

  // Don't show next if it's in the future
  const now = new Date();
  const currentISOYear = now.getFullYear();
  const currentWeek = Math.ceil(
    ((now.getTime() - new Date(currentISOYear, 0, 1).getTime()) / 86400000 +
      new Date(currentISOYear, 0, 1).getDay() +
      1) /
      7,
  );
  const nextParsed = parseWeekSlug(nextSlug);
  const isFuture =
    nextParsed &&
    (nextParsed.year > currentISOYear ||
      (nextParsed.year === currentISOYear && nextParsed.week > currentWeek));

  return (
    <nav
      className="flex items-center justify-between border-t border-border/40 pt-6"
      aria-label="Week navigation"
    >
      <Link
        href={`/reports/weekly/${prevSlug}`}
        prefetch={false}
        className="inline-flex items-center gap-2 text-sm text-muted-foreground hover:text-foreground transition-colors"
      >
        <ChevronLeft className="h-4 w-4" />
        <span>{formatWeekLabel(prevSlug)}</span>
      </Link>
      {!isFuture && (
        <Link
          href={`/reports/weekly/${nextSlug}`}
          prefetch={false}
          className="inline-flex items-center gap-2 text-sm text-muted-foreground hover:text-foreground transition-colors"
        >
          <span>{formatWeekLabel(nextSlug)}</span>
          <ChevronRight className="h-4 w-4" />
        </Link>
      )}
    </nav>
  );
}
