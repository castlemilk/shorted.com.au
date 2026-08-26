import { unstable_cache } from "next/cache";

import type { RankingSuburb } from "~/@/lib/housing-rankings/rank";
import { listStateSuburbsOutsideNextCache } from "./getHousing";
import { skipForBuild } from "./config";

export interface HousingRankingData {
  /** Newest Valuer-General-derived price period in this state (YYYY-MM-DD). */
  asOfDate: string;
  suburbs: RankingSuburb[];
}

const STATE_SUBURB_LIMIT = 5000;

/**
 * One compact projection of ListStateSuburbs, shared by all five rankings for
 * a state. The underlying wrapper creates its Connect client with
 * serverFetchOutsideNextCache; this callback owns the result cache instead.
 */
async function fetchHousingRankingData(
  stateCode: string,
): Promise<HousingRankingData> {
  const response = await listStateSuburbsOutsideNextCache(
    stateCode,
    STATE_SUBURB_LIMIT,
  );
  if (!response?.suburbs?.length) {
    throw new Error(`ListStateSuburbs returned no suburbs for ${stateCode}`);
  }

  const suburbs: RankingSuburb[] = response.suburbs.map((suburb) => ({
    salCode: suburb.salCode,
    salName: suburb.salName,
    stateCode: suburb.stateCode,
    postcode: suburb.postcode,
    latestMedianPrice: suburb.latestMedianPrice,
    yoyPct: suburb.yoyPct,
    population: suburb.population,
    medianWeeklyHhdIncome: suburb.medianWeeklyHhdIncome,
  }));

  let newestPeriodSeconds = BigInt(0);
  for (const suburb of response.suburbs) {
    const seconds = suburb.latestPeriod?.seconds;
    if (typeof seconds === "bigint" && seconds > newestPeriodSeconds) {
      newestPeriodSeconds = seconds;
    }
  }

  // All v1 metrics require a real price. Do not pin an unpriced response for
  // an hour during a source refresh, and do not publish an invented vintage.
  if (
    newestPeriodSeconds === BigInt(0) ||
    !suburbs.some((suburb) => suburb.latestMedianPrice > 0)
  ) {
    throw new Error(
      `ListStateSuburbs returned no priced data for ${stateCode}`,
    );
  }

  return {
    asOfDate: new Date(Number(newestPeriodSeconds) * 1000)
      .toISOString()
      .slice(0, 10),
    suburbs,
  };
}

// ISR-safe: the Connect call happens inside unstable_cache and its transport
// bypasses Next's patched fetch. Throwing above leaves empty data uncached; a
// failure degrades to null so the page can bail out of the route-cache render.
export async function getHousingRankingData(
  stateCode: string,
): Promise<HousingRankingData | null> {
  if (skipForBuild()) return null;
  try {
    const stateKey = stateCode.toLowerCase();
    return await unstable_cache(
      () => fetchHousingRankingData(stateCode),
      [`housing-ranking-suburbs-${stateKey}-v1`],
      {
        tags: ["housing", "housing-rankings", `housing-ranking-${stateKey}`],
        revalidate: 3600,
      },
    )();
  } catch (error) {
    console.error(`[getHousingRankingData] failed for ${stateCode}:`, error);
    return null;
  }
}
