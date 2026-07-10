"use client";

import { type Stock } from "~/gen/stocks/v1alpha1/stocks_pb";
import { useClientRetry } from "@/hooks/use-client-retry";
import { fetchStockClient } from "~/app/actions/client/getStockDetails";
import { Card, CardHeader, CardTitle, CardContent } from "./card";
import { Button } from "./button";
import { RefreshCwIcon, AlertCircleIcon, TrendingDown } from "lucide-react";
import { CompanyStatsSkeleton, CompanyStatsView } from "./company-stats-view";

interface CompanyStatsClientProps {
  stockCode: string;
  initialData: Stock | null;
}

/**
 * Client component that handles retry when SSR data is unavailable.
 * Content and loading markup are shared with the server component via
 * company-stats-view.tsx; only the retry plumbing and the bespoke
 * error/no-data cards live here.
 */
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
    return <CompanyStatsSkeleton isRetrying={isRetrying} />;
  }

  if (error && !data) {
    return <CompanyStatsError onRetry={retry} />;
  }

  if (!data) {
    return (
      <Card className="sm:col-span-4">
        <CardHeader className="pb-3">
          <CardTitle className="text-lg flex items-center gap-2">
            <TrendingDown className="h-5 w-5" />
            Short position
          </CardTitle>
        </CardHeader>
        <CardContent>
          <p className="text-sm text-muted-foreground">
            Stock statistics not available
          </p>
          <Button variant="ghost" size="sm" onClick={retry} className="mt-2">
            <RefreshCwIcon className="mr-2 h-4 w-4" />
            Try again
          </Button>
        </CardContent>
      </Card>
    );
  }

  return <CompanyStatsView stock={data} />;
}

function CompanyStatsError({ onRetry }: { onRetry: () => void }) {
  return (
    <Card className="sm:col-span-4 border-amber-200 dark:border-amber-800">
      <CardHeader className="pb-3">
        <CardTitle className="text-lg flex items-center gap-2">
          <AlertCircleIcon className="h-5 w-5 text-amber-500" />
          Short position
        </CardTitle>
      </CardHeader>
      <CardContent>
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
    </Card>
  );
}

export default CompanyStatsWithRetry;
