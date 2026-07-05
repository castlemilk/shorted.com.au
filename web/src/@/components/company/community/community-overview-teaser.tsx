"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { MessagesSquare, Sparkles, Zap } from "lucide-react";
import { type CommunityOverviewSummary } from "~/@/types/community";
import { Badge } from "~/@/components/ui/badge";
import { Button } from "~/@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "~/@/components/ui/card";
import { CommunityEmptyState } from "./community-empty-state";

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

  return `${summary.threadCount} research threads · ${summary.pulseCount} live pulse updates`;
}

export function CommunityOverviewTeaser({
  stockCode,
  summary: initialSummary,
}: CommunityOverviewTeaserProps) {
  const fallbackSummary = useMemo(() => emptySummary(stockCode), [stockCode]);
  const [summary, setSummary] = useState<CommunityOverviewSummary>(
    initialSummary ?? fallbackSummary,
  );

  useEffect(() => {
    if (typeof fetch !== "function") return;

    const controller = new AbortController();

    fetch(`/api/community/${stockCode}/summary`, {
      signal: controller.signal,
      headers: { Accept: "application/json" },
    })
      .then((response) => (response.ok ? response.json() : null))
      .then((payload: unknown) => {
        if (!payload || controller.signal.aborted) return;
        const response = payload as { summary?: unknown };
        const nextSummary = normalizeSummary(response.summary, stockCode);
        if (nextSummary) setSummary(nextSummary);
      })
      .catch((error: unknown) => {
        if ((error as { name?: string }).name !== "AbortError") {
          console.error("Failed to load community summary", error);
        }
      });

    return () => controller.abort();
  }, [stockCode]);

  const isEmpty = summary.threadCount === 0 && summary.pulseCount === 0;

  return (
    <Card className="overflow-hidden border-l-4 border-l-emerald-500 shadow-lg transition-all duration-300 hover:shadow-xl">
      <CardHeader className="gap-3 bg-gradient-to-r from-emerald-50/80 via-background to-background pb-4 dark:from-emerald-950/20">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-3">
            <div className="rounded-xl bg-emerald-100 p-2.5 text-emerald-700 shadow-sm dark:bg-emerald-900/40 dark:text-emerald-300">
              <MessagesSquare className="h-5 w-5" />
            </div>
            <div>
              <CardTitle className="text-xl text-emerald-950 dark:text-emerald-100">
                Live on {stockCode}
              </CardTitle>
              <CardDescription className="mt-1.5 text-sm">
                Evidence-first threads and a faster pulse rail for real-time context.
              </CardDescription>
            </div>
          </div>
          <div className="flex flex-wrap gap-2">
            <Badge variant="secondary" className="gap-1 bg-emerald-100/80 text-emerald-900 dark:bg-emerald-900/40 dark:text-emerald-100">
              <Sparkles className="h-3.5 w-3.5" />
              {summary.threadCount} threads
            </Badge>
            <Badge variant="secondary" className="gap-1 bg-sky-100/80 text-sky-900 dark:bg-sky-900/40 dark:text-sky-100">
              <Zap className="h-3.5 w-3.5" />
              {summary.pulseCount} pulse
            </Badge>
          </div>
        </div>
      </CardHeader>

      <CardContent className="space-y-4 pt-5">
        {isEmpty ? (
          <CommunityEmptyState
            eyebrow="Low activity"
            title={summary.headline}
            description={summary.subheadline}
          />
        ) : (
          <div className="space-y-3">
            <div className="space-y-2">
              <p className="text-lg font-semibold leading-tight text-foreground">
                {summary.headline}
              </p>
              <p className="text-sm leading-6 text-muted-foreground">
                {summary.subheadline}
              </p>
            </div>
            <p className="text-xs font-medium uppercase tracking-[0.16em] text-muted-foreground">
              {formatActivityLabel(summary)}
            </p>
          </div>
        )}

        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="text-sm text-muted-foreground">
            {summary.topThread
              ? `${summary.topThread.commentCount} comments on the top research thread`
              : "Open the community tab to start the conversation"}
          </div>
          <Button asChild>
            <Link href={`/shorts/${stockCode}?tab=community`}>
              {summary.ctaLabel}
            </Link>
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}
