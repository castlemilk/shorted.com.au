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
  PanelTopIcon, 
  MapPinIcon, 
  Building2Icon,
  LinkedinIcon,
  TwitterIcon,
  FacebookIcon,
  YoutubeIcon,
  RefreshCwIcon,
  AlertCircleIcon,
} from "lucide-react";
import Link from "next/link";
import { Separator } from "./separator";
import { Skeleton } from "./skeleton";
import { Button } from "./button";

interface CompanyInfoClientProps {
  stockCode: string;
  /** Initial data from SSR attempt (null if SSR failed) */
  initialData: StockDetails | null;
}

/**
 * Client component that handles retry when SSR data is unavailable.
 * Shows loading state during retry and allows manual retry.
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
    return <CompanyInfoLoading isRetrying={isRetrying} />;
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
          <CardTitle className="flex text-sm font-bold uppercase tracking-wider text-muted-foreground">About</CardTitle>
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
  return <CompanyInfoContent stockDetails={data} />;
}

function CompanyInfoLoading({ isRetrying }: { isRetrying?: boolean }) {
  return (
    <Card className="sm:col-span-4">
      <CardHeader className="pb-3">
        <CardTitle className="flex text-sm font-bold uppercase tracking-wider text-muted-foreground">
          About
          {isRetrying && (
            <RefreshCwIcon className="ml-2 h-4 w-4 animate-spin text-muted-foreground" />
          )}
        </CardTitle>
        <Separator />
        <CardContent className="p-0 space-y-2 pt-4">
          <Skeleton className="w-full h-[16px]" />
          <Skeleton className="w-3/4 h-[16px]" />
          <Skeleton className="w-1/2 h-[16px]" />
        </CardContent>
      </CardHeader>
    </Card>
  );
}

function CompanyInfoError({ onRetry, stockCode }: { onRetry: () => void; stockCode: string }) {
  return (
    <Card className="sm:col-span-4 border-amber-200 dark:border-amber-800">
      <CardHeader className="pb-3">
        <CardTitle className="flex items-center text-sm font-bold uppercase tracking-wider text-muted-foreground">
          <AlertCircleIcon className="mr-2 h-4 w-4 text-amber-500" />
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

function CompanyInfoContent({ stockDetails }: { stockDetails: StockDetails }) {
  const isEnriched = stockDetails.enrichmentStatus === "completed";
  const socialLinks = stockDetails.socialMediaLinks;
  
  const hasAnyData = Boolean(
    stockDetails.summary ??
      stockDetails.website ??
      stockDetails.industry ??
      stockDetails.address ??
      socialLinks,
  );

  if (!hasAnyData) {
    return (
      <Card className="sm:col-span-4">
        <CardHeader className="pb-3">
          <CardTitle className="flex text-sm font-bold uppercase tracking-wider text-muted-foreground">About</CardTitle>
          <Separator />
          <CardContent className="p-0 pt-4">
            <p className="text-sm text-muted-foreground">
              Company information is being updated. Check back soon.
            </p>
          </CardContent>
        </CardHeader>
      </Card>
    );
  }

  return (
    <Card className="w-full">
      <CardHeader className="pb-3">
        <CardTitle className="flex text-sm font-bold uppercase tracking-wider text-muted-foreground">About</CardTitle>
        <Separator className="my-2" />

        <CardContent className="p-0 space-y-1">
          {/* Website */}
          {stockDetails.website && (
            <>
              <div className="flex content-center justify-between py-1">
                <div className="flex content-center items-center">
                  <div className="flex self-center p-1.5 opacity-70">
                    <PanelTopIcon size={12} />
                  </div>
                  <p className="uppercase font-semibold text-[10px] text-muted-foreground">
                    website
                  </p>
                </div>
                <span className="flex items-center p-1.5 text-xs">
                  <Link
                    href={stockDetails.website}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-blue-600 hover:underline font-medium"
                  >
                    {
                      stockDetails.website
                        .replace(/^https?:\/\/(www\.)?/, "")
                        .split("/")[0]
                    }
                  </Link>
                </span>
              </div>
              <Separator className="opacity-50" />
            </>
          )}

          {/* Industry */}
          {stockDetails.industry && (
            <>
              <div className="flex content-center justify-between py-1">
                <div className="flex content-center items-center">
                  <div className="flex self-center p-1.5 opacity-70">
                    <Building2Icon size={12} />
                  </div>
                  <p className="uppercase font-semibold text-[10px] text-muted-foreground">
                    industry
                  </p>
                </div>
                <span className="flex items-center p-1.5 text-xs font-medium">
                  {stockDetails.industry}
                </span>
              </div>
              <Separator className="opacity-50" />
            </>
          )}

          {/* Address */}
          {stockDetails.address && (
            <>
              <div className="flex content-center justify-between py-1">
                <div className="flex content-center items-center">
                  <div className="flex self-center p-1.5 opacity-70">
                    <MapPinIcon size={12} />
                  </div>
                  <p className="uppercase font-semibold text-[10px] text-muted-foreground">
                    address
                  </p>
                </div>
                <span className="flex items-center p-1.5 text-[10px] text-right max-w-[60%] leading-tight font-medium">
                  {stockDetails.address}
                </span>
              </div>
              <Separator className="opacity-50" />
            </>
          )}

          {/* Social Media Links - Only show if enriched */}
          {isEnriched && socialLinks && (
            <>
              <div className="py-2">
                <p className="uppercase font-semibold text-[10px] text-muted-foreground mb-2 px-1.5">
                  Connect
                </p>
                <div className="flex gap-4 px-1.5">
                  {socialLinks.linkedin && (
                    <Link
                      href={socialLinks.linkedin}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="text-muted-foreground hover:text-blue-600 transition-colors"
                      title="LinkedIn"
                    >
                      <LinkedinIcon size={16} />
                    </Link>
                  )}
                  {socialLinks.twitter && (
                    <Link
                      href={socialLinks.twitter}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="text-muted-foreground hover:text-blue-400 transition-colors"
                      title="Twitter"
                    >
                      <TwitterIcon size={16} />
                    </Link>
                  )}
                  {socialLinks.facebook && (
                    <Link
                      href={socialLinks.facebook}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="text-muted-foreground hover:text-blue-600 transition-colors"
                      title="Facebook"
                    >
                      <FacebookIcon size={16} />
                    </Link>
                  )}
                  {socialLinks.youtube && (
                    <Link
                      href={socialLinks.youtube}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="text-muted-foreground hover:text-red-600 transition-colors"
                      title="YouTube"
                    >
                      <YoutubeIcon size={16} />
                    </Link>
                  )}
                </div>
              </div>
            </>
          )}
        </CardContent>
      </CardHeader>
    </Card>
  );
}

export default CompanyInfoWithRetry;
