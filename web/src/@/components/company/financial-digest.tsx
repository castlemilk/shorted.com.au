import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "~/@/components/ui/card";
import { type StockFinancialHighlight } from "~/app/actions/reports/getReportData";
import { FileSearch } from "lucide-react";

interface FinancialDigestProps {
  highlights: StockFinancialHighlight[];
}

function formatReportDate(dateString: string): string {
  if (!dateString) return "";
  try {
    return new Date(dateString).toLocaleDateString("en-AU", {
      year: "numeric",
      month: "short",
      day: "numeric",
    });
  } catch {
    return dateString;
  }
}

function getReportTypeLabel(reportType: string): string {
  return reportType.replace(/_/g, " ").replace(/\b\w/g, (l) => l.toUpperCase());
}

// Metric types quoted per-share (cents or dollars) — these must never run
// through the millions/billions ladder.
const PER_SHARE_METRIC_TYPES = new Set(["eps", "dividend"]);

function parseNumeric(value: string | undefined): number | null {
  if (value === undefined || value.trim() === "") return null;
  const num = parseFloat(value);
  return Number.isFinite(num) ? num : null;
}

/**
 * Formats a metric value from the attributes map into a readable string.
 *
 * Attribute shape (see getReportData.ts / weekly-report-generator):
 * - aggregate metrics (revenue, net_profit, …) carry `value_millions`
 *   (occasionally `value_billions`) → "$624M" / "$1.54B"
 * - per-share metrics (eps, dividend) carry `value_cents` (or a dollar
 *   `value`) → "$2.35" / "$0.50"
 *
 * Returns null (metric omitted) when no parseable value is present.
 */
export function formatMetricValue(
  metricType: string,
  attributes: Record<string, string>,
): string | null {
  // Prefer explicit pre-formatted value if the backend ever supplies one
  if (attributes.formatted) return attributes.formatted;

  if (PER_SHARE_METRIC_TYPES.has(metricType)) {
    const cents = parseNumeric(attributes.value_cents);
    const dollars = cents !== null ? cents / 100 : parseNumeric(attributes.value);
    if (dollars === null) return null;
    return `${dollars < 0 ? "-" : ""}$${Math.abs(dollars).toFixed(2)}`;
  }

  // Aggregate metrics: value is reported in millions
  const billions = parseNumeric(attributes.value_billions);
  const millions =
    parseNumeric(attributes.value_millions) ??
    (billions !== null ? billions * 1000 : null);
  if (millions === null) return null;

  const sign = millions < 0 ? "-" : "";
  const abs = Math.abs(millions);
  if (abs >= 1000) {
    return `${sign}$${(abs / 1000).toFixed(2)}B`;
  }
  return `${sign}$${abs.toFixed(0)}M`;
}

// Which metric types to surface in the compact row (in display order)
const KEY_METRIC_TYPES = ["revenue", "net_profit", "eps", "dividend"];

const METRIC_LABELS: Record<string, string> = {
  revenue: "Revenue",
  net_profit: "Net Profit",
  eps: "EPS",
  dividend: "Dividend",
};

/**
 * FinancialDigest — server component.
 *
 * Renders a "Results summary" card for the most-recent financial report(s) that
 * carry a non-empty digest. Returns null when no digest is available.
 */
export function FinancialDigest({ highlights }: FinancialDigestProps) {
  // Find reports with a meaningful digest, sorted by date descending
  const reportsWithDigest = highlights
    .filter((h) => h.digest && h.digest.trim().length > 0)
    .sort((a, b) => b.reportDate.localeCompare(a.reportDate));

  if (reportsWithDigest.length === 0) return null;

  // Show only the most-recent report's digest
  const report = reportsWithDigest[0]!;

  // Pick the key metrics to show in the compact row
  const keyMetrics = KEY_METRIC_TYPES
    .map((type) => {
      const metric = report.metrics.find((m) => m.metricType === type);
      if (!metric) return null;
      const value = formatMetricValue(type, metric.attributes);
      if (!value) return null;
      const period = metric.attributes.period ?? "";
      return { type, label: METRIC_LABELS[type] ?? type, value, period };
    })
    .filter((m): m is NonNullable<typeof m> => m !== null);

  // Confidence badge: only shown when confidence < 0.85 (below threshold = subtle caveat)
  const showConfidenceHint = report.confidence > 0 && report.confidence < 0.85;

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="text-lg flex items-center gap-2">
          <FileSearch className="h-5 w-5" />
          Results summary
        </CardTitle>
        {/* Report identity */}
        <div className="flex items-center gap-2 flex-wrap">
          <span className="text-xs font-medium text-foreground">
            {report.reportTitle}
          </span>
          <span className="text-xs text-muted-foreground">·</span>
          <span className="text-xs px-2 py-0.5 rounded-full bg-muted text-muted-foreground">
            {getReportTypeLabel(report.reportType)}
          </span>
          {report.reportDate && (
            <>
              <span className="text-xs text-muted-foreground">·</span>
              <span className="text-xs text-muted-foreground">
                {formatReportDate(report.reportDate)}
              </span>
            </>
          )}
        </div>
      </CardHeader>

      <CardContent className="space-y-4">
        {/* Digest text */}
        <p className="text-sm leading-relaxed text-foreground">
          {report.digest}
        </p>

        {/* Key metrics compact row */}
        {keyMetrics.length > 0 && (
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
            {keyMetrics.map((m) => (
              <div
                key={m.type}
                className="rounded-md border bg-muted/30 px-3 py-2 text-center"
              >
                <p className="text-xs uppercase font-semibold text-muted-foreground tracking-wide">
                  {m.label}
                </p>
                <p className="mt-0.5 text-sm font-medium tabular-nums">
                  {m.value}
                </p>
                {m.period && (
                  <p className="text-[10px] text-muted-foreground mt-0.5">
                    {m.period}
                  </p>
                )}
              </div>
            ))}
          </div>
        )}

        {/* Subtle confidence hint — only shown when confidence is below threshold */}
        {showConfidenceHint && (
          <p className="text-[11px] text-muted-foreground">
            Summary auto-generated · confidence {Math.round(report.confidence * 100)}%
          </p>
        )}
      </CardContent>
    </Card>
  );
}
