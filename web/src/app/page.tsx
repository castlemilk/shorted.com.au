"use client";

import React from "react";
import { GoogleAnalytics } from "@next/third-parties/google";
import { TopShorts } from "./topShortsView/topShorts";
import { IndustryTreeMapView } from "./treemap/treeMap";
import { ViewMode } from "~/gen/shorts/v1alpha1/shorts_pb";
import { LoginPromptBanner } from "~/@/components/ui/login-prompt-banner";
import { useSession } from "next-auth/react";

const Page = () => {
  const { data: session } = useSession();

  return (
    <div className="min-h-screen flex flex-col bg-background">
      <GoogleAnalytics gaId="G-X85RLQ4N2N" />
      
      {/* Login prompt banner for non-authenticated users */}
      {!session && <LoginPromptBanner />}

      {/* Main dashboard view */}
      <div className="container mx-auto px-4 py-8">
        <div className="flex flex-col lg:flex-row gap-8">
          <div className="lg:w-2/5">
            <TopShorts initialPeriod="3m" />
          </div>
          <div className="lg:w-3/5">
            <IndustryTreeMapView
              initialPeriod="3m"
              initialViewMode={ViewMode.CURRENT_CHANGE}
            />
          </div>
        </div>
      </div>
    </div>
  );
};

export default Page;
