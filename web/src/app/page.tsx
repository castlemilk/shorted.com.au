import React from "react";
import { GoogleAnalytics } from "@next/third-parties/google";
import { getTopShortsData } from "~/app/actions/getTopShorts";
import { TopShorts } from "./topShortsView/topShorts";
import { getIndustryTreeMap } from "./actions/getIndustryTreeMap";
import { IndustryTreeMapView } from "./treemap/treeMap";
import { ViewMode } from "~/gen/shorts/v1alpha1/shorts_pb";
import { auth } from "~/server/auth";
import dynamic from "next/dynamic";

// Dynamic import to ensure client component is properly bundled
const LoginPromptBanner = dynamic(
  () =>
    import("@/components/ui/login-prompt-banner").then(
      (mod) => mod.LoginPromptBanner,
    ),
  { ssr: true },
);

// Revalidate the page every 60 seconds (ISR - Incremental Static Regeneration)
// This means Vercel will serve cached pages and revalidate in the background
export const revalidate = 60;

// Set a maximum execution time for this page (30 seconds)
// This prevents timeouts when backend is slow
export const maxDuration = 30;

const Page = async () => {
  try {
    const session = await auth();

    // Fetch data with error handling
    const [data, treeMapData] = await Promise.all([
      getTopShortsData("3m", 10, 0).catch((error) => {
        console.error("Error fetching top shorts:", error);
        return { timeSeries: [] }; // Fallback to empty data
      }),
      getIndustryTreeMap("3m", 10, ViewMode.CURRENT_CHANGE).catch((error) => {
        console.error("Error fetching industry treemap:", error);
        return { industries: [], stocks: [] }; // Fallback to empty data
      }),
    ]);

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
  } catch (error) {
    console.error("Critical error rendering homepage:", error);
    // Even if there's an error, show the page structure
    return (
      <>
        <GoogleAnalytics gaId="G-X85RLQ4N2N" />
        <div className="flex flex-col lg:flex-row">
          <div className="lg:w-2/5">
            <TopShorts initialShortsData={[]} initialPeriod="3m" />
          </div>
          <div className="lg:w-3/5">
            <IndustryTreeMapView
              initialTreeMapData={{ industries: [], stocks: [] }}
              initialPeriod="3m"
              initialViewMode={ViewMode.CURRENT_CHANGE}
            />
          </div>
        </div>
      </>
    );
  }
};

export default Page;
