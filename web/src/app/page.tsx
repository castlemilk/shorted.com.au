import React from "react";
import { GoogleAnalytics } from "@next/third-parties/google";
import { getTopShortsData } from "~/app/actions/getTopShorts";
import { TopShorts } from "./topShortsView/topShorts";
import { getIndustryTreeMap } from "./actions/getIndustryTreeMap";
import { IndustryTreeMapView } from "./treemap/treeMap";
import { ViewMode } from "~/gen/shorts/v1alpha1/shorts_pb";

export const revalidate = 60 // revalidate the data at most every hour
const Page = async () => {
  const data = await getTopShortsData("3m", 10, 0);
  const treeMapData = await getIndustryTreeMap("3m", 10, ViewMode.CURRENT_CHANGE)
  return (
    <>
      <GoogleAnalytics gaId="G-X85RLQ4N2N" />
      <div className="flex">
        <TopShorts initialShortsData={data.timeSeries} />
        <IndustryTreeMapView initialTreeMapData={treeMapData} />
      </div>
    </>
  );
};

export default Page;
