"use client";

import dynamic from "next/dynamic";
import { Skeleton } from "~/@/components/ui/skeleton";

// ViewMode enum values - matches shorts.v1alpha1.ViewMode
// Using local constants to avoid SSR issues with protobuf-es v2 imports
const VIEW_MODE_CURRENT_CHANGE = 0;

const TopShorts = dynamic(
  () => import("./topShortsView/topShorts").then((mod) => mod.TopShorts),
  {
    loading: () => (
      <div className="p-4">
        <Skeleton className="h-[700px] w-full rounded-xl" />
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
        <Skeleton className="h-[700px] w-full rounded-xl" />
      </div>
    ),
    ssr: false,
  }
);

export function HomeContent() {
  return (
    <div className="container mx-auto px-4 py-4">
      <div className="flex flex-col lg:flex-row">
        <div className="lg:w-2/5">
          <TopShorts initialPeriod="3m" />
        </div>
        <div className="lg:w-3/5">
          <IndustryTreeMapView
            initialPeriod="3m"
            initialViewMode={VIEW_MODE_CURRENT_CHANGE}
          />
        </div>
      </div>
    </div>
  );
}
