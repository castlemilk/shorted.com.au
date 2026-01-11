"use client";

import { type StockDetails } from "~/gen/stocks/v1alpha1/stocks_pb";
import { useClientRetry } from "@/hooks/use-client-retry";
import { fetchStockDetailsClient } from "~/app/actions/client/getStockDetails";
import { Card, CardHeader, CardTitle, CardDescription } from "./card";
import { Badge } from "./badge";
import { Skeleton } from "./skeleton";
import { Sparkles, RefreshCwIcon, AlertCircleIcon } from "lucide-react";
import { CompanyLogo } from "./company-logo";
import { Button } from "./button";

interface CompanyProfileClientProps {
  stockCode: string;
  /** Initial data from SSR attempt (null if SSR failed) */
  initialData: StockDetails | null;
}

/**
 * Client component that handles retry when SSR data is unavailable.
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
    return <CompanyProfileLoading isRetrying={isRetrying} />;
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
          <CardTitle className="flex">{stockCode}</CardTitle>
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

  return <CompanyProfileContent stockCode={stockCode} stockDetails={data} />;
}

function CompanyProfileLoading({ isRetrying }: { isRetrying?: boolean }) {
  return (
    <Card className="w-full">
      <CardHeader className="pb-4">
        <div className="flex flex-col md:flex-row md:items-center gap-4 md:gap-6">
          <div className="flex items-center gap-4">
            <Skeleton className="rounded-md w-[70px] h-[70px]" />
            <div className="flex flex-col gap-2">
              <div className="flex items-center gap-2">
                <Skeleton className="w-[80px] h-[24px]" />
                {isRetrying && (
                  <RefreshCwIcon className="h-4 w-4 animate-spin text-muted-foreground" />
                )}
              </div>
              <div className="flex gap-1">
                <Skeleton className="w-[60px] h-[18px]" />
                <Skeleton className="w-[60px] h-[18px]" />
              </div>
            </div>
          </div>
          <div className="flex-1">
            <Skeleton className="w-full max-w-[400px] h-[32px] md:h-[40px] mb-2" />
            <Skeleton className="w-full max-w-[600px] h-[40px]" />
          </div>
        </div>
      </CardHeader>
    </Card>
  );
}

function CompanyProfileError({ onRetry, stockCode }: { onRetry: () => void; stockCode: string }) {
  return (
    <Card className="sm:col-span-4 border-amber-200 dark:border-amber-800">
      <CardHeader className="pb-3">
        <CardTitle className="flex items-center gap-2">
          <AlertCircleIcon className="h-5 w-5 text-amber-500" />
          {stockCode}
        </CardTitle>
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

function CompanyProfileContent({ stockCode, stockDetails }: { stockCode: string; stockDetails: StockDetails }) {
  const isEnriched = stockDetails.enrichmentStatus === "completed";
  const displaySummary =
    stockDetails.enhancedSummary || stockDetails.summary || "";
  const truncatedSummary =
    displaySummary.length > 400
      ? `${displaySummary.substring(0, 400)}...`
      : displaySummary;

  return (
    <Card className="h-full">
      <CardHeader className="pb-4 h-full">
        <div className="flex flex-col h-full">
          <div className="flex items-start gap-4 mb-4">
            <CompanyLogo 
              gcsUrl={stockDetails.logoIconGcsUrl || stockDetails.gcsUrl} 
              companyName={stockDetails.companyName} 
              stockCode={stockCode}
            />
            <div className="flex flex-col min-w-0 flex-1">
              <CardTitle className="flex items-center gap-2 text-xl font-bold truncate">
                <span>{stockCode}</span>
                {isEnriched && (
                  <span title="AI-Enhanced Data Available" className="shrink-0">
                    <Sparkles className="h-4 w-4 text-purple-500" />
                  </span>
                )}
              </CardTitle>
              <h1 className="text-xl md:text-2xl font-extrabold tracking-tight text-foreground line-clamp-2 leading-tight" title={stockDetails.companyName ?? stockCode}>
                {stockDetails.companyName ?? stockCode}
              </h1>
              <div className="flex flex-wrap gap-1 mt-2">
                {stockDetails.industry && (
                  <Badge variant="default" className="text-[10px] whitespace-nowrap">
                    {stockDetails.industry}
                  </Badge>
                )}
              </div>
            </div>
          </div>
          
          <div className="flex-1 min-w-0">
            {truncatedSummary && (
              <p className="text-sm text-muted-foreground leading-relaxed line-clamp-3 md:line-clamp-4">
                {truncatedSummary}
              </p>
            )}
            {isEnriched && stockDetails.tags && stockDetails.tags.length > 0 && (
              <div className="flex flex-wrap gap-1 mt-3">
                {stockDetails.tags.slice(0, 4).map((tag) => (
                  <Badge
                    key={tag}
                    variant="secondary"
                    className="text-[10px]"
                  >
                    {tag}
                  </Badge>
                ))}
              </div>
            )}
          </div>
        </div>
      </CardHeader>
    </Card>
  );
}

export default CompanyProfileWithRetry;
