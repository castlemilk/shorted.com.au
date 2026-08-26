import { createClient } from "@connectrpc/connect";
import { createConnectTransport } from "@connectrpc/connect-web";
import { unstable_cache } from "next/cache";

import {
  HousingService,
  type GetHousePriceSeriesResponse,
} from "~/gen/shorts/v1alpha1/housing_pb";
import {
  SERVER_SHORTS_API_URL,
  serverFetchOutsideNextCache,
  skipForBuild,
} from "./config";

export interface CapitalPricePointSnapshot {
  /** UTC calendar date (YYYY-MM-DD), safe to cross the RSC boundary. */
  period: string;
  value: number;
  isPreliminary: boolean;
}

export interface CapitalPriceSeriesSnapshot {
  regionCode: string;
  regionName: string;
  dwellingType: string;
  unit: string;
  source: string;
  sourceLicence: string;
  points: CapitalPricePointSnapshot[];
}

export interface CapitalPriceSnapshot {
  regionCode: string;
  house: CapitalPriceSeriesSnapshot | null;
  unit: CapitalPriceSeriesSnapshot | null;
  restOfState: CapitalPriceSeriesSnapshot | null;
}

function periodDate(
  period: { seconds?: bigint | number | string } | undefined,
): string {
  if (period?.seconds === undefined) return "";
  const milliseconds = Number(period.seconds) * 1000;
  if (!Number.isFinite(milliseconds)) return "";
  const date = new Date(milliseconds);
  return Number.isNaN(date.getTime()) ? "" : date.toISOString().slice(0, 10);
}

function projectSeries(
  response: GetHousePriceSeriesResponse | null,
): CapitalPriceSeriesSnapshot | null {
  if (!response) return null;

  const points = response.points
    .map((point) => ({
      period: periodDate(point.period),
      value: point.value,
      isPreliminary: point.isPreliminary,
    }))
    .filter((point) => point.period.length > 0 && Number.isFinite(point.value))
    .sort((a, b) => a.period.localeCompare(b.period));
  if (points.length === 0) return null;

  return {
    regionCode: response.regionCode,
    regionName: response.regionName,
    dwellingType: response.dwellingType,
    unit: response.unit,
    source: response.source,
    sourceLicence: response.sourceLicence,
    points,
  };
}

function settledSeries(
  result: PromiseSettledResult<GetHousePriceSeriesResponse | null>,
): CapitalPriceSeriesSnapshot | null {
  return result.status === "fulfilled" ? projectSeries(result.value) : null;
}

async function fetchCapitalPriceSnapshot(
  regionCode: string,
  restOfStateCode: string | null,
): Promise<CapitalPriceSnapshot> {
  const transport = createConnectTransport({
    fetch: serverFetchOutsideNextCache,
    baseUrl: SERVER_SHORTS_API_URL,
  });
  const client = createClient(HousingService, transport);

  const request = (code: string, dwellingType: string) =>
    client.getHousePriceSeries({
      regionCode: code,
      measure: "median_price",
      dwellingType,
    });

  // Isolate all three reads: a missing unit or regional series must not erase
  // a valid capital history during an ISR regeneration.
  const [houseResult, unitResult, restResult] = await Promise.allSettled([
    request(regionCode, "established_house"),
    request(regionCode, "attached"),
    restOfStateCode
      ? request(restOfStateCode, "established_house")
      : Promise.resolve(null),
  ]);

  const snapshot: CapitalPriceSnapshot = {
    regionCode,
    house: settledSeries(houseResult),
    unit: settledSeries(unitResult),
    restOfState: settledSeries(restResult),
  };
  if (!snapshot.house && !snapshot.unit && !snapshot.restOfState) {
    throw new Error(`GetHousePriceSeries returned no data for ${regionCode}`);
  }

  return snapshot;
}

/**
 * One ISR-safe capital snapshot. The unpatched Connect transport is created
 * inside unstable_cache, which owns the serializable result. Throwing from the
 * callback leaves total failures and empty responses uncached; individual
 * series failures remain nullable so the rest of the page can render.
 */
export async function getCapitalPrices(
  regionCode: string,
  restOfStateCode: string | null,
): Promise<CapitalPriceSnapshot | null> {
  if (skipForBuild()) return null;

  const regionKey = regionCode.toLowerCase();
  try {
    return await unstable_cache(
      () => fetchCapitalPriceSnapshot(regionCode, restOfStateCode),
      [`housing-capital-${regionKey}-v1`],
      {
        tags: ["housing", "housing-capitals", `housing-capital-${regionKey}`],
        revalidate: 3600,
      },
    )();
  } catch (error) {
    console.error(`[getCapitalPrices] failed for ${regionCode}:`, error);
    return null;
  }
}
