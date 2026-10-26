"use client";

import dynamic from "next/dynamic";
import { useId } from "react";
import { Activity, ArrowUpRight, BarChart3, Building2 } from "lucide-react";
import { Badge } from "~/@/components/ui/badge";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "~/@/components/ui/card";
import { seriesColor } from "~/@/components/charts/chart-theme";
import { industryLabel } from "~/@/lib/industry-placeholder";
import { safeExternalHref } from "~/@/lib/safe-external-href";
import type { ChatMessage } from "~/@/hooks/use-chat";
import {
  DirectorTradesTable,
  PeersTable,
  TopShortsTable,
} from "./chat-rich-tables";
import {
  asRecord,
  codeFromArguments,
  numberValue,
  parseDirectorTrades,
  parseEconomicSeries,
  parseJSON,
  parsePeers,
  parseShortPositions,
  parseTopShorts,
  stringValue,
  type DirectorTradesView,
  type EconomicSeriesResult,
  type PeersView,
  type ShortPositionsView,
  type TopShortsView,
} from "./chat-tool-data";
import {
  axisFormatter,
  formatPercent,
  formatWhole,
  latestFormatter,
  readingSummary,
  seriesSubtitle,
  seriesTitle,
  shortPositionSummary,
  valueFormatter,
} from "./chat-tool-format";

type ToolCall = NonNullable<ChatMessage["toolCalls"]>[number];

// The interactive charts are visx, so they load on first use and never sit in
// the eager chat bundle. The placeholder keeps the chart's height.
const ChatLineChart = dynamic(
  () => import("./chat-charts").then((m) => m.ChatLineChart),
  {
    ssr: false,
    loading: () => (
      <div
        aria-hidden="true"
        className="h-[180px] w-full motion-safe:animate-pulse rounded-md bg-muted/40"
      />
    ),
  },
);

interface StockCardData {
  code: string;
  name: string;
  industry?: string;
  summary?: string;
  website?: string;
  shortPercent?: number;
}

/**
 * The colours economic series draw in, in order. Red and green are kept for the
 * direction of a number, and the short-interest rust for short interest.
 */
const ECONOMIC_SERIES_COLORS = [
  seriesColor("price"),
  seriesColor("series", 3),
  seriesColor("series", 4),
  seriesColor("series", 5),
] as const;

/** A tool result drawn as a card, a table or a chart instead of raw JSON. */
export type RichToolResult =
  | { kind: "stock"; stock: StockCardData }
  | { kind: "top-shorts"; view: TopShortsView }
  | { kind: "peers"; view: PeersView }
  | { kind: "director-trades"; view: DirectorTradesView; code?: string }
  | { kind: "short-positions"; view: ShortPositionsView }
  | { kind: "economic-series"; result: EconomicSeriesResult };

/** The rich rendering for a tool call, or null when its output is not one we draw. */
export function getRichToolResult(toolCall: ToolCall): RichToolResult | null {
  switch (toolCall.toolName) {
    case "get_stock_details": {
      const stock = extractStockCard(toolCall);
      return stock ? { kind: "stock", stock } : null;
    }
    case "query_short_positions": {
      const view = parseShortPositions(toolCall.result, toolCall.arguments);
      return view ? { kind: "short-positions", view } : null;
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
    case "get_economic_series": {
      const result = parseEconomicSeries(toolCall.result);
      return result ? { kind: "economic-series", result } : null;
    }
    default:
      return null;
  }
}

export function RichToolResultView({ result }: { result: RichToolResult }) {
  switch (result.kind) {
    case "stock":
      return <StockCard stock={result.stock} />;
    case "top-shorts":
      return <TopShortsTable view={result.view} />;
    case "peers":
      return <PeersTable view={result.view} />;
    case "director-trades":
      return <DirectorTradesTable view={result.view} code={result.code} />;
    case "short-positions":
      return <ShortPositionChart chart={result.view} />;
    case "economic-series":
      return <EconomicSeriesCharts result={result.result} />;
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

/**
 * One stock's short position over time, as an interactive area chart. The
 * header names the stock and its latest reading, and the caption states the
 * readings in words (first, latest, low, high, and how many of the period's
 * readings were shown), which a screen reader reads and the chart describes.
 */
function ShortPositionChart({ chart }: { chart: ShortPositionsView }) {
  const captionId = useId();
  const last = chart.points[chart.points.length - 1];
  const latest = chart.latest ?? last?.v;
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
          {latest !== undefined && <span>{formatPercent(latest)} latest</span>}
          {chart.name && <span>{chart.name}</span>}
        </div>
      </CardHeader>
      <CardContent className="p-3">
        <figure className="m-0 space-y-1.5">
          <ChatLineChart
            label={`${chart.code} short interest`}
            points={chart.points}
            color={seriesColor("short")}
            kind="area"
            formatValue={formatPercent}
            formatAxis={axisFormatter("percent")}
            describedBy={captionId}
          />
          <figcaption id={captionId} className="text-[11px] text-muted-foreground">
            {shortPositionSummary(chart)}
          </figcaption>
        </figure>
      </CardContent>
    </Card>
  );
}

/** Each economic series as its own interactive line chart, up to the parser's cap. */
function EconomicSeriesCharts({ result }: { result: EconomicSeriesResult }) {
  if (result.series.length === 0) {
    return (
      <p className="text-xs text-muted-foreground">No observations to chart.</p>
    );
  }
  return (
    <div className="space-y-2">
      {result.series.map((series, index) => (
        <EconomicSeriesFigure
          key={`${series.key}-${index}`}
          series={series}
          color={ECONOMIC_SERIES_COLORS[index % ECONOMIC_SERIES_COLORS.length]!}
        />
      ))}
      {result.notShown > 0 && (
        <p className="text-[11px] text-muted-foreground">
          {formatWhole(result.notShown)} more series not shown.
        </p>
      )}
    </div>
  );
}

function EconomicSeriesFigure({
  series,
  color,
}: {
  series: EconomicSeriesResult["series"][number];
  color: string;
}) {
  const captionId = useId();
  const title = seriesTitle(series.key, series.name);
  const subtitle = seriesSubtitle(series.unit, series.frequency);
  const format = valueFormatter(series.unit);
  return (
    <figure
      data-testid="chat-economic-chart"
      className="m-0 space-y-1.5 rounded-md border border-border/70 bg-background/80 p-2.5"
    >
      <figcaption id={captionId} className="space-y-0.5">
        <p className="text-xs font-medium">{title}</p>
        {subtitle && (
          <p className="text-[11px] text-muted-foreground">{subtitle}</p>
        )}
        <p className="text-[11px] text-muted-foreground">
          {readingSummary(series.points, format)}
        </p>
      </figcaption>
      <ChatLineChart
        label={title}
        points={series.points}
        color={color}
        formatValue={format}
        formatAxis={axisFormatter(series.unit)}
        formatLatest={latestFormatter(series.unit)}
        describedBy={captionId}
      />
    </figure>
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
