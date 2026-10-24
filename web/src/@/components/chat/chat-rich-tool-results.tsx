"use client";

import { Activity, ArrowUpRight, BarChart3, Building2 } from "lucide-react";
import { Badge } from "~/@/components/ui/badge";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "~/@/components/ui/card";
import { industryLabel } from "~/@/lib/industry-placeholder";
import { safeExternalHref } from "~/@/lib/safe-external-href";
import { cn } from "~/@/lib/utils";
import type { ChatMessage } from "~/@/hooks/use-chat";
import {
  DirectorTradesTable,
  PeersTable,
  TopShortsTable,
} from "./chat-rich-tables";
import {
  arrayValue,
  asRecord,
  codeFromArguments,
  numberValue,
  parseDirectorTrades,
  parseJSON,
  parsePeers,
  parseTopShorts,
  stringValue,
  type DirectorTradesView,
  type JsonRecord,
  type PeersView,
  type TopShortsView,
} from "./chat-tool-data";
import { formatPercent } from "./chat-tool-format";

type ToolCall = NonNullable<ChatMessage["toolCalls"]>[number];

interface StockCardData {
  code: string;
  name: string;
  industry?: string;
  summary?: string;
  website?: string;
  shortPercent?: number;
}

interface ShortPoint {
  label: string;
  value: number;
}

interface ShortChartData {
  code: string;
  name?: string;
  latest: number;
  points: ShortPoint[];
}

/** A tool result drawn as a card, a table or a chart instead of raw JSON. */
export type RichToolResult =
  | { kind: "stock"; stock: StockCardData }
  | { kind: "chart"; chart: ShortChartData }
  | { kind: "top-shorts"; view: TopShortsView }
  | { kind: "peers"; view: PeersView }
  | { kind: "director-trades"; view: DirectorTradesView; code?: string };

/** The rich rendering for a tool call, or null when its output is not one we draw. */
export function getRichToolResult(toolCall: ToolCall): RichToolResult | null {
  switch (toolCall.toolName) {
    case "get_stock_details": {
      const stock = extractStockCard(toolCall);
      return stock ? { kind: "stock", stock } : null;
    }
    case "query_short_positions": {
      const chart = extractShortChart(toolCall);
      return chart ? { kind: "chart", chart } : null;
    }
    case "get_top_shorts": {
      const view = parseTopShorts(toolCall.result);
      return view ? { kind: "top-shorts", view } : null;
    }
    case "get_peer_comparison": {
      const view = parsePeers(toolCall.result);
      return view ? { kind: "peers", view } : null;
    }
    case "get_director_trades": {
      const view = parseDirectorTrades(toolCall.result);
      return view
        ? { kind: "director-trades", view, code: codeFromArguments(toolCall.arguments) }
        : null;
    }
    default:
      return null;
  }
}

export function RichToolResultView({ result }: { result: RichToolResult }) {
  switch (result.kind) {
    case "stock":
      return <StockCard stock={result.stock} />;
    case "chart":
      return <ShortInterestChart chart={result.chart} />;
    case "top-shorts":
      return <TopShortsTable view={result.view} />;
    case "peers":
      return <PeersTable view={result.view} />;
    case "director-trades":
      return <DirectorTradesTable view={result.view} code={result.code} />;
    default:
      return null;
  }
}

function StockCard({ stock }: { stock: StockCardData }) {
  // A tool result's website is stored company data: a link only when http(s).
  const websiteHref = safeExternalHref(stock.website);
  return (
    <Card
      data-testid="chat-stock-card"
      className="w-full overflow-hidden border-border/80 bg-background/80 shadow-none"
    >
      <CardHeader className="space-y-2 p-3 pb-2">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <CardTitle className="flex items-center gap-2 text-sm">
              <Building2 className="h-4 w-4 text-primary" />
              <span className="font-mono">{stock.code}</span>
            </CardTitle>
            <p className="mt-1 truncate text-xs text-muted-foreground">
              {stock.name}
            </p>
          </div>
          {typeof stock.shortPercent === "number" && (
            <Badge variant="secondary" className="shrink-0 text-[11px]">
              {formatPercent(stock.shortPercent)} shorted
            </Badge>
          )}
        </div>
      </CardHeader>
      <CardContent className="space-y-2 p-3 pt-0 text-xs">
        {stock.industry && (
          <div className="flex items-center gap-2 text-muted-foreground">
            <Activity className="h-3.5 w-3.5" />
            <span>{stock.industry}</span>
          </div>
        )}
        {stock.summary && (
          <p className="line-clamp-3 leading-relaxed text-foreground/90">
            {stock.summary}
          </p>
        )}
        {stock.website &&
          (websiteHref ? (
            <a
              href={websiteHref}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-1 text-primary underline-offset-2 hover:underline"
            >
              Company site
              <ArrowUpRight className="h-3 w-3" />
            </a>
          ) : (
            <p className="break-all text-muted-foreground">{stock.website}</p>
          ))}
      </CardContent>
    </Card>
  );
}

function ShortInterestChart({ chart }: { chart: ShortChartData }) {
  const width = 320;
  const height = 88;
  const padding = 10;
  const values = chart.points.map((point) => point.value);
  const min = Math.min(...values);
  const max = Math.max(...values);
  const range = max - min || 1;
  const xStep =
    chart.points.length > 1
      ? (width - padding * 2) / (chart.points.length - 1)
      : 0;
  const path = chart.points
    .map((point, index) => {
      const x = padding + index * xStep;
      const y =
        height -
        padding -
        ((point.value - min) / range) * (height - padding * 2);
      return `${index === 0 ? "M" : "L"} ${x.toFixed(2)} ${y.toFixed(2)}`;
    })
    .join(" ");

  return (
    <Card
      data-testid="chat-short-chart"
      className="w-full overflow-hidden border-border/80 bg-background/80 shadow-none"
    >
      <CardHeader className="space-y-1 p-3 pb-0">
        <CardTitle className="flex items-center gap-2 text-sm">
          <BarChart3 className="h-4 w-4 text-primary" />
          {chart.code} short interest
        </CardTitle>
        <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
          <span>{formatPercent(chart.latest)} latest</span>
          {chart.name && <span>{chart.name}</span>}
        </div>
      </CardHeader>
      <CardContent className="p-3">
        <svg
          aria-label={`${chart.code} short interest chart`}
          className="h-24 w-full text-primary"
          preserveAspectRatio="none"
          viewBox={`0 0 ${width} ${height}`}
        >
          <path
            d={path}
            fill="none"
            stroke="currentColor"
            strokeLinecap="round"
            strokeLinejoin="round"
            strokeWidth="3"
          />
          {chart.points.map((point, index) => {
            const x = padding + index * xStep;
            const y =
              height -
              padding -
              ((point.value - min) / range) * (height - padding * 2);
            return (
              <circle
                key={`${point.label}-${index}`}
                className={cn(
                  index === chart.points.length - 1 &&
                    "fill-background stroke-primary",
                )}
                cx={x}
                cy={y}
                fill="currentColor"
                r={index === chart.points.length - 1 ? 3.5 : 2}
                strokeWidth="2"
              />
            );
          })}
        </svg>
        <div className="mt-1 flex justify-between text-[10px] text-muted-foreground">
          <span>{chart.points[0]?.label}</span>
          <span>{chart.points.at(-1)?.label}</span>
        </div>
      </CardContent>
    </Card>
  );
}

function extractStockCard(toolCall: ToolCall): StockCardData | null {
  const parsed = parseJSON(toolCall.result);
  const root = asRecord(parsed);
  if (!root) return null;

  const candidate =
    asRecord(root.stock) ??
    asRecord(root.details) ??
    asRecord(root.stockDetails) ??
    root;
  const code = stringValue(
    candidate.productCode,
    candidate.stockCode,
    candidate.code,
    asRecord(parseJSON(toolCall.arguments))?.stock_code,
  );
  const name = stringValue(candidate.companyName, candidate.name);
  if (!code || !name) return null;

  return {
    code,
    name,
    industry: industryLabel(stringValue(candidate.industry)) || undefined,
    summary: stringValue(
      candidate.summary,
      candidate.enhancedSummary,
      candidate.description,
    ),
    website: stringValue(candidate.website),
    shortPercent: numberValue(
      candidate.percentageShorted,
      candidate.shortPositionPercent,
      candidate.latestShortPosition,
      candidate.shortPercent,
    ),
  };
}

function extractShortChart(toolCall: ToolCall): ShortChartData | null {
  const parsed = parseJSON(toolCall.result);
  const root = asRecord(parsed);
  if (!root) return null;

  const series =
    firstRecord(root.timeSeries) ??
    firstRecord(root.series) ??
    firstRecord(root.data) ??
    root;
  const points = arrayValue(series.points)
    .map((point) => toShortPoint(point))
    .filter((point): point is ShortPoint => Boolean(point));

  if (points.length < 2) return null;

  const args = asRecord(parseJSON(toolCall.arguments));
  const code = stringValue(
    series.productCode,
    series.stockCode,
    args?.stock_code,
  );
  if (!code) return null;

  return {
    code,
    name: stringValue(series.name, series.companyName),
    latest:
      numberValue(series.latestShortPosition, points.at(-1)?.value) ??
      points.at(-1)!.value,
    points,
  };
}

function firstRecord(value: unknown): JsonRecord | null {
  return arrayValue(value).map(asRecord).find(Boolean) ?? null;
}

function toShortPoint(value: unknown): ShortPoint | null {
  const point = asRecord(value);
  if (!point) return null;
  const shortValue = numberValue(
    point.shortPosition,
    point.short_position,
    point.percentageShorted,
    point.shortPercent,
  );
  if (typeof shortValue !== "number") return null;

  return {
    label: labelFromTimestamp(point.timestamp) ?? stringValue(point.date) ?? "",
    value: shortValue,
  };
}

function labelFromTimestamp(value: unknown): string | undefined {
  if (typeof value === "string") {
    const date = new Date(value);
    if (!Number.isNaN(date.getTime())) {
      return date.toLocaleDateString("en-AU", {
        day: "2-digit",
        month: "short",
      });
    }
    return value;
  }

  const record = asRecord(value);
  if (record && typeof record.seconds === "bigint") {
    return new Date(Number(record.seconds) * 1000).toLocaleDateString("en-AU", {
      day: "2-digit",
      month: "short",
    });
  }
  if (record && typeof record.seconds === "number") {
    return new Date(record.seconds * 1000).toLocaleDateString("en-AU", {
      day: "2-digit",
      month: "short",
    });
  }

  return undefined;
}

