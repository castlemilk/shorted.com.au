"use client";

import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { createConnectTransport } from "@connectrpc/connect-web";
import { createClient } from "@connectrpc/connect";
import { ShortedStocksService } from "~/gen/shorts/v1alpha1/shorts_pb";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "~/@/components/ui/card";
import { Badge } from "~/@/components/ui/badge";
import { Button } from "~/@/components/ui/button";
import {
  ShieldAlert,
  Award,
  ExternalLink,
  Scale,
  AlertTriangle,
} from "lucide-react";
import { cn } from "~/@/lib/utils";

interface StockSignalsProps {
  stockCode: string;
  limit?: number;
}

interface SignalView {
  polarity: string;
  kind: string;
  headline: string;
  detail: string;
  eventDate: string;
  severity: string;
  confidence: number;
  citations: string[];
}

const SEVERITY_STYLES: Record<string, string> = {
  high: "border-red-400 text-red-700 dark:border-red-700 dark:text-red-400",
  medium: "border-orange-300 text-orange-700 dark:border-orange-700 dark:text-orange-400",
  low: "border-yellow-300 text-yellow-700 dark:border-yellow-700 dark:text-yellow-500",
};

function SignalItem({ s }: { s: SignalView }) {
  const adverse = s.polarity === "adverse";
  const Icon = adverse ? (s.kind === "court" || s.kind === "sanction" ? Scale : AlertTriangle) : Award;
  return (
    <div className="flex gap-3">
      <Icon
        aria-hidden
        className={cn(
          "h-4 w-4 mt-0.5 shrink-0",
          adverse
            ? "text-red-600 dark:text-red-400"
            : "text-emerald-600 dark:text-emerald-400",
        )}
      />
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2 flex-wrap">
          <span className="text-sm font-semibold leading-snug">{s.headline}</span>
          {adverse && s.severity && (
            <Badge
              variant="outline"
              className={cn("text-[10px] py-0 px-1.5 h-4 font-medium uppercase", SEVERITY_STYLES[s.severity])}
            >
              {s.severity}
            </Badge>
          )}
          {s.kind && (
            <span className="text-[10px] uppercase tracking-wide text-muted-foreground">{s.kind}</span>
          )}
          {s.eventDate && (
            <span className="text-[10px] text-muted-foreground tabular-nums">{s.eventDate}</span>
          )}
        </div>
        {s.detail && (
          <p className="text-xs text-muted-foreground mt-0.5 line-clamp-3">{s.detail}</p>
        )}
        {s.citations?.length > 0 && (
          // py-2 -my-1 grows the only path to the evidence to a usable tap target
          <a
            href={s.citations[0]}
            target="_blank"
            rel="noopener noreferrer"
            aria-label={`Source for "${s.headline}" (opens in new tab)`}
            className="inline-flex items-center gap-1 text-[11px] text-muted-foreground hover:text-primary mt-1 py-2 -my-1 pr-2 transition-colors"
          >
            <ExternalLink className="h-3 w-3" aria-hidden />
            source{s.citations.length > 1 ? ` (+${s.citations.length - 1})` : ""}
          </a>
        )}
      </div>
    </div>
  );
}

const COLLAPSED_SIGNAL_COUNT = 3;

export function StockSignals({ stockCode, limit = 6 }: StockSignalsProps) {
  const [showAll, setShowAll] = useState(false);
  const { data, isLoading } = useQuery({
    queryKey: ["stock-signals", stockCode, limit],
    queryFn: async () => {
      const transport = createConnectTransport({ baseUrl: "" });
      const client = createClient(ShortedStocksService, transport);
      return client.getStockSignals({ stockCode, limit });
    },
    staleTime: 30 * 60 * 1000,
  });

  // Below the fold + frequently empty: render nothing while loading rather
  // than flashing a skeleton card that may unmount to null.
  if (isLoading) return null;

  const adverse = (data?.adverse ?? []) as unknown as SignalView[];
  const positive = (data?.positive ?? []) as unknown as SignalView[];
  const total = adverse.length + positive.length;
  if (total === 0) return null;

  // Collapsed: adverse signals take priority, positives fill the remainder.
  const visibleAdverse = showAll
    ? adverse
    : adverse.slice(0, COLLAPSED_SIGNAL_COUNT);
  const visiblePositive = showAll
    ? positive
    : positive.slice(0, Math.max(0, COLLAPSED_SIGNAL_COUNT - adverse.length));
  const hiddenCount = total - visibleAdverse.length - visiblePositive.length;

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="text-lg flex items-center gap-2">
          <ShieldAlert className="h-5 w-5" />
          Risk &amp; reputation signals
        </CardTitle>
        <CardDescription>
          Grounded web research: court matters, regulator actions, awards &amp; press
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-5">
        {visibleAdverse.length > 0 && (
          <div className="space-y-3">
            <h4 className="text-xs font-semibold uppercase tracking-wide text-red-600 dark:text-red-400 flex items-center gap-1.5">
              <ShieldAlert className="h-3.5 w-3.5" aria-hidden /> Adverse
            </h4>
            {visibleAdverse.map((s, i) => (
              <SignalItem key={`a-${i}`} s={s} />
            ))}
          </div>
        )}
        {visiblePositive.length > 0 && (
          <div className="space-y-3">
            <h4 className="text-xs font-semibold uppercase tracking-wide text-emerald-600 dark:text-emerald-400 flex items-center gap-1.5">
              <Award className="h-3.5 w-3.5" aria-hidden /> Positive
            </h4>
            {visiblePositive.map((s, i) => (
              <SignalItem key={`p-${i}`} s={s} />
            ))}
          </div>
        )}
        {hiddenCount > 0 && (
          <Button
            variant="ghost"
            size="sm"
            className="w-full text-muted-foreground"
            onClick={() => setShowAll(true)}
          >
            Show {hiddenCount} more signal{hiddenCount !== 1 ? "s" : ""}
          </Button>
        )}
      </CardContent>
    </Card>
  );
}
