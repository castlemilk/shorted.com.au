"use client";

import Link from "next/link";
import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { MessagesSquare, Sparkles, Zap } from "lucide-react";
import { type CommunityOverviewSummary } from "~/@/types/community";
import { Badge } from "~/@/components/ui/badge";
import { Button } from "~/@/components/ui/button";
import { Card, CardContent } from "~/@/components/ui/card";

interface CommunityOverviewTeaserProps {
  stockCode: string;
  summary?: CommunityOverviewSummary;
}

function emptySummary(stockCode: string): CommunityOverviewSummary {
  return {
    headline: `Be the first to discuss ${stockCode}`,
    subheadline:
      "Start the research thread, post a catalyst, or add the first pulse update.",
    ctaLabel: "Open community",
    threadCount: 0,
    pulseCount: 0,
  };
}

function parseDate(value: unknown): Date | undefined {
  if (value instanceof Date) return value;
  if (typeof value === "string" || typeof value === "number") {
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? undefined : date;
  }
  return undefined;
}

function normalizeSummary(
  value: unknown,
  stockCode: string,
): CommunityOverviewSummary | null {
  if (!value || typeof value !== "object") return null;

  const summary = value as Partial<CommunityOverviewSummary> & {
    topThread?: CommunityOverviewSummary["topThread"] & {
      lastActivityAt?: unknown;
    };
  };

  return {
    headline: summary.headline ?? `Be the first to discuss ${stockCode}`,
    subheadline:
      summary.subheadline ??
      "Start the research thread, post a catalyst, or add the first pulse update.",
    ctaLabel: summary.ctaLabel ?? "Open community",
    threadCount: summary.threadCount ?? 0,
    pulseCount: summary.pulseCount ?? 0,
    topThread: summary.topThread
      ? {
          ...summary.topThread,
          lastActivityAt:
            parseDate(summary.topThread.lastActivityAt) ?? new Date(0),
        }
      : undefined,
    latestActivityAt: parseDate(summary.latestActivityAt),
  };
}

function plural(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? "" : "s"}`;
}

function formatActivityLabel(summary: CommunityOverviewSummary): string {
  if (summary.latestActivityAt) {
    return `Last active ${summary.latestActivityAt.toLocaleDateString("en-AU", {
      month: "short",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit",
    })}`;
  }

  if (summary.threadCount === 0 && summary.pulseCount === 0) {
    return "No conversation yet";
  }

  return `${plural(summary.threadCount, "research thread")} · ${plural(summary.pulseCount, "pulse update")}`;
}

export function CommunityOverviewTeaser({
  stockCode,
  summary: initialSummary,
}: CommunityOverviewTeaserProps) {
  const fallbackSummary = useMemo(() => emptySummary(stockCode), [stockCode]);

  // Cached query (was a bare useEffect fetch that re-fired on every remount,
  // i.e. every return to the Overview tab).
  const { data: fetchedSummary } = useQuery({
    queryKey: ["community-summary", stockCode],
    queryFn: async () => {
      const response = await fetch(`/api/community/${stockCode}/summary`, {
        headers: { Accept: "application/json" },
      });
      if (!response.ok) return null;
      const payload = (await response.json()) as { summary?: unknown };
      return normalizeSummary(payload.summary, stockCode);
    },
    staleTime: 5 * 60 * 1000,
    retry: false,
  });

  const summary = fetchedSummary ?? initialSummary ?? fallbackSummary;

  const isEmpty = summary.threadCount === 0 && summary.pulseCount === 0;

  // Compact strip: a pointer to the Community tab, not a second hero card
  // competing with the chart. One line of context + counts + CTA.
  return (
    <Card>
      <CardContent className="flex flex-wrap items-center justify-between gap-3 p-4">
        <div className="flex min-w-0 items-center gap-3">
          <div className="rounded-lg bg-primary/10 p-2 text-primary">
            <MessagesSquare className="h-4 w-4" />
          </div>
          <div className="min-w-0">
            <p className="text-sm font-semibold leading-tight truncate">
              {isEmpty ? `Be the first to discuss ${stockCode}` : summary.headline}
            </p>
            <p className="text-xs text-muted-foreground truncate">
              {isEmpty
                ? "Start a research thread or post the first pulse update"
                : formatActivityLabel(summary)}
            </p>
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-3">
          {!isEmpty && (
            <div className="hidden sm:flex items-center gap-2">
              <Badge
                variant="secondary"
                className="gap-1 tabular-nums"
                aria-label={plural(summary.threadCount, "research thread")}
                title={plural(summary.threadCount, "research thread")}
              >
                <Sparkles className="h-3 w-3" aria-hidden />
                {summary.threadCount}
              </Badge>
              <Badge
                variant="secondary"
                className="gap-1 tabular-nums"
                aria-label={plural(summary.pulseCount, "pulse update")}
                title={plural(summary.pulseCount, "pulse update")}
              >
                <Zap className="h-3 w-3" aria-hidden />
                {summary.pulseCount}
              </Badge>
            </div>
          )}
          <Button asChild size="sm" variant="outline">
            <Link href={`/shorts/${stockCode}?tab=community`}>
              {summary.ctaLabel}
            </Link>
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}
