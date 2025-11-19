import { auth } from "~/server/auth";
import { redirect } from "next/navigation";
import { getTopShortsData } from "../actions/getTopShorts";
import { calculateMovers, type TimePeriod } from "~/@/lib/shorts-calculations";
import { TopShortsClient } from "./components/top-shorts-client";

const DEFAULT_PERIOD: TimePeriod = "3m";
const LOAD_CHUNK_SIZE = 20;

export default async function TopShortsPage() {
  // Check authentication on server
  const session = await auth();
  
  if (!session) {
    redirect("/signin?callbackUrl=/shorts");
  }

  // Fetch data on server
  const data = await getTopShortsData(DEFAULT_PERIOD, LOAD_CHUNK_SIZE, 0);
  const timeSeries = data.timeSeries ?? [];
  const moversData = calculateMovers(timeSeries, DEFAULT_PERIOD);

  return (
    <TopShortsClient
      initialMoversData={moversData}
      initialPeriod={DEFAULT_PERIOD}
    />
  );
}
