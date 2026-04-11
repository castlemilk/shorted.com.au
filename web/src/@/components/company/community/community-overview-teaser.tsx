import Link from "next/link";
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
  summary: CommunityOverviewSummary;
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
  summary,
}: CommunityOverviewTeaserProps) {
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
