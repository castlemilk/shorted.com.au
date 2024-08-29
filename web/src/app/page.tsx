import React from "react";
import { GoogleAnalytics } from "@next/third-parties/google";
import { getTopShortsData } from "~/app/actions/getTopShorts";
import { TopShorts } from "./topShortsView/topShorts";
import { getIndustryTreeMap } from "./actions/getIndustryTreeMap";
import { IndustryTreeMapView } from "./treemap/treeMap";
import { ViewMode } from "~/gen/shorts/v1alpha1/shorts_pb";
// import { getIdToken } from "~/server/auth";

export const revalidate = 300 // revalidate the data at most every 5 minutes

const Page = async () => {
  const data = await getTopShortsData("3m", 10, 0);
  const treeMapData = await getIndustryTreeMap("3m", 10, ViewMode.CURRENT_CHANGE)
  
  return (
    <>
      <GoogleAnalytics gaId="G-X85RLQ4N2N" />
      <div className="flex flex-col lg:flex-row">
        <div className="lg:w-2/5">
          <TopShorts initialShortsData={data.timeSeries} />
        </div>
        <div className="lg:w-3/5">
          <IndustryTreeMapView initialTreeMapData={treeMapData} />
        </div>
      </div>
    </>
  );
};

export default Page;
