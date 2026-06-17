"use client";

import { useState, useCallback } from "react";
import dynamic from "next/dynamic";
import type { JsonValue } from "@bufbuild/protobuf";
import { RefreshCw, BarChart3 } from "lucide-react";
import { Button } from "~/@/components/ui/button";
import { clearSessionCache } from "~/@/lib/session-cache";

// ViewMode enum values - matches shorts.v1alpha1.ViewMode
// Using local constants to avoid SSR issues with protobuf-es v2 imports
const VIEW_MODE_CURRENT_CHANGE = 0;

function DashboardLoadingSkeleton() {
  return (
    <div className="flex flex-col items-center justify-center h-[700px] w-full rounded-xl bg-muted/20 border border-border/30">
      <BarChart3 className="h-10 w-10 text-muted-foreground/30 animate-pulse" />
      <p className="mt-3 text-sm text-muted-foreground/50 animate-pulse">
        Loading market data...
      </p>
    </div>
  );
}

const TopShorts = dynamic(
  () => import("./topShortsView/topShorts").then((mod) => mod.TopShorts),
  {
    loading: () => (
      <div className="p-4">
        <DashboardLoadingSkeleton />
      </div>
    ),
    ssr: false,
  }
);

const IndustryTreeMapView = dynamic(
  () => import("./treemap/treeMap").then((mod) => mod.IndustryTreeMapView),
  {
    loading: () => (
      <div className="p-4">
        <DashboardLoadingSkeleton />
      </div>
    ),
    ssr: false,
  }
);

export function HomeContent({
  initialTopShorts,
}: {
  // Top-shorts data prefetched by the server page (protobuf JSON) — seeds the
  // first render so TopShorts skips its mount fetch. Forwarded as-is to the
  // client-only TopShorts, which deserializes it (keeps protobuf-es out of this
  // SSR'd shell).
  initialTopShorts?: JsonValue[];
}) {
  const [refreshKey, setRefreshKey] = useState(0);
  const [lastUpdated, setLastUpdated] = useState<Date | null>(null);
  const [isRefreshing, setIsRefreshing] = useState(false);

  const handleRefresh = useCallback(() => {
    setIsRefreshing(true);
    clearSessionCache();
    setRefreshKey((k) => k + 1);
    setLastUpdated(new Date());
    // Brief visual feedback
    setTimeout(() => setIsRefreshing(false), 600);
  }, []);

  return (
    <div className="container mx-auto px-4 py-4">
      <div className="flex items-center justify-end gap-2 mb-1 px-2">
        {lastUpdated && (
          <span className="text-[11px] text-muted-foreground/50">
            Updated {lastUpdated.toLocaleTimeString()}
          </span>
        )}
        <Button
          variant="ghost"
          size="sm"
          onClick={handleRefresh}
          disabled={isRefreshing}
          className="h-7 gap-1.5 text-xs text-muted-foreground hover:text-foreground"
        >
          <RefreshCw
            className={`h-3 w-3 ${isRefreshing ? "animate-spin" : ""}`}
          />
          Refresh
        </Button>
      </div>
      <div className="flex flex-col lg:flex-row">
        <div className="lg:w-2/5">
          <TopShorts
            key={`ts-${refreshKey}`}
            initialPeriod="3m"
            initialShortsDataJson={refreshKey === 0 ? initialTopShorts : undefined}
          />
        </div>
        <div className="lg:w-3/5">
          <IndustryTreeMapView
            key={`tm-${refreshKey}`}
            initialPeriod="3m"
            initialViewMode={VIEW_MODE_CURRENT_CHANGE}
          />
        </div>
      </div>
    </div>
  );
}
