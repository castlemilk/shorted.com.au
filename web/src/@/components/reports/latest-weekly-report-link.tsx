import Link from "next/link";
import { FileText, ChevronRight } from "lucide-react";
import { cn } from "~/@/lib/utils";
import { eyebrow } from "~/@/lib/typography";
import { getReportsList } from "~/app/actions/reports/getReportData";
import { weeklyReportPath } from "~/@/lib/reports/weekly-slug";

/**
 * Server-rendered link to the CURRENT latest published weekly report.
 *
 * The ~200 weekly reports at /reports/weekly/10-most-shorted-asx-stocks-week-N-YYYY
 * are the surface that competes with Market Index's dated weekly series, and
 * they were reachable only from /reports. This is the shared amplifier: one
 * cached fetch, a descriptive dated anchor, and nothing at all when the
 * archive is unavailable.
 *
 * Data: getReportsList("weekly", 1) — a single unstable_cache'd RPC
 * (tag "reports-index", 1h revalidate) that already filters out published
 * rows whose narrative never landed, so we never link a soft-404. It swallows
 * its own errors and returns [], so this never fails a host page's ISR render.
 */

function formatWeekTitle(slug: string): string {
  const match = slug.match(/^(\d{4})-W(\d{2})$/);
  if (!match?.[1] || !match[2]) return slug;
  return `Week ${parseInt(match[2], 10)}, ${match[1]}`;
}

function stripCitationMarkers(text: string): string {
  return text
    .replace(/\[(?:ref|report)-\d+\]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

interface LatestWeeklyReport {
  slug: string;
  href: string;
  weekTitle: string;
  headline: string;
  summary: string;
  /** The descriptive anchor text the SERP-facing internal link should use. */
  anchor: string;
}

/** Latest published weekly report, or null when unavailable. */
export async function getLatestWeeklyReport(): Promise<LatestWeeklyReport | null> {
  const reports = await getReportsList("weekly", 1);
  const report = reports[0];
  if (!report?.slug) return null;
  const weekTitle = formatWeekTitle(report.slug);
  return {
    slug: report.slug,
    href: weeklyReportPath(report.slug),
    weekTitle,
    headline: report.headline,
    summary: stripCitationMarkers(report.summary ?? ""),
    anchor: `The 10 most shorted ASX stocks — ${weekTitle}`,
  };
}

interface LatestWeeklyReportLinkProps {
  /**
   * "strip"   — a bordered one-line callout (page-level, e.g. /top)
   * "inline"  — a compact single sentence (in-flow, e.g. a stock page)
   */
  variant?: "strip" | "inline";
  /** Leading label. Defaults per variant. */
  label?: string;
  className?: string;
}

export async function LatestWeeklyReportLink({
  variant = "strip",
  label,
  className,
}: LatestWeeklyReportLinkProps) {
  const report = await getLatestWeeklyReport();
  // Degrade to nothing: this is an amplifier, never a dependency.
  if (!report) return null;

  if (variant === "inline") {
    return (
      <p className={cn("text-sm text-muted-foreground", className)}>
        {label ?? "Weekly context:"}{" "}
        <Link
          href={report.href}
          prefetch={false}
          className="text-primary hover:underline"
        >
          {report.anchor}
        </Link>
        .
      </p>
    );
  }

  return (
    <Link
      href={report.href}
      prefetch={false}
      className={cn(
        "group block rounded-lg border border-primary/20 bg-gradient-to-r from-primary/5 to-primary/10 p-4 transition-colors hover:border-primary/40",
        className,
      )}
    >
      <div className="flex items-center justify-between gap-3">
        <div className="flex min-w-0 items-center gap-3">
          <div className="shrink-0 rounded-md bg-primary/10 p-2">
            <FileText className="h-5 w-5 text-primary" />
          </div>
          <div className="min-w-0">
            <p className={cn(eyebrow, "font-medium text-primary")}>
              {label ?? "This week's report"}
            </p>
            <p className="truncate text-sm font-medium transition-colors group-hover:text-primary">
              {report.anchor}
            </p>
            {report.headline && (
              <p className="mt-0.5 line-clamp-1 text-xs text-muted-foreground">
                {report.headline}
              </p>
            )}
          </div>
        </div>
        <ChevronRight className="h-5 w-5 shrink-0 text-muted-foreground transition-colors group-hover:text-primary" />
      </div>
    </Link>
  );
}
