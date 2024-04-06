import React from "react";
import { getTopShortsData } from "~/app/actions/getTopShorts";
import { TopShorts } from "./topShortsView/topShorts";

const Page = async () => {
  const data = await getTopShortsData("3m", 10);
  return (
    <div>
      <TopShorts initialShortsData={data.timeSeries} />
    </div>
  );
};

export default Page;
