"use client";

import { useState, useCallback } from "react";
import { useRouter } from "next/navigation";
import { DashboardLayout } from "~/@/components/layouts/dashboard-layout";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "~/@/components/ui/card";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "~/@/components/ui/tabs";
import { Badge } from "~/@/components/ui/badge";
import {
  TrendingUp,
  TrendingDown,
  Circle,
  BarChart3,
  Activity,
  Target,
} from "lucide-react";
import { type PlainMessage } from "@bufbuild/protobuf";
import { type TimeSeriesData } from "~/gen/stocks/v1alpha1/stocks_pb";
import {
  type MoversData,
  type TimePeriod,
  PERIOD_LABELS,
  formatPercentage,
  formatChange,
  calculateMovers,
} from "~/@/lib/shorts-calculations";
import { getTopShortsData } from "~/app/actions/getTopShorts";

const LOAD_CHUNK_SIZE = 20;

interface TopShortsClientProps {
  initialMoversData: MoversData;
  initialPeriod: TimePeriod;
}

export function TopShortsClient({
  initialMoversData,
  initialPeriod,
}: TopShortsClientProps) {
  const router = useRouter();
  const [selectedPeriod, setSelectedPeriod] =
    useState<TimePeriod>(initialPeriod);
  const [moversData, setMoversData] = useState<MoversData>(initialMoversData);
  const [sortBy, setSortBy] = useState<"latest" | "change" | "volatility">(
    "latest",
  );
  const [loading, setLoading] = useState(false);

  // Fetch new data when period changes
  const handlePeriodChange = useCallback(async (newPeriod: TimePeriod) => {
    setSelectedPeriod(newPeriod);
    setLoading(true);

    try {
      const data = await getTopShortsData(newPeriod, LOAD_CHUNK_SIZE, 0);
      const movers = calculateMovers(data.timeSeries, newPeriod);
      setMoversData(movers);
    } catch (error) {
      console.error("Error fetching top shorts data:", error);
    } finally {
      setLoading(false);
    }
  }, []);

  const StockCard = ({
    stock,
    type,
  }: {
    stock: PlainMessage<TimeSeriesData> & {
      change?: number;
      volatility?: number;
    };
    type: "gainer" | "loser" | "volatile";
  }) => {
    const getChangeColor = () => {
      if (type === "gainer") return "text-red-600";
      if (type === "loser") return "text-green-600";
      return "text-blue-600";
    };

    const getChangeIcon = () => {
      if (type === "gainer") return <TrendingUp className="h-4 w-4" />;
      if (type === "loser") return <TrendingDown className="h-4 w-4" />;
      return <Activity className="h-4 w-4" />;
    };

    const getChangeLabel = () => {
      if (type === "gainer") return "Short Position Increase";
      if (type === "loser") return "Short Position Decrease";
      return "Volatility Range";
    };

    const getChangeValue = () => {
      if (type === "volatile") return formatPercentage(stock.volatility ?? 0);
      return formatChange(stock.change ?? 0);
    };

    return (
      <Card
        className="cursor-pointer hover:shadow-md transition-shadow"
        onClick={() => router.push(`/shorts/${stock.productCode}`)}
      >
        <CardHeader className="pb-3">
          <div className="flex items-center justify-between">
            <div>
              <CardTitle className="text-lg">{stock.productCode}</CardTitle>
              <CardDescription className="text-sm">
                {stock.name}
              </CardDescription>
            </div>
            <Badge variant="outline" className="flex items-center gap-1">
              {getChangeIcon()}
              <span className={getChangeColor()}>{getChangeValue()}</span>
            </Badge>
          </div>
        </CardHeader>
        <CardContent className="pt-0">
          <div className="space-y-2">
            <div className="flex justify-between items-center">
              <span className="text-sm text-muted-foreground">
                Current Short Position
              </span>
              <span className="font-semibold">
                {formatPercentage(stock.latestShortPosition ?? 0)}
              </span>
            </div>
            <div className="flex justify-between items-center">
              <span className="text-sm text-muted-foreground">Range</span>
              <div className="flex items-center gap-2">
                <div className="flex items-center gap-1">
                  <Circle className="h-3 w-3 fill-green-500" />
                  <span className="text-xs">
                    {(() => {
                      if (!stock.points || stock.points.length === 0)
                        return "0.00%";
                      const positions = stock.points.map(
                        (point) => point.shortPosition,
                      );
                      const minPosition = Math.min(...positions);
                      return formatPercentage(minPosition);
                    })()}
                  </span>
                </div>
                <span className="text-xs text-muted-foreground">-</span>
                <div className="flex items-center gap-1">
                  <Circle className="h-3 w-3 fill-red-500" />
                  <span className="text-xs">
                    {(() => {
                      if (!stock.points || stock.points.length === 0)
                        return "0.00%";
                      const positions = stock.points.map(
                        (point) => point.shortPosition,
                      );
                      const maxPosition = Math.max(...positions);
                      return formatPercentage(maxPosition);
                    })()}
                  </span>
                </div>
              </div>
            </div>
            <div className="flex justify-between items-center">
              <span className="text-sm text-muted-foreground">
                {getChangeLabel()}
              </span>
              <span className={`text-sm font-medium ${getChangeColor()}`}>
                {getChangeValue()}
              </span>
            </div>
          </div>
        </CardContent>
      </Card>
    );
  };

  return (
    <DashboardLayout>
      <div className="space-y-6">
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-3xl font-bold">Top Shorts</h1>
            <p className="text-muted-foreground mt-2">
              Biggest movers in short positions across different time periods
            </p>
          </div>
          <div className="flex items-center gap-2">
            <Tabs
              value={selectedPeriod}
              onValueChange={(v) => handlePeriodChange(v as TimePeriod)}
            >
              <TabsList>
                <TabsTrigger value="1m" disabled={loading}>
                  1M
                </TabsTrigger>
                <TabsTrigger value="3m" disabled={loading}>
                  3M
                </TabsTrigger>
                <TabsTrigger value="6m" disabled={loading}>
                  6M
                </TabsTrigger>
                <TabsTrigger value="1y" disabled={loading}>
                  1Y
                </TabsTrigger>
              </TabsList>
            </Tabs>
          </div>
        </div>

        <Tabs
          value={sortBy}
          onValueChange={(v) => setSortBy(v as typeof sortBy)}
          className="w-full"
        >
          <TabsList className="grid w-full grid-cols-3">
            <TabsTrigger value="latest" className="flex items-center gap-2">
              <Target className="h-4 w-4" />
              Current Positions
            </TabsTrigger>
            <TabsTrigger value="change" className="flex items-center gap-2">
              <TrendingUp className="h-4 w-4" />
              Biggest Movers
            </TabsTrigger>
            <TabsTrigger value="volatility" className="flex items-center gap-2">
              <BarChart3 className="h-4 w-4" />
              Most Volatile
            </TabsTrigger>
          </TabsList>

          <TabsContent value="latest" className="space-y-4">
            <div className="flex items-center justify-between">
              <h2 className="text-xl font-semibold">
                Current Top Short Positions
              </h2>
              <Badge variant="outline">{PERIOD_LABELS[selectedPeriod]}</Badge>
            </div>
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
              {moversData.biggestGainers.slice(0, 9).map((stock, index) => (
                <div key={stock.productCode} className="relative">
                  <div className="absolute -top-2 -left-2 bg-primary text-primary-foreground rounded-full w-6 h-6 flex items-center justify-center text-xs font-bold">
                    {index + 1}
                  </div>
                  <StockCard stock={stock} type="gainer" />
                </div>
              ))}
            </div>
          </TabsContent>

          <TabsContent value="change" className="space-y-4">
            <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
              <div>
                <div className="flex items-center justify-between mb-4">
                  <h2 className="text-xl font-semibold flex items-center gap-2">
                    <TrendingUp className="h-5 w-5 text-red-600" />
                    Biggest Increases
                  </h2>
                  <Badge variant="outline">
                    {PERIOD_LABELS[selectedPeriod]}
                  </Badge>
                </div>
                <div className="space-y-3">
                  {moversData.biggestGainers.map((stock, index) => (
                    <div key={stock.productCode} className="relative">
                      <div className="absolute -top-1 -left-1 bg-red-100 text-red-800 rounded-full w-5 h-5 flex items-center justify-center text-xs font-bold">
                        {index + 1}
                      </div>
                      <StockCard stock={stock} type="gainer" />
                    </div>
                  ))}
                </div>
              </div>

              <div>
                <div className="flex items-center justify-between mb-4">
                  <h2 className="text-xl font-semibold flex items-center gap-2">
                    <TrendingDown className="h-5 w-5 text-green-600" />
                    Biggest Decreases
                  </h2>
                  <Badge variant="outline">
                    {PERIOD_LABELS[selectedPeriod]}
                  </Badge>
                </div>
                <div className="space-y-3">
                  {moversData.biggestLosers.map((stock, index) => (
                    <div key={stock.productCode} className="relative">
                      <div className="absolute -top-1 -left-1 bg-green-100 text-green-800 rounded-full w-5 h-5 flex items-center justify-center text-xs font-bold">
                        {index + 1}
                      </div>
                      <StockCard stock={stock} type="loser" />
                    </div>
                  ))}
                </div>
              </div>
            </div>
          </TabsContent>

          <TabsContent value="volatility" className="space-y-4">
            <div className="flex items-center justify-between">
              <h2 className="text-xl font-semibold flex items-center gap-2">
                <BarChart3 className="h-5 w-5 text-blue-600" />
                Most Volatile Short Positions
              </h2>
              <Badge variant="outline">{PERIOD_LABELS[selectedPeriod]}</Badge>
            </div>
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
              {moversData.mostVolatile.map((stock, index) => (
                <div key={stock.productCode} className="relative">
                  <div className="absolute -top-2 -left-2 bg-blue-100 text-blue-800 rounded-full w-6 h-6 flex items-center justify-center text-xs font-bold">
                    {index + 1}
                  </div>
                  <StockCard stock={stock} type="volatile" />
                </div>
              ))}
            </div>
          </TabsContent>
        </Tabs>
      </div>
    </DashboardLayout>
  );
}
