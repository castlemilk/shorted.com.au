import React from "react";
import { GoogleAnalytics } from "@next/third-parties/google";
import { getTopShortsData } from "~/app/actions/getTopShorts";
import { TopShorts } from "./topShortsView/topShorts";
import { getIndustryTreeMap } from "./actions/getIndustryTreeMap";
import { IndustryTreeMapView } from "./treemap/treeMap";
import { ViewMode } from "~/gen/shorts/v1alpha1/shorts_pb";
import { auth } from "~/server/auth";
import { LoginPromptBanner } from "~/@/components/ui/login-prompt-banner";

export const revalidate = 60; // revalidate the data at most every minute

const Page = async () => {
  const session = await auth();
  const data = await getTopShortsData("3m", 10, 0);
  const treeMapData = await getIndustryTreeMap(
    "3m",
    10,
    ViewMode.CURRENT_CHANGE,
  );

  return (
    <>
      <GoogleAnalytics gaId="G-X85RLQ4N2N" />
      {/* Subtle login prompt banner for non-authenticated users */}
      {!session && <LoginPromptBanner />}

      {/* Main dashboard view - accessible to all users */}
      <div className="flex flex-col lg:flex-row">
        <div className="lg:w-2/5">
          <TopShorts initialShortsData={data.timeSeries} initialPeriod="3m" />
        </div>
        <div className="lg:w-3/5">
          <IndustryTreeMapView
            initialTreeMapData={treeMapData}
            initialPeriod="3m"
            initialViewMode={ViewMode.CURRENT_CHANGE}
          />
        </div>
      </div>
    </>
  );
};

export default Page;
