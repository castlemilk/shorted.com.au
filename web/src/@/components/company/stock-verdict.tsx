"use client";

import { useQuery } from "@tanstack/react-query";
import { VerdictLabel } from "~/gen/shorts/v1alpha1/shorts_pb";
import { getStockVerdictClient } from "~/app/actions/client/getStockVerdictClient";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "~/@/components/ui/card";
import { Scale } from "lucide-react";
import { cn } from "~/@/lib/utils";

interface StockVerdictProps {
  stockCode: string;
}

const LABEL_TEXT: Record<VerdictLabel, string> = {
  [VerdictLabel.UNSPECIFIED]: "Neutral",
  [VerdictLabel.STRONG_BEARISH]: "Strong bearish",
  [VerdictLabel.BEARISH]: "Bearish",
  [VerdictLabel.NEUTRAL]: "Neutral",
  [VerdictLabel.BULLISH]: "Bullish",
  [VerdictLabel.STRONG_BULLISH]: "Strong bullish",
};

const LABEL_COLOR: Record<VerdictLabel, string> = {
  [VerdictLabel.UNSPECIFIED]: "text-muted-foreground",
  [VerdictLabel.STRONG_BEARISH]: "text-red-700 dark:text-red-400",
  [VerdictLabel.BEARISH]: "text-red-700 dark:text-red-400",
  [VerdictLabel.NEUTRAL]: "text-muted-foreground",
  [VerdictLabel.BULLISH]: "text-emerald-700 dark:text-emerald-400",
  [VerdictLabel.STRONG_BULLISH]: "text-emerald-700 dark:text-emerald-400",
};

const COMPONENT_LABELS: Record<string, string> = {
  short_trend: "Short-interest trend",
  short_level: "Short-interest level",
  director_signal: "Director trading",
  sentiment: "News sentiment",
  squeeze_pressure: "Squeeze pressure",
};

/**
 * Semicircle gauge from -100 (bear, red, left) to +100 (bull, green, right)
 * with a needle at the composite score. Pure SVG, no chart deps.
 */
function VerdictGauge({ composite }: { composite: number }) {
  const cx = 100;
  const cy = 92;
  const r = 78;

  // Map -100..100 to 180deg..0deg (left = bear, right = bull)
  const clamped = Math.max(-100, Math.min(100, composite));
  const angleDeg = 180 - ((clamped + 100) / 200) * 180;
  const angleRad = (angleDeg * Math.PI) / 180;
  const needleX = cx + r * 0.82 * Math.cos(angleRad);
  const needleY = cy - r * 0.82 * Math.sin(angleRad);

  const arcPoint = (deg: number) => {
    const rad = (deg * Math.PI) / 180;
    return `${cx + r * Math.cos(rad)} ${cy - r * Math.sin(rad)}`;
  };

  // Band arcs matching the verdict thresholds (-40, -10, 10, 40)
  const bands: Array<{ from: number; to: number; className: string }> = [
    { from: -100, to: -40, className: "stroke-red-500" },
    { from: -40, to: -10, className: "stroke-red-400/70" },
    { from: -10, to: 10, className: "stroke-muted-foreground/40" },
    { from: 10, to: 40, className: "stroke-emerald-400/70" },
    { from: 40, to: 100, className: "stroke-emerald-500" },
  ];
  const scoreToDeg = (score: number) => 180 - ((score + 100) / 200) * 180;

  return (
    <svg viewBox="0 0 200 104" className="w-full max-w-[260px]" role="img" aria-label={`Verdict gauge: ${composite.toFixed(1)}`}>
      {bands.map((band) => (
        <path
          key={`${band.from}:${band.to}`}
          d={`M ${arcPoint(scoreToDeg(band.from))} A ${r} ${r} 0 0 1 ${arcPoint(scoreToDeg(band.to))}`}
          fill="none"
          strokeWidth={10}
          strokeLinecap="butt"
          className={band.className}
        />
      ))}
      {/* Needle */}
      <line
        x1={cx}
        y1={cy}
        x2={needleX}
        y2={needleY}
        strokeWidth={2.5}
        strokeLinecap="round"
        className="stroke-foreground"
      />
      <circle cx={cx} cy={cy} r={4} className="fill-foreground" />
      {/* End labels */}
      <text x={cx - r} y={cy + 12} textAnchor="middle" className="fill-red-500 text-[9px] font-semibold">
        Bear
      </text>
      <text x={cx + r} y={cy + 12} textAnchor="middle" className="fill-emerald-500 text-[9px] font-semibold">
        Bull
      </text>
    </svg>
  );
}

function ContributionBar({ contribution }: { contribution: number }) {
  // Contributions live in roughly -30..30 points; scale bar width to that
  const magnitude = Math.min(Math.abs(contribution) / 30, 1) * 50;
  const positive = contribution >= 0;
  return (
    <div className="relative h-1.5 w-full rounded-full bg-muted">
      <div
        className={cn(
          "absolute top-0 h-1.5 rounded-full",
          positive ? "left-1/2 bg-emerald-500" : "right-1/2 bg-red-500",
        )}
        style={{ width: `${magnitude}%` }}
      />
      <div className="absolute left-1/2 top-[-1px] h-2 w-px bg-border" />
    </div>
  );
}

function isStockVerdictEnabled() {
  // Default ON: the composite verdict is the page's main synthesis widget and
  // degrades to null when the RPC has no data. The env var is a kill switch
  // (set NEXT_PUBLIC_STOCK_VERDICT_ENABLED=0 to disable) — previously this
  // required opt-in ("1") but the flag was never set in any environment, so
  // the gauge was dark everywhere.
  return process.env.NEXT_PUBLIC_STOCK_VERDICT_ENABLED !== "0";
}

export function StockVerdict({ stockCode }: StockVerdictProps) {
  const enabled = isStockVerdictEnabled();

  const { data, isLoading, isError } = useQuery({
    queryKey: ["stock-verdict", stockCode],
    queryFn: () => getStockVerdictClient(stockCode),
    staleTime: 5 * 60 * 1000,
    retry: false,
    enabled,
  });

  if (!enabled) return null;

  // Below the fold + frequently absent: render nothing while loading rather
  // than flashing a skeleton card that may unmount to null.
  if (isLoading) return null;

  // NotFound (stock not in screener data) or any other failure: render nothing
  if (isError || !data) return null;

  const label = data.label;

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="text-lg flex items-center gap-2">
          <Scale className="h-5 w-5" />
          Bear vs Bull verdict
        </CardTitle>
        <CardDescription>
          Composite of short-interest trend &amp; level, director trading, news
          sentiment, and squeeze pressure
        </CardDescription>
      </CardHeader>
      <CardContent>
        <div className="flex flex-col gap-6 sm:flex-row sm:items-center">
          <div className="flex flex-col items-center gap-1">
            <VerdictGauge composite={data.composite} />
            <span
              className={cn(
                "text-xl font-bold tabular-nums",
                LABEL_COLOR[label] ?? "text-muted-foreground",
              )}
            >
              {data.composite > 0 ? "+" : ""}
              {data.composite.toFixed(1)}
            </span>
            <span
              className={cn(
                "text-sm font-semibold uppercase tracking-wide",
                LABEL_COLOR[label] ?? "text-muted-foreground",
              )}
            >
              {LABEL_TEXT[label] ?? "Neutral"}
            </span>
          </div>

          <div className="flex-1 space-y-2.5">
            {data.components.map((component) => (
              <div key={component.name} className="space-y-1">
                <div className="flex items-center justify-between gap-2 text-xs">
                  <span className="text-muted-foreground">
                    {COMPONENT_LABELS[component.name] ?? component.name}
                  </span>
                  <span
                    className={cn(
                      "font-mono tabular-nums font-medium",
                      // -700 in light mode: at text-xs the -600 shades sit
                      // below WCAG AA 4.5:1 on the near-white card (a11y flag)
                      component.contribution > 0
                        ? "text-emerald-700 dark:text-emerald-400"
                        : component.contribution < 0
                          ? "text-red-700 dark:text-red-400"
                          : "text-muted-foreground",
                    )}
                  >
                    {component.contribution > 0 ? "+" : ""}
                    {component.contribution.toFixed(1)}
                  </span>
                </div>
                <ContributionBar contribution={component.contribution} />
              </div>
            ))}
          </div>
        </div>
      </CardContent>
    </Card>
  );
}
