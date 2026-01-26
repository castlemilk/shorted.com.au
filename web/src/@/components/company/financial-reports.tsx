import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "~/@/components/ui/card";
import { Button } from "~/@/components/ui/button";
import type { FinancialReport } from "~/@/types/company-metadata";
import { FileText, ExternalLink } from "lucide-react";

interface FinancialReportsProps {
  reports: FinancialReport[];
  stockCode: string;
}

export function FinancialReports({ reports, stockCode: _stockCode }: FinancialReportsProps) {
  if (!reports || reports.length === 0) {
    return null;
  }

  const formatDate = (dateString: string | null) => {
    if (!dateString) return "N/A";
    try {
      return new Date(dateString).toLocaleDateString("en-US", {
        year: "numeric",
        month: "short",
        day: "numeric",
      });
    } catch {
      return dateString;
    }
  };

  const getReportTypeColor = (type: string) => {
    switch (type.toLowerCase()) {
      case "annual_report":
        return "text-blue-600 bg-blue-50 dark:text-blue-400 dark:bg-blue-950/30";
      case "quarterly_report":
        return "text-purple-600 bg-purple-50 dark:text-purple-400 dark:bg-purple-950/30";
      case "financial_report":
        return "text-green-600 bg-green-50 dark:text-green-400 dark:bg-green-950/30";
      default:
        return "text-gray-600 bg-gray-50 dark:text-gray-400 dark:bg-gray-950/30";
    }
  };

  const getReportTypeLabel = (type: string) => {
    return type.replace(/_/g, " ").replace(/\b\w/g, (l) => l.toUpperCase());
  };

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="text-lg flex items-center gap-2">
          <FileText className="h-5 w-5" />
          Financial Reports
        </CardTitle>
        <CardDescription>
          {reports.length} report{reports.length !== 1 ? "s" : ""} available
        </CardDescription>
      </CardHeader>
      <CardContent>
        <div className="space-y-3">
          {reports.slice(0, 10).map((report, index) => (
            <div
              key={index}
              className="flex items-start justify-between p-3 rounded-lg border hover:bg-accent transition-colors"
            >
              <div className="flex-1 space-y-1 min-w-0">
                <p className="text-sm font-medium truncate">{report.title}</p>
                <div className="flex items-center gap-2 flex-wrap">
                  <span
                    className={`text-xs px-2 py-0.5 rounded-full ${getReportTypeColor(
                      report.type
                    )}`}
                  >
                    {getReportTypeLabel(report.type)}
                  </span>
                  {report.date && (
                    <span className="text-xs text-muted-foreground">
                      {formatDate(report.date)}
                    </span>
                  )}
                  {report.source && (
                    <span className="text-xs text-muted-foreground">
                      via {report.source}
                    </span>
                  )}
                </div>
              </div>
              <Button
                size="sm"
                variant="ghost"
                className="ml-2 shrink-0"
                asChild
              >
                <a
                  href={report.url}
                  target="_blank"
                  rel="noopener noreferrer"
                  aria-label={`Open ${report.title}`}
                >
                  <ExternalLink className="h-4 w-4" />
                </a>
              </Button>
            </div>
          ))}
        </div>
        {reports.length > 10 && (
          <p className="text-xs text-muted-foreground mt-3 text-center">
            Showing 10 of {reports.length} reports
          </p>
        )}
      </CardContent>
    </Card>
  );
}

