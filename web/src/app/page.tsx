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
    <>
      <GoogleAnalytics gaId="G-X85RLQ4N2N" />
      {/* Subtle login prompt banner for non-authenticated users */}
      {!session && <LoginPromptBanner />}

      {/* Main dashboard view - accessible to all users */}
      <div className="flex flex-col lg:flex-row">
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
    </>
  );
};

export default Page;
