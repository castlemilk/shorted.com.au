"use client";

import { useState, useEffect } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { FileText, ChevronRight, X } from "lucide-react";
import { Button } from "~/@/components/ui/button";
import { weeklyReportPath } from "~/@/lib/reports/weekly-slug";

export function ReportsBanner() {
  const [isVisible, setIsVisible] = useState(true);
  const router = useRouter();

  useEffect(() => {
    const dismissed = localStorage.getItem("reports-banner-dismissed");
    if (dismissed === "true") {
      setIsVisible(false);
      return;
    }

    // Prefetch the latest weekly report page for instant navigation
    // (canonical path — the ISO form 301s).
    const now = new Date();
    const d = new Date(Date.UTC(now.getFullYear(), now.getMonth(), now.getDate()));
    d.setUTCDate(d.getUTCDate() + 4 - (d.getUTCDay() || 7));
    const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
    const weekNum = Math.ceil(((d.getTime() - yearStart.getTime()) / 86400000 + 1) / 7);
    const slug = `${d.getUTCFullYear()}-W${String(weekNum).padStart(2, "0")}`;
    router.prefetch(weeklyReportPath(slug));
  }, [router]);

  const handleDismiss = (e: React.MouseEvent) => {
    e.stopPropagation();
    setIsVisible(false);
    localStorage.setItem("reports-banner-dismissed", "true");
  };

  if (!isVisible) return null;

  return (
    <div className="relative overflow-hidden rounded-lg border border-primary/20 bg-gradient-to-r from-primary/5 via-primary/10 to-accent/5 mb-6">
      <div className="px-4 py-3 sm:px-6 sm:py-4">
        <div className="flex items-center justify-between gap-4">
          <Link
            href="/reports"
            className="flex items-center gap-3 group flex-1 min-w-0"
          >
            <div className="shrink-0 p-2 bg-primary/10 rounded-md">
              <FileText className="h-5 w-5 text-primary" />
            </div>
            <div className="min-w-0">
              <p className="text-sm font-semibold text-foreground group-hover:text-primary transition-colors">
                Weekly &amp; Monthly Short Selling Reports
              </p>
              <p className="text-xs text-muted-foreground hidden sm:block">
                AI-powered analysis of ASX short positions with macro &amp; micro economic context
              </p>
            </div>
            <ChevronRight className="h-4 w-4 shrink-0 text-muted-foreground group-hover:text-primary transition-colors" />
          </Link>
          <Button
            variant="ghost"
            size="sm"
            className="h-7 w-7 p-0 shrink-0"
            onClick={handleDismiss}
          >
            <X className="h-3.5 w-3.5" />
            <span className="sr-only">Dismiss</span>
          </Button>
        </div>
      </div>
    </div>
  );
}
