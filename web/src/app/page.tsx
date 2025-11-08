"use client";

import React, { useEffect, useState } from "react";
import { GoogleAnalytics } from "@next/third-parties/google";
import { getTopShortsData } from "~/app/actions/getTopShorts";
import { TopShorts } from "./topShortsView/topShorts";
import { getIndustryTreeMap } from "./actions/getIndustryTreeMap";
import { IndustryTreeMapView } from "./treemap/treeMap";
import { ViewMode } from "~/gen/shorts/v1alpha1/shorts_pb";
import { useSession } from "next-auth/react";
import { LoginPromptBanner } from "@/components/ui/login-prompt-banner";
import { Skeleton } from "@/components/ui/skeleton";
import { type PlainMessage } from "@bufbuild/protobuf";
import { type TimeSeriesData } from "~/gen/stocks/v1alpha1/stocks_pb";
import { type IndustryTreeMap } from "~/gen/stocks/v1alpha1/stocks_pb";

const Page = () => {
  const { data: session } = useSession();
  const [shortsData, setShortsData] = useState<PlainMessage<TimeSeriesData>[]>([]);
  const [treeMapData, setTreeMapData] = useState<PlainMessage<IndustryTreeMap>>({ industries: [], stocks: [] });
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const fetchData = async () => {
      try {
        const [data, treeData] = await Promise.all([
          getTopShortsData("3m", 10, 0).catch((error) => {
            console.error("Error fetching top shorts:", error);
            return { timeSeries: [] };
          }),
          getIndustryTreeMap("3m", 10, ViewMode.CURRENT_CHANGE).catch((error) => {
            console.error("Error fetching industry treemap:", error);
            return { industries: [], stocks: [] };
          }),
        ]);
        
        setShortsData(data.timeSeries);
        setTreeMapData(treeData);
      } catch (error) {
        console.error("Error fetching data:", error);
      } finally {
        setLoading(false);
      }
    };

    void fetchData();
  }, []);

  if (loading) {
    return (
      <>
        <GoogleAnalytics gaId="G-X85RLQ4N2N" />
        <div className="flex flex-col lg:flex-row gap-4">
          <div className="lg:w-2/5">
            <Skeleton className="h-[600px] w-full" />
          </div>
          <div className="lg:w-3/5">
            <Skeleton className="h-[600px] w-full" />
          </div>
        </div>
      </>
    );
  }

  return (
    <>
      <GoogleAnalytics gaId="G-X85RLQ4N2N" />
      {/* Subtle login prompt banner for non-authenticated users */}
      {!session && <LoginPromptBanner />}

      {/* Main dashboard view - accessible to all users */}
      <div className="flex flex-col lg:flex-row">
        <div className="lg:w-2/5">
          <TopShorts initialShortsData={shortsData} initialPeriod="3m" />
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
