"use client";

import { useEffect, useState } from "react";
import { type PlainMessage } from "@bufbuild/protobuf";
import {
  type StockDetails,
  type TimeSeriesData,
} from "~/gen/stocks/v1alpha1/stocks_pb";
import {
  fetchStockDetailsClient,
  fetchStockDataClient,
} from "@/lib/client-api";
import { Skeleton } from "@/components/ui/skeleton";
import { Sparkline, type SparklineData } from "@/components/ui/sparkline";
import Image from "next/image";

interface TreemapTooltipProps {
  productCode: string;
  shortPosition: number;
  industry: string;
  x: number;
  y: number;
  containerWidth: number;
  containerHeight: number;
  containerX: number;
  containerY: number;
}

export function TreemapTooltip({
  productCode,
  shortPosition,
  industry,
  x,
  y,
}: TreemapTooltipProps) {
  const [stockDetails, setStockDetails] = useState<
    PlainMessage<StockDetails> | undefined
  >();
  const [timeSeriesData, setTimeSeriesData] = useState<
    PlainMessage<TimeSeriesData> | undefined
  >();
  const [loading, setLoading] = useState(true);
  const [imageError, setImageError] = useState(false);

  // Calculate position on every render since mouse position changes
  // We don't lock it anymore - this allows it to update as the mouse moves

  useEffect(() => {
    let isMounted = true;

    const fetchData = async () => {
      setLoading(true);

      // Fetch both stock details and time series data in parallel
      const [details, tsData] = await Promise.all([
        fetchStockDetailsClient(productCode),
        fetchStockDataClient(productCode, "1m"),
      ]);

      if (isMounted) {
        setStockDetails(details);
        setTimeSeriesData(tsData);
        setLoading(false);
      }
    };

    void fetchData();

    return () => {
      isMounted = false;
    };
  }, [productCode]);

  // Convert time series data to sparkline format
  const sparklineData: SparklineData[] =
    timeSeriesData?.points.map((point) => ({
      date: new Date(Number(point.timestamp?.seconds ?? 0) * 1000),
      value: point.shortPosition,
    })) ?? [];

  // Calculate change
  const change =
    sparklineData.length > 1
      ? sparklineData[sparklineData.length - 1]!.value - sparklineData[0]!.value
      : 0;
  const isPositive = change >= 0;

  // Simple positioning: render near mouse, adjust if would go off-screen
  const TOOLTIP_WIDTH = 320;
  const TOOLTIP_HEIGHT = 400;
  const OFFSET = 15;

  const viewportWidth = window.innerWidth;
  const viewportHeight = window.innerHeight;

  // Start by positioning to the right and below the cursor
  let tooltipX = x + OFFSET;
  let tooltipY = y + OFFSET;

  // If tooltip would go off the right edge, position it to the left of cursor
  if (tooltipX + TOOLTIP_WIDTH > viewportWidth - 10) {
    tooltipX = x - TOOLTIP_WIDTH - OFFSET;
  }

  // If tooltip would go off the bottom edge, position it above cursor
  if (tooltipY + TOOLTIP_HEIGHT > viewportHeight - 10) {
    tooltipY = y - TOOLTIP_HEIGHT - OFFSET;
  }

  // Clamp to viewport to ensure it's always visible
  tooltipX = Math.max(
    10,
    Math.min(tooltipX, viewportWidth - TOOLTIP_WIDTH - 10),
  );
  tooltipY = Math.max(
    10,
    Math.min(tooltipY, viewportHeight - TOOLTIP_HEIGHT - 10),
  );

  return (
    <div
      className="fixed z-50 pointer-events-none"
      style={{
        left: tooltipX,
        top: tooltipY,
      }}
    >
      <div className="bg-popover border border-border rounded-lg shadow-xl p-4 w-[320px] pointer-events-none">
        {loading ? (
          // Loading skeleton
          <div className="space-y-3">
            <div className="flex items-start gap-3">
              <Skeleton className="h-12 w-12 rounded-md flex-shrink-0" />
              <div className="flex-1 space-y-2">
                <Skeleton className="h-4 w-24" />
                <Skeleton className="h-3 w-32" />
              </div>
            </div>
            <div className="space-y-2">
              <Skeleton className="h-3 w-full" />
              <Skeleton className="h-3 w-full" />
              <Skeleton className="h-3 w-3/4" />
            </div>
            <Skeleton className="h-16 w-full" />
          </div>
        ) : (
          // Loaded content
          <div className="space-y-3">
            {/* Header with logo and basic info */}
            <div className="flex items-start gap-3">
              {stockDetails?.gcsUrl && !imageError ? (
                <div className="relative h-12 w-12 flex-shrink-0 rounded-md overflow-hidden bg-muted">
                  <Image
                    src={stockDetails.gcsUrl}
                    alt={`${stockDetails.companyName ?? productCode} logo`}
                    fill
                    className="object-contain"
                    onError={() => setImageError(true)}
                    unoptimized
                  />
                </div>
              ) : (
                <div className="h-12 w-12 flex-shrink-0 rounded-md bg-muted flex items-center justify-center">
                  <span className="text-lg font-semibold text-muted-foreground">
                    {productCode.slice(0, 2)}
                  </span>
                </div>
              )}

              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2">
                  <h3 className="font-semibold text-sm truncate">
                    {productCode}
                  </h3>
                  <span
                    className={`text-xs px-2 py-0.5 rounded ${
                      isPositive
                        ? "bg-red-500/10 text-red-500"
                        : "bg-green-500/10 text-green-500"
                    }`}
                  >
                    {isPositive ? "↑" : "↓"} {Math.abs(change).toFixed(2)}%
                  </span>
                </div>
                <p className="text-xs text-muted-foreground truncate">
                  {stockDetails?.companyName ?? "Loading..."}
                </p>
              </div>
            </div>

            {/* Metrics */}
            <div className="grid grid-cols-2 gap-2 text-xs">
              <div>
                <p className="text-muted-foreground">Short Position</p>
                <p className="font-semibold">{shortPosition.toFixed(2)}%</p>
              </div>
              <div>
                <p className="text-muted-foreground">Industry</p>
                <p className="font-semibold truncate" title={industry}>
                  {industry}
                </p>
              </div>
            </div>

            {/* Summary */}
            {stockDetails?.summary && (
              <div className="text-xs text-muted-foreground line-clamp-2">
                {stockDetails.summary}
              </div>
            )}

            {/* Website */}
            {stockDetails?.website && (
              <a
                href={stockDetails.website}
                target="_blank"
                rel="noopener noreferrer"
                className="text-xs text-primary hover:underline pointer-events-auto"
              >
                {stockDetails.website}
              </a>
            )}

            {/* Sparkline chart */}
            {sparklineData.length > 1 && (
              <div className="pt-2 border-t border-border">
                <p className="text-xs text-muted-foreground mb-2">
                  30 Day Trend
                </p>
                <Sparkline
                  data={sparklineData}
                  width={288}
                  height={60}
                  isPositive={!isPositive}
                  showArea={true}
                  strokeWidth={2}
                  gradientId={`tooltip-sparkline-${productCode}`}
                />
              </div>
            )}

            {/* Last Updated */}
            {sparklineData.length > 0 && (
              <div className="pt-2 border-t border-border">
                <p className="text-xs text-muted-foreground">
                  Last updated:{" "}
                  {new Date(
                    sparklineData[sparklineData.length - 1]!.date,
                  ).toLocaleDateString("en-AU", {
                    year: "numeric",
                    month: "short",
                    day: "numeric",
                  })}
                </p>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
