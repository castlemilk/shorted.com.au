import React from "react";
import { getTopShortsData } from "~/app/actions/getTopShorts";
import { TopShorts } from "./topShorts";


const Page = async () => {
  const data = await getTopShortsData("3m", 10);
  return (
    <>
      <TopShorts initialShortsData={data.timeSeries} />
    </>
  );
};

export default Page;