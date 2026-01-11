"use client";

import { formatNumber } from "~/@/lib/utils";
import { type Stock } from "~/gen/stocks/v1alpha1/stocks_pb";
import { useClientRetry } from "@/hooks/use-client-retry";
import { fetchStockClient } from "~/app/actions/client/getStockDetails";
import { Card, CardHeader, CardTitle, CardContent } from "./card";
import { Separator } from "./separator";
import { Skeleton } from "./skeleton";
import { Button } from "./button";
import { RefreshCwIcon, AlertCircleIcon } from "lucide-react";

interface CompanyStatsClientProps {
  stockCode: string;
  initialData: Stock | null;
}

export function CompanyStatsWithRetry({ stockCode, initialData }: CompanyStatsClientProps) {
  const { data, isLoading, error, retry, isRetrying } = useClientRetry(
    () => fetchStockClient(stockCode),
    {
      initialData,
      fetchOnMount: !initialData,
      maxRetries: 3,
      initialDelayMs: 1000,
      maxDelayMs: 8000,
    }
  );

  if (isLoading || isRetrying) {
    return <CompanyStatsLoading isRetrying={isRetrying} />;
  }

  if (error && !data) {
    return <CompanyStatsError onRetry={retry} />;
  }

  if (!data) {
    return (
      <Card className="sm:col-span-4">
        <CardHeader className="pb-3">
          <CardTitle className="flex">Shorted</CardTitle>
          <Separator />
          <CardContent className="p-0 pt-4">
            <p className="text-sm text-muted-foreground">
              Stock statistics not available
            </p>
            <Button variant="ghost" size="sm" onClick={retry} className="mt-2">
              <RefreshCwIcon className="mr-2 h-4 w-4" />
              Try again
            </Button>
          </CardContent>
        </CardHeader>
      </Card>
    );
  }

  return <CompanyStatsContent stock={data} />;
}

function CompanyStatsLoading({ isRetrying }: { isRetrying?: boolean }) {
  return (
    <Card className="sm:col-span-4">
      <CardHeader className="pb-3">
        <CardTitle className="flex items-center gap-2">
          Shorted
          {isRetrying && <RefreshCwIcon className="h-4 w-4 animate-spin text-muted-foreground" />}
        </CardTitle>
        <Separator />
        <CardContent className="p-0 text-xs space-y-2 pt-2">
          <Skeleton className="w-full h-[20px]" />
          <Skeleton className="w-full h-[20px]" />
          <Skeleton className="w-full h-[20px]" />
        </CardContent>
      </CardHeader>
    </Card>
  );
}

function CompanyStatsError({ onRetry }: { onRetry: () => void }) {
  return (
    <Card className="sm:col-span-4 border-amber-200 dark:border-amber-800">
      <CardHeader className="pb-3">
        <CardTitle className="flex items-center gap-2">
          <AlertCircleIcon className="h-5 w-5 text-amber-500" />
          Shorted
        </CardTitle>
        <Separator />
        <CardContent className="p-0 pt-4">
          <p className="text-sm text-muted-foreground mb-2">
            Failed to load statistics
          </p>
          <Button 
            variant="outline" 
            size="sm" 
            onClick={onRetry}
            className="border-amber-300 hover:bg-amber-50 dark:border-amber-700 dark:hover:bg-amber-950"
          >
            <RefreshCwIcon className="mr-2 h-4 w-4" />
            Retry
          </Button>
        </CardContent>
      </CardHeader>
    </Card>
  );
}

function CompanyStatsContent({ stock }: { stock: Stock }) {
  return (
    <Card className="h-full">
      <CardHeader className="pb-3 h-full flex flex-col">
        <CardTitle className="flex">Shorted</CardTitle>
        <Separator className="my-2" />
        <div className="flex-1 flex flex-col justify-between py-1">
          <CardContent className="p-0 text-xs">
            <div className="flex align-middle justify-between">
              <span className="flex justify-center uppercase font-semibold text-muted-foreground">
                short percentage
              </span>
              <span className="flex items-center font-bold text-sm">
                {stock.percentageShorted.toFixed(2)}%
              </span>
            </div>
          </CardContent>
          <Separator className="my-2 opacity-50" />
          <CardContent className="p-0 text-xs">
            <div className="flex align-middle justify-between">
              <span className="uppercase font-semibold text-muted-foreground">
                reported shorts
              </span>
              <span className="font-medium">{formatNumber(stock.reportedShortPositions)}</span>
            </div>
          </CardContent>
          <Separator className="my-2 opacity-50" />
          <CardContent className="p-0 text-xs">
            <div className="flex align-middle justify-between">
              <span className="uppercase font-semibold text-muted-foreground">
                shares on issue
              </span>
              <span className="font-medium">{formatNumber(stock.totalProductInIssue, 3)}</span>
            </div>
          </CardContent>
        </div>
      </CardHeader>
    </Card>
  );
}

export default CompanyStatsWithRetry;
