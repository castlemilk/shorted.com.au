"use client";

import { useEffect, useState, useRef } from "react";
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
  containerWidth,
  containerHeight,
  containerX,
  containerY,
}: TreemapTooltipProps) {
  const [stockDetails, setStockDetails] = useState<
    PlainMessage<StockDetails> | undefined
  >();
  const [timeSeriesData, setTimeSeriesData] = useState<
    PlainMessage<TimeSeriesData> | undefined
  >();
  const [loading, setLoading] = useState(true);
  const [imageError, setImageError] = useState(false);

  // Lock position on mount to prevent jolt when content loads
  const positionRef = useRef<{ x: number; y: number } | null>(null);

  // Reset position when stock changes (new hover)
  useEffect(() => {
    positionRef.current = null;
  }, [productCode, x, y]);

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

  // Smart positioning to keep tooltip within treemap container
  const TOOLTIP_WIDTH = 320;
  const TOOLTIP_OFFSET = 15;
  const EDGE_PADDING = 10;

  // Use max height for all calculations to prevent position shifts
  // This ensures position stays stable as content loads
  const TOOLTIP_HEIGHT = 400;

  // Calculate position once and lock it
  if (!positionRef.current) {
    // Calculate container boundaries in viewport coordinates
    const containerLeft = containerX + EDGE_PADDING;
    const containerRight = containerX + containerWidth - EDGE_PADDING;
    const containerTop = containerY + EDGE_PADDING;
    const containerBottom = containerY + containerHeight - EDGE_PADDING;

    // === HORIZONTAL POSITIONING ===
    // Try to position to the right of cursor first
    let tooltipX = x + TOOLTIP_OFFSET;

    // If that would overflow right edge, try left side
    if (tooltipX + TOOLTIP_WIDTH > containerRight) {
      tooltipX = x - TOOLTIP_WIDTH - TOOLTIP_OFFSET;
    }

    // If left side also overflows, center on cursor and clamp
    if (tooltipX < containerLeft) {
      tooltipX = Math.max(
        containerLeft,
        Math.min(x - TOOLTIP_WIDTH / 2, containerRight - TOOLTIP_WIDTH),
      );
    }

    // Final safety clamp
    tooltipX = Math.max(
      containerLeft,
      Math.min(tooltipX, containerRight - TOOLTIP_WIDTH),
    );

    // === VERTICAL POSITIONING ===
    // Try to position at cursor (expanding down)
    let tooltipY = y;

    // If would overflow bottom, shift up only as much as needed
    if (tooltipY + TOOLTIP_HEIGHT > containerBottom) {
      tooltipY = containerBottom - TOOLTIP_HEIGHT;
    }

    // If would overflow top, shift down only as much as needed
    if (tooltipY < containerTop) {
      tooltipY = containerTop;
    }

    // Final safety clamp
    tooltipY = Math.max(
      containerTop,
      Math.min(tooltipY, containerBottom - TOOLTIP_HEIGHT),
    );

    positionRef.current = { x: tooltipX, y: tooltipY };
  }

  const { x: tooltipX, y: tooltipY } = positionRef.current;

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
          </div>
        )}
      </div>
    </div>
  );
}
