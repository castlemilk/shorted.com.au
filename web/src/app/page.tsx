import React from "react";
import { GoogleAnalytics } from "@next/third-parties/google";
import { getTopShortsData } from "~/app/actions/getTopShorts";
import { TopShorts } from "./topShortsView/topShorts";

const Page = async () => {
  const data = await getTopShortsData("3m", 10);
  return (
    <>
      <GoogleAnalytics gaId="G-X85RLQ4N2N" />
      <div>
        <TopShorts initialShortsData={data.timeSeries} />
      </div>
    </>
  );
};

export default Page;
