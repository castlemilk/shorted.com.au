import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "~/@/components/ui/card";
import type { FinancialReport } from "~/@/types/company-metadata";
import { formatDate } from "~/@/lib/fundamentals/format";
import { cn } from "~/@/lib/utils";
import { FileText, ExternalLink } from "lucide-react";

// The company's own filings on the Financials tab
// (docs/plans/fundamentals-coverage.md §7.1, item 4): newest first,
// future-dated rows dropped, type pills drawn from the design tokens, and the
// entry the Latest result's figures come from marked as such (matched on the
// period's source_document_url only). Props-only server component.

interface FinancialReportsProps {
  reports: FinancialReport[];
  stockCode: string;
  /** The Latest result's source_document_url; "" or absent when not filing-sourced. */
  sourceDocumentUrl?: string;
  /** "Today" for dropping future-dated rows; defaults to now (tests pin it). */
  now?: Date;
}

/** The marker text on the filing the Latest result's figures come from. */
export const SOURCE_DOCUMENT_MARK = "Figures above come from this filing";

const MAX_REPORTS = 10;

function getReportHref(report: FinancialReport): string | null {
  // eslint-disable-next-line @typescript-eslint/prefer-nullish-coalescing -- intentional: proto defaults to "" which must be treated as falsy
  const url = report.gcs_url || report.url;
  if (!url || !/^https?:\/\//i.test(url.trim())) return null;
  return url.trim();
}

function comparable(value: string | null | undefined): string {
  const url = typeof value === "string" ? value.trim() : "";
  if (!/^https?:\/\//i.test(url)) return "";
  return url.replace(/#.*$/, "").replace(/\/+$/, "");
}

/** YYYY-MM-DD of a report date, or "" when it does not parse. */
function reportDay(date: string | null | undefined): string {
  if (typeof date !== "string") return "";
  const trimmed = date.trim();
  if (/^\d{4}-\d{2}-\d{2}/.test(trimmed)) return trimmed.slice(0, 10);
  const ms = Date.parse(trimmed);
  return Number.isNaN(ms) ? "" : new Date(ms).toISOString().slice(0, 10);
}

/** Today's date in Sydney (ASX dates are Sydney calendar days), YYYY-MM-DD. */
function sydneyToday(now: Date): string {
  try {
    return new Intl.DateTimeFormat("en-CA", {
      timeZone: "Australia/Sydney",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).format(now);
  } catch {
    return now.toISOString().slice(0, 10);
  }
}

/** Token-drawn pill styles by report type (no raw palette colours). */
function reportTypeClass(type: string): string {
  switch (type.toLowerCase()) {
    case "annual_report":
      return "border-primary/40 bg-primary/10 text-primary";
    case "half_year_report":
    case "quarterly_report":
    case "financial_report":
      return "border-input text-foreground";
    default:
      return "border-border text-muted-foreground";
  }
}

function reportTypeLabel(type: string): string {
  return type.replace(/_/g, " ").replace(/\b\w/g, (l) => l.toUpperCase());
}

export interface ListedReport {
  report: FinancialReport;
  href: string;
  day: string;
  isSourceDocument: boolean;
}

/**
 * The reports the list shows, in order: linkable, not dated after today,
 * newest first (undated last), at most ten, and never dropping the filing the
 * Latest result comes from.
 */
export function listedReports(
  reports: readonly FinancialReport[],
  sourceDocumentUrl: string | undefined,
  now: Date,
): { shown: ListedReport[]; total: number } {
  const today = sydneyToday(now);
  const target = comparable(sourceDocumentUrl);
  const rows: ListedReport[] = [];
  for (const report of reports ?? []) {
    const href = getReportHref(report);
    if (!href) continue;
    const day = reportDay(report.date);
    if (day && day > today) continue;
    const isSourceDocument =
      target !== "" &&
      (comparable(report.url) === target || comparable(report.gcs_url) === target);
    rows.push({ report, href, day, isSourceDocument });
  }
  rows.sort((a, b) => {
    if (a.day && b.day) return b.day.localeCompare(a.day);
    if (a.day) return -1;
    if (b.day) return 1;
    return 0;
  });
  const shown = rows.slice(0, MAX_REPORTS);
  const marked = rows.find((row) => row.isSourceDocument);
  if (marked && !shown.includes(marked)) shown.push(marked);
  return { shown, total: rows.length };
}

/** At least one filing would be listed (drives the empty state's last sentence). */
export function hasListedReports(
  reports: readonly FinancialReport[] | null | undefined,
  now: Date = new Date(),
): boolean {
  return listedReports(reports ?? [], undefined, now).total > 0;
}

export function FinancialReports({
  reports,
  stockCode: _stockCode,
  sourceDocumentUrl,
  now,
}: FinancialReportsProps) {
  const { shown: all, total } = listedReports(
    reports ?? [],
    sourceDocumentUrl,
    now ?? new Date(),
  );
  if (all.length === 0) return null;

  return (
    <Card role="region" aria-labelledby="financial-reports-heading">
      <CardHeader className="pb-3">
        <CardTitle
          id="financial-reports-heading"
          className="flex items-center gap-2 text-lg"
        >
          <FileText className="h-5 w-5" aria-hidden />
          Financial reports
        </CardTitle>
        <CardDescription>
          The company&apos;s own filings, newest first
        </CardDescription>
      </CardHeader>
      <CardContent>
        <ul className="space-y-1">
          {all.map(({ report, href, day, isSourceDocument }) => {
            const date = formatDate(day);
            return (
              <li key={`${href}-${day}`}>
                <a
                  href={href}
                  target="_blank"
                  rel="noopener noreferrer"
                  className={cn(
                    "-mx-2 flex items-start justify-between gap-2 rounded-lg p-2 transition-colors hover:bg-muted/50",
                    isSourceDocument && "bg-primary/5",
                  )}
                >
                  <div className="min-w-0 flex-1 space-y-1">
                    <span className="block truncate text-sm font-medium">
                      {report.title}
                    </span>
                    <div className="flex flex-wrap items-center gap-2">
                      {report.type ? (
                        <span
                          className={cn(
                            "inline-flex items-center rounded-sm border px-1.5 py-0.5 text-[11px] font-medium uppercase leading-none tracking-[0.12em]",
                            reportTypeClass(report.type),
                          )}
                        >
                          {reportTypeLabel(report.type)}
                        </span>
                      ) : null}
                      {date ? (
                        <span className="text-xs tabular-nums text-muted-foreground">
                          {date}
                        </span>
                      ) : null}
                      {report.source ? (
                        <span className="text-xs text-muted-foreground">
                          via {report.source}
                        </span>
                      ) : null}
                    </div>
                    {isSourceDocument ? (
                      <p className="text-xs font-medium text-primary">
                        {SOURCE_DOCUMENT_MARK}
                      </p>
                    ) : null}
                  </div>
                  <ExternalLink
                    aria-hidden="true"
                    className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground"
                  />
                </a>
              </li>
            );
          })}
        </ul>
        {total > all.length ? (
          <p className="mt-3 text-center text-xs text-muted-foreground">
            Showing {all.length} of {total} reports
          </p>
        ) : null}
      </CardContent>
    </Card>
  );
}
