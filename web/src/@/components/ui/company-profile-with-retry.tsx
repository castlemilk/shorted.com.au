"use client";

import { type StockDetails } from "~/gen/stocks/v1alpha1/stocks_pb";
import { useClientRetry } from "@/hooks/use-client-retry";
import { fetchStockDetailsClient } from "~/app/actions/client/getStockDetails";
import { Card, CardHeader, CardDescription } from "./card";
import { RefreshCwIcon, AlertCircleIcon } from "lucide-react";
import { Button } from "./button";
import {
  CompanyProfileSkeleton,
  CompanyProfileView,
} from "./company-profile-view";

interface CompanyProfileClientProps {
  stockCode: string;
  /** Initial data from SSR attempt (null if SSR failed) */
  initialData: StockDetails | null;
}

/**
 * Client component that handles retry when SSR data is unavailable.
 * Content and loading markup are shared with the server component via
 * company-profile-view.tsx; only the retry plumbing and the bespoke
 * error/no-data cards live here.
 */
export function CompanyProfileWithRetry({ stockCode, initialData }: CompanyProfileClientProps) {
  const { data, isLoading, error, retry, isRetrying } = useClientRetry(
    () => fetchStockDetailsClient(stockCode),
    {
      initialData,
      fetchOnMount: !initialData,
      maxRetries: 3,
      initialDelayMs: 1000,
      maxDelayMs: 8000,
    }
  );

  // Loading state
  if (isLoading || isRetrying) {
    return <CompanyProfileSkeleton isRetrying={isRetrying} />;
  }

  // Error state with retry button
  if (error && !data) {
    return <CompanyProfileError onRetry={retry} stockCode={stockCode} />;
  }

  // No data available
  if (!data) {
    return (
      <Card className="sm:col-span-4">
        <CardHeader className="pb-3">
          <div className="flex text-lg font-semibold leading-none tracking-tight">{stockCode}</div>
          <CardDescription className="flex text-xs">
            Company profile not available
          </CardDescription>
          <Button
            variant="ghost"
            size="sm"
            onClick={retry}
            className="mt-2 w-fit"
          >
            <RefreshCwIcon className="mr-2 h-4 w-4" />
            Try again
          </Button>
        </CardHeader>
      </Card>
    );
  }

  return <CompanyProfileView stockCode={stockCode} stockDetails={data} />;
}

function CompanyProfileError({ onRetry, stockCode }: { onRetry: () => void; stockCode: string }) {
  return (
    <Card className="sm:col-span-4 border-amber-200 dark:border-amber-800">
      <CardHeader className="pb-3">
        <div className="flex items-center gap-2 text-lg font-semibold leading-none tracking-tight">
          <AlertCircleIcon className="h-5 w-5 text-amber-500" />
          {stockCode}
        </div>
        <CardDescription className="flex text-xs text-amber-600 dark:text-amber-400">
          Failed to load company profile
        </CardDescription>
        <Button
          variant="outline"
          size="sm"
          onClick={onRetry}
          className="mt-2 w-fit border-amber-300 hover:bg-amber-50 dark:border-amber-700 dark:hover:bg-amber-950"
        >
          <RefreshCwIcon className="mr-2 h-4 w-4" />
          Retry
        </Button>
      </CardHeader>
    </Card>
  );
}

export default CompanyProfileWithRetry;
