"use client";

import { useQuery } from "@tanstack/react-query";
import { createConnectTransport } from "@connectrpc/connect-web";
import { createClient } from "@connectrpc/connect";
import { StockService } from "~/gen/shorts/v1alpha1/stock_pb";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "~/@/components/ui/card";
import { Badge } from "~/@/components/ui/badge";
import { SentimentBadge } from "~/@/components/ui/sentiment-badge";
import { Skeleton } from "~/@/components/ui/skeleton";
import {
  Megaphone,
  ArrowLeftRight,
  Newspaper,
  TrendingUp,
  CalendarClock,
  ExternalLink,
} from "lucide-react";
import { cn } from "~/@/lib/utils";

interface EventTimelineProps {
  stockCode: string;
  daysBack?: number;
  limit?: number;
}

type EventType = "announcement" | "director_trade" | "news" | "short_spike";

const EVENT_CONFIG: Record<
  EventType,
  { icon: React.ElementType; color: string; dotColor: string; label: string }
> = {
  announcement: {
    icon: Megaphone,
    color: "text-blue-500",
    dotColor: "bg-blue-500",
    label: "Announcement",
  },
  director_trade: {
    icon: ArrowLeftRight,
    color: "text-violet-500",
    dotColor: "bg-violet-500",
    label: "Director trade",
  },
  news: {
    icon: Newspaper,
    color: "text-amber-500",
    dotColor: "bg-amber-500",
    label: "News",
  },
  short_spike: {
    icon: TrendingUp,
    color: "text-red-500",
    dotColor: "bg-red-500",
    label: "Short spike",
  },
};

function formatEventDate(dateStr: string): string {
  // dateStr is YYYY-MM-DD — parse manually to avoid UTC offset issues
  const parts = dateStr.split("-");
  const year = parseInt(parts[0] ?? "2000", 10);
  const month = parseInt(parts[1] ?? "1", 10);
  const day = parseInt(parts[2] ?? "1", 10);
  const date = new Date(year, month - 1, day);
  const thisYear = new Date().getFullYear();
  const options: Intl.DateTimeFormatOptions = {
    day: "numeric",
    month: "short",
    ...(date.getFullYear() !== thisYear ? { year: "numeric" } : {}),
  };
  return date.toLocaleDateString("en-AU", options);
}

function getEventConfig(type: string) {
  return EVENT_CONFIG[type as EventType] ?? EVENT_CONFIG.news;
}

export function EventTimeline({
  stockCode,
  daysBack = 365,
  limit = 40,
}: EventTimelineProps) {
  const { data, isLoading } = useQuery({
    queryKey: ["event-timeline", stockCode, daysBack, limit],
    queryFn: async () => {
      const transport = createConnectTransport({ baseUrl: "" });
      const client = createClient(StockService, transport);
      return client.getEventTimeline({ stockCode, daysBack, limit });
    },
    staleTime: 5 * 60 * 1000,
  });

  if (isLoading) {
    return (
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-lg flex items-center gap-2">
            <CalendarClock className="h-5 w-5" />
            Event timeline
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          {Array.from({ length: 5 }).map((_, i) => (
            <div key={i} className="flex gap-3">
              <Skeleton className="h-3 w-3 rounded-full mt-1.5 shrink-0" />
              <div className="space-y-1.5 flex-1">
                <Skeleton className="h-3 w-24" />
                <Skeleton className="h-4 w-3/4" />
                <Skeleton className="h-3 w-1/2" />
              </div>
            </div>
          ))}
        </CardContent>
      </Card>
    );
  }

  if (!data?.events?.length) return null;

  // Events are already newest-first from the API, but sort defensively
  const events = [...data.events].sort((a, b) => b.date.localeCompare(a.date));

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="text-lg flex items-center gap-2">
          <CalendarClock className="h-5 w-5" />
          Event timeline
        </CardTitle>
        <CardDescription>
          Key events over the last {daysBack >= 365 ? "year" : `${daysBack} days`}
        </CardDescription>
      </CardHeader>
      <CardContent>
        <div className="relative">
          {/* Vertical line */}
          <div className="absolute left-[5px] top-2 bottom-2 w-px bg-border" />

          <div className="space-y-5">
            {events.map((event, idx) => {
              const config = getEventConfig(event.type);
              const Icon = config.icon;
              const hasUrl = Boolean(event.url);

              return (
                <div key={idx} className="flex gap-4 relative">
                  {/* Dot */}
                  <div
                    className={cn(
                      "h-[11px] w-[11px] rounded-full shrink-0 mt-1 ring-2 ring-background",
                      config.dotColor,
                    )}
                  />

                  {/* Content */}
                  <div className="flex-1 min-w-0 pb-1">
                    {/* Date + type */}
                    <div className="flex items-center gap-2 mb-0.5">
                      <span className="text-xs text-muted-foreground tabular-nums">
                        {formatEventDate(event.date)}
                      </span>
                      <div
                        className={cn(
                          "flex items-center gap-1 text-xs font-medium",
                          config.color,
                        )}
                      >
                        <Icon className="h-3 w-3" />
                        <span>{config.label}</span>
                      </div>
                    </div>

                    {/* Title */}
                    {hasUrl ? (
                      <a
                        href={event.url}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="group inline-flex items-start gap-1"
                      >
                        <span className="text-sm font-semibold leading-snug group-hover:text-primary transition-colors">
                          {event.title}
                        </span>
                        <ExternalLink className="h-3 w-3 text-muted-foreground mt-0.5 shrink-0 opacity-0 group-hover:opacity-100 transition-opacity" />
                      </a>
                    ) : (
                      <p className="text-sm font-semibold leading-snug">
                        {event.title}
                      </p>
                    )}

                    {/* Detail */}
                    {event.detail && (
                      <p className="text-xs text-muted-foreground mt-0.5 line-clamp-2">
                        {event.detail}
                      </p>
                    )}

                    {/* Badges */}
                    {(event.isPriceSensitive ||
                      (event.sentiment && event.type === "news")) && (
                      <div className="flex items-center gap-1.5 mt-1.5">
                        {event.isPriceSensitive && (
                          <Badge
                            variant="outline"
                            className="text-[10px] py-0 px-1.5 h-4 font-medium border-orange-300 text-orange-700 dark:border-orange-700 dark:text-orange-400"
                          >
                            Price sensitive
                          </Badge>
                        )}
                        {event.sentiment && event.type === "news" && (
                          <SentimentBadge sentiment={event.sentiment} />
                        )}
                      </div>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      </CardContent>
    </Card>
  );
}
