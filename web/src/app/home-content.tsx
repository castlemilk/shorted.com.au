"use client";

import React from "react";
import { TopShorts } from "./topShortsView/topShorts";
import { IndustryTreeMapView } from "./treemap/treeMap";
import { ViewMode } from "~/gen/shorts/v1alpha1/shorts_pb";

export function HomeContent() {
  return (
    <div className="container mx-auto px-4 py-4">
      {/* Main dashboard view */}
      <div className="grid grid-cols-1 lg:grid-cols-[2fr_3fr] gap-8">
        <div className="min-w-0">
          <TopShorts initialPeriod="3m" />
        </div>
        <div className="min-w-0">
          <IndustryTreeMapView
            initialPeriod="3m"
            initialViewMode={ViewMode.CURRENT_CHANGE}
          />
        </div>
      </div>
    </div>
  );
}
