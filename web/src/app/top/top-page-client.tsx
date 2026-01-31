"use client";

import { useState, useCallback, useMemo } from "react";
import Link from "next/link";
import {
  TrendingUp,
  TrendingDown,
  BarChart3,
  Zap,
  ArrowUpRight,
  ArrowDownRight,
  Minus,
  ChevronRight,
  Search,
  Clock,
  AlertTriangle,
} from "lucide-react";
import {
  type TimePeriod,
  PERIOD_LABELS,
  formatPercentage,
  formatChange,
} from "~/@/lib/shorts-calculations";
import {
  getTopPageDataForPeriod,
  type SerializedTimeSeriesData,
  type SerializedMoversData,
} from "../actions/top/getTopPageData";
import { cn } from "~/@/lib/utils";
import { Badge } from "~/@/components/ui/badge";
import { Input } from "~/@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "~/@/components/ui/select";
import { MiniSparkline } from "./components/mini-sparkline";
import { SentimentGauge } from "./components/sentiment-gauge";
import { MoversCard } from "./components/movers-card";
import { IndustryBreakdown } from "./components/industry-breakdown";
import dynamic from "next/dynamic";
import { Map } from "lucide-react";
import { Skeleton } from "~/@/components/ui/skeleton";

// Dynamic import the treemap to reduce initial bundle
const IndustryTreeMapView = dynamic(
  () => import("../treemap/treeMap").then((mod) => mod.IndustryTreeMapView),
  {
    loading: () => (
      <div className="rounded-lg border border-border/60 bg-card/50 p-6">
        <Skeleton className="h-[400px] w-full rounded-xl" />
      </div>
    ),
    ssr: false,
  }
);

interface TopPageClientProps {
  initialData: SerializedTimeSeriesData[];
  initialMoversData: SerializedMoversData;
  initialPeriod: TimePeriod;
}

export function TopPageClient({
  initialData,
  initialMoversData,
  initialPeriod,
}: TopPageClientProps) {
  const [data, setData] = useState<SerializedTimeSeriesData[]>(initialData);
  const [moversData, setMoversData] = useState<SerializedMoversData>(initialMoversData);
  const [period, setPeriod] = useState<TimePeriod>(initialPeriod);
  const [searchQuery, setSearchQuery] = useState("");
  const [isLoading, setIsLoading] = useState(false);

  // Calculate market stats
  const marketStats = useMemo(() => {
    if (!data.length) return null;

    const avgShortPosition =
      data.reduce((sum, d) => sum + (d.latestShortPosition ?? 0), 0) / data.length;
    const highlyShorted = data.filter((d) => (d.latestShortPosition ?? 0) > 10).length;
    const totalStocks = data.length;
    const topShortPosition = data[0]?.latestShortPosition ?? 0;

    // Calculate market sentiment (inverse of avg short position, normalized)
    const sentiment = Math.max(0, Math.min(100, 100 - avgShortPosition * 5));

    return {
      avgShortPosition,
      highlyShorted,
      totalStocks,
      topShortPosition,
      sentiment,
    };
  }, [data]);

  // Filter data based on search
  const filteredData = useMemo(() => {
    if (!searchQuery.trim()) return data;
    const query = searchQuery.toLowerCase();
    return data.filter(
      (d) =>
        d.productCode?.toLowerCase().includes(query) ||
        d.name?.toLowerCase().includes(query)
    );
  }, [data, searchQuery]);

  // Handle period change - uses cached server action
  const handlePeriodChange = useCallback(async (newPeriod: TimePeriod) => {
    setPeriod(newPeriod);
    setIsLoading(true);
    try {
      // Uses Redis-cached server action for fast response
      const pageData = await getTopPageDataForPeriod(newPeriod);
      setData(pageData.timeSeries);
      setMoversData(pageData.movers);
    } catch (error) {
      console.error("Failed to fetch data:", error);
    } finally {
      setIsLoading(false);
    }
  }, []);

  // Get rank change indicator
  const getRankChange = (item: SerializedTimeSeriesData) => {
    const points = item.points ?? [];
    if (points.length < 2) return 0;
    const oldPosition = points[0]?.shortPosition ?? 0;
    const newPosition = item.latestShortPosition ?? 0;
    if (newPosition > oldPosition) return 1;
    if (newPosition < oldPosition) return -1;
    return 0;
  };

  return (
    <div className="relative">
      {/* Hero Section */}
      <section className="relative border-b border-border/40 overflow-hidden" aria-labelledby="hero-title">
        {/* Background gradient effects */}
        <div className="absolute inset-0 bg-gradient-to-br from-red-950/20 via-background to-background" />
        <div className="absolute top-0 right-0 w-[600px] h-[600px] bg-red-500/5 rounded-full blur-3xl -translate-y-1/2 translate-x-1/2" />

        <div className="container mx-auto px-4 py-12 md:py-16 relative z-10">
          {/* Title */}
          <div className="animate-fade-in">
            <div className="flex items-center gap-3 mb-4">
              <div className="h-10 w-1 bg-gradient-to-b from-red-500 to-orange-500 rounded-full" />
              <h1 id="hero-title" className="text-3xl md:text-4xl lg:text-5xl font-bold tracking-tight">
                Top 100 Most Shorted
              </h1>
            </div>
            <p className="text-muted-foreground text-lg max-w-2xl mb-2">
              Live rankings of the most shorted stocks on the ASX, updated daily from
              official ASIC data.
            </p>
            <div className="flex items-center gap-2 text-sm text-muted-foreground">
              <Clock className="h-3.5 w-3.5" aria-hidden="true" />
              <span>Data delayed T+4 trading days</span>
              <span aria-hidden="true">•</span>
              <span>Source: ASIC</span>
            </div>
          </div>

          {/* Stats Grid */}
          <div className="grid grid-cols-2 lg:grid-cols-4 gap-4 mt-8 animate-fade-in-delay">
            {/* Market Sentiment */}
            <div className="col-span-2 lg:col-span-1 row-span-2 lg:row-span-1">
              <SentimentGauge value={marketStats?.sentiment ?? 50} />
            </div>

            {/* Top Short Position */}
            <StatCard
              label="Highest Short %"
              value={formatPercentage(marketStats?.topShortPosition ?? 0)}
              icon={<TrendingDown className="h-4 w-4" />}
              color="red"
              subtext={data[0]?.productCode}
            />

            {/* Avg Short Position */}
            <StatCard
              label="Average Short %"
              value={formatPercentage(marketStats?.avgShortPosition ?? 0)}
              icon={<BarChart3 className="h-4 w-4" />}
              color="orange"
              subtext="Across top 100"
            />

            {/* Highly Shorted Count */}
            <StatCard
              label="Highly Shorted"
              value={`${marketStats?.highlyShorted ?? 0}`}
              icon={<AlertTriangle className="h-4 w-4" />}
              color="yellow"
              subtext="Above 10%"
            />
          </div>
        </div>
      </section>

      {/* Movers Section */}
      <section className="border-b border-border/40 bg-muted/30" aria-labelledby="movers-title">
        <div className="container mx-auto px-4 py-8">
          <div className="flex items-center justify-between mb-6">
            <div className="flex items-center gap-3">
              <Zap className="h-5 w-5 text-yellow-500" aria-hidden="true" />
              <h2 id="movers-title" className="text-xl font-semibold">Big Movers</h2>
              <Badge variant="secondary" className="text-xs">
                {PERIOD_LABELS[period]}
              </Badge>
            </div>
            <Select value={period} onValueChange={(v) => handlePeriodChange(v as TimePeriod)}>
              <SelectTrigger className="w-32" aria-label="Select time period for analysis">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="1m">1 Month</SelectItem>
                <SelectItem value="3m">3 Months</SelectItem>
                <SelectItem value="6m">6 Months</SelectItem>
                <SelectItem value="1y">1 Year</SelectItem>
              </SelectContent>
            </Select>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
            <MoversCard
              title="Rising Bears"
              subtitle="Biggest increases in short interest"
              items={moversData.biggestGainers.slice(0, 5)}
              type="gainers"
              isLoading={isLoading}
            />
            <MoversCard
              title="Covering Up"
              subtitle="Biggest decreases in short interest"
              items={moversData.biggestLosers.slice(0, 5)}
              type="losers"
              isLoading={isLoading}
            />
            <MoversCard
              title="Wild Swings"
              subtitle="Most volatile short positions"
              items={moversData.mostVolatile.slice(0, 5)}
              type="volatile"
              isLoading={isLoading}
            />
          </div>
        </div>
      </section>

      {/* Industry Breakdown */}
      <section className="border-b border-border/40" aria-label="Industry Breakdown">
        <div className="container mx-auto px-4 py-8">
          <IndustryBreakdown data={data} />
        </div>
      </section>

      {/* Industry Treemap Visualization */}
      <section className="border-b border-border/40 bg-muted/20" aria-labelledby="treemap-title">
        <div className="container mx-auto px-4 py-8">
          <div className="flex items-center gap-3 mb-6">
            <Map className="h-5 w-5 text-primary" aria-hidden="true" />
            <h2 id="treemap-title" className="text-xl font-semibold">Short Position Heatmap</h2>
            <Badge variant="secondary" className="text-xs">
              Interactive
            </Badge>
          </div>
          <p className="text-sm text-muted-foreground mb-4">
            Visual representation of short positions by industry. Larger tiles indicate higher short interest.
            Click any stock to view detailed analysis.
          </p>
          <div className="rounded-xl overflow-hidden border border-border/60">
            <IndustryTreeMapView
              initialPeriod={period}
              className="m-0 border-0"
            />
          </div>
        </div>
      </section>

      {/* Main Table Section */}
      <section className="container mx-auto px-4 py-8" aria-labelledby="rankings-title">
        {/* Table Controls */}
        <div className="flex flex-col md:flex-row md:items-center justify-between gap-4 mb-6">
          <h2 id="rankings-title" className="text-xl font-semibold">Full Rankings</h2>
          <div className="relative">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" aria-hidden="true" />
            <Input
              placeholder="Search by code or name..."
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              className="pl-9 w-64"
              aria-label="Search stocks by code or company name"
              type="search"
              autoComplete="off"
            />
          </div>
        </div>

        {/* Table */}
        <div className="rounded-lg border border-border/60 overflow-hidden bg-card/50 backdrop-blur-sm">
          {/* Header */}
          <div
            className="grid grid-cols-[60px_1fr_100px_100px_48px] md:grid-cols-[60px_1fr_120px_120px_160px_48px] gap-4 px-4 py-3 bg-muted/50 border-b border-border/60 text-xs font-medium text-muted-foreground uppercase tracking-wider"
            aria-hidden="true"
          >
            <div className="text-center">Rank</div>
            <div>Stock</div>
            <div className="text-right">Short %</div>
            <div className="text-right">Change</div>
            <div className="hidden md:block text-center">30D Trend</div>
            <div></div>
          </div>

          {/* Rows */}
          <div className="divide-y divide-border/40">
            {filteredData.map((item, index) => {
              const rankChange = getRankChange(item);
              const points = item.points ?? [];
              const change =
                points.length >= 2
                  ? (item.latestShortPosition ?? 0) - (points[0]?.shortPosition ?? 0)
                  : 0;

              return (
                <Link
                  key={item.productCode}
                  href={`/shorts/${item.productCode}`}
                  className="grid grid-cols-[60px_1fr_100px_100px_48px] md:grid-cols-[60px_1fr_120px_120px_160px_48px] gap-4 px-4 py-4 items-center hover:bg-muted/50 transition-colors group"
                >
                  {/* Rank */}
                  <div className="flex items-center justify-center gap-1">
                    <span
                      className={cn(
                        "text-lg font-bold tabular-nums",
                        index < 3 && "text-red-500",
                        index >= 3 && index < 10 && "text-orange-500",
                        index >= 10 && "text-foreground/70"
                      )}
                    >
                      {index + 1}
                    </span>
                    {rankChange !== 0 && (
                      <span
                        className={cn(
                          "text-xs",
                          rankChange > 0 && "text-red-500",
                          rankChange < 0 && "text-green-500"
                        )}
                      >
                        {rankChange > 0 ? (
                          <>
                            <ArrowUpRight className="h-3 w-3" aria-hidden="true" />
                            <span className="sr-only">Short interest increasing</span>
                          </>
                        ) : (
                          <>
                            <ArrowDownRight className="h-3 w-3" aria-hidden="true" />
                            <span className="sr-only">Short interest decreasing</span>
                          </>
                        )}
                      </span>
                    )}
                  </div>

                  {/* Stock Info */}
                  <div className="min-w-0">
                    <div className="font-semibold text-foreground group-hover:text-primary transition-colors">
                      {item.productCode}
                    </div>
                    <div className="text-xs text-muted-foreground truncate">
                      {item.name}
                    </div>
                  </div>

                  {/* Short % with heat color */}
                  <div className="text-right">
                    <ShortPercentageCell value={item.latestShortPosition ?? 0} />
                  </div>

                  {/* Change */}
                  <div className="text-right">
                    <span
                      className={cn(
                        "inline-flex items-center gap-1 text-sm font-medium tabular-nums",
                        change > 0 && "text-red-500",
                        change < 0 && "text-green-500",
                        change === 0 && "text-foreground/70"
                      )}
                    >
                      {change > 0 ? (
                        <TrendingUp className="h-3 w-3" aria-hidden="true" />
                      ) : change < 0 ? (
                        <TrendingDown className="h-3 w-3" aria-hidden="true" />
                      ) : (
                        <Minus className="h-3 w-3" aria-hidden="true" />
                      )}
                      <span aria-label={`Change: ${change > 0 ? "increased" : change < 0 ? "decreased" : "unchanged"} ${formatChange(change)}`}>
                        {formatChange(change)}
                      </span>
                    </span>
                  </div>

                  {/* Sparkline */}
                  <div className="hidden md:block">
                    {points.length > 0 && (
                      <MiniSparkline data={item} height={32} />
                    )}
                  </div>

                  {/* Arrow */}
                  <div className="flex justify-end">
                    <ChevronRight className="h-4 w-4 text-muted-foreground group-hover:text-foreground transition-colors" />
                  </div>
                </Link>
              );
            })}
          </div>
        </div>

        {filteredData.length === 0 && (
          <div className="text-center py-12 text-muted-foreground">
            No stocks found matching &quot;{searchQuery}&quot;
          </div>
        )}
      </section>

      {/* Loading overlay */}
      {isLoading && (
        <div className="fixed inset-0 bg-background/80 backdrop-blur-sm z-50 flex items-center justify-center animate-fade-in">
          <div className="flex flex-col items-center gap-4">
            <div className="h-8 w-8 border-2 border-primary border-t-transparent rounded-full animate-spin" />
            <p className="text-sm text-muted-foreground">Updating data...</p>
          </div>
        </div>
      )}
    </div>
  );
}

// Stat Card Component
function StatCard({
  label,
  value,
  icon,
  color,
  subtext,
}: {
  label: string;
  value: string;
  icon: React.ReactNode;
  color: "red" | "orange" | "yellow" | "green";
  subtext?: string;
}) {
  const colorClasses = {
    red: "from-red-500/20 to-red-500/5 border-red-500/30 text-red-500",
    orange: "from-orange-500/20 to-orange-500/5 border-orange-500/30 text-orange-500",
    yellow: "from-yellow-500/20 to-yellow-500/5 border-yellow-500/30 text-yellow-500",
    green: "from-green-500/20 to-green-500/5 border-green-500/30 text-green-500",
  };

  return (
    <div
      className={cn(
        "rounded-lg border bg-gradient-to-br p-4 backdrop-blur-sm",
        colorClasses[color]
      )}
    >
      <div className="flex items-center gap-2 text-xs text-muted-foreground mb-2">
        {icon}
        <span>{label}</span>
      </div>
      <div className="text-2xl font-bold tabular-nums">{value}</div>
      {subtext && (
        <div className="text-xs text-muted-foreground mt-1">{subtext}</div>
      )}
    </div>
  );
}

// Short Percentage Cell with heat color - WCAG AA compliant contrast
function ShortPercentageCell({ value }: { value: number }) {
  const getHeatColor = (pct: number) => {
    if (pct >= 20) return "bg-red-600 text-white border-red-700";
    if (pct >= 15) return "bg-red-500 text-white border-red-600";
    if (pct >= 10) return "bg-orange-500 text-white border-orange-600";
    if (pct >= 5) return "bg-yellow-500 text-black border-yellow-600";
    return "bg-muted text-foreground border-border";
  };

  return (
    <span
      className={cn(
        "inline-block px-2 py-1 rounded text-sm font-semibold tabular-nums border",
        getHeatColor(value)
      )}
    >
      {formatPercentage(value)}
    </span>
  );
}
