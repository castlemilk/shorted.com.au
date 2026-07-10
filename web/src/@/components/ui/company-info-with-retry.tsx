"use client";

import { type StockDetails } from "~/gen/stocks/v1alpha1/stocks_pb";
import { useClientRetry } from "@/hooks/use-client-retry";
import { fetchStockDetailsClient } from "~/app/actions/client/getStockDetails";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "./card";
import {
  Building2Icon,
  RefreshCwIcon,
  AlertCircleIcon,
} from "lucide-react";
import { Separator } from "./separator";
import { Button } from "./button";
import { CompanyInfoSkeleton, CompanyInfoView } from "./company-info-view";

interface CompanyInfoClientProps {
  stockCode: string;
  /** Initial data from SSR attempt (null if SSR failed) */
  initialData: StockDetails | null;
}

/**
 * Client component that handles retry when SSR data is unavailable.
 * Shows loading state during retry and allows manual retry.
 * Content and loading markup are shared with the server component via
 * company-info-view.tsx; only the retry plumbing and the bespoke
 * error/no-data cards live here.
 */
export function CompanyInfoWithRetry({ stockCode, initialData }: CompanyInfoClientProps) {
  const { data, isLoading, error, retry, isRetrying } = useClientRetry(
    () => fetchStockDetailsClient(stockCode),
    {
      initialData,
      // Only fetch on mount if SSR data wasn't available
      fetchOnMount: !initialData,
      maxRetries: 3,
      initialDelayMs: 1000,
      maxDelayMs: 8000,
    }
  );

  // Loading state
  if (isLoading || isRetrying) {
    return <CompanyInfoSkeleton isRetrying={isRetrying} />;
  }

  // Error state with retry button
  if (error && !data) {
    return <CompanyInfoError onRetry={retry} stockCode={stockCode} />;
  }

  // No data available
  if (!data) {
    return (
      <Card className="sm:col-span-4">
        <CardHeader className="pb-3">
          <CardTitle className="text-lg flex items-center gap-2"><Building2Icon className="h-5 w-5" />About</CardTitle>
          <Separator />
          <CardContent className="p-0 pt-4">
            <p className="text-sm text-muted-foreground">
              Company information not available
            </p>
            <Button
              variant="ghost"
              size="sm"
              onClick={retry}
              className="mt-2"
            >
              <RefreshCwIcon className="mr-2 h-4 w-4" />
              Try again
            </Button>
          </CardContent>
        </CardHeader>
      </Card>
    );
  }

  // Render full company info
  return <CompanyInfoView stockDetails={data} />;
}

function CompanyInfoError({ onRetry, stockCode }: { onRetry: () => void; stockCode: string }) {
  return (
    <Card className="sm:col-span-4 border-amber-200 dark:border-amber-800">
      <CardHeader className="pb-3">
        <CardTitle className="text-lg flex items-center gap-2">
          <AlertCircleIcon className="h-5 w-5 text-amber-500" />
          About
        </CardTitle>
        <Separator />
        <CardContent className="p-0 pt-4">
          <p className="text-sm text-muted-foreground mb-3">
            Failed to load company information for {stockCode}.
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

export default CompanyInfoWithRetry;
