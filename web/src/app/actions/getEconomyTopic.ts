import { createClient } from "@connectrpc/connect";
import { createConnectTransport } from "@connectrpc/connect-web";
import { unstable_cache } from "next/cache";

import { EconomyService } from "~/gen/shorts/v1alpha1/economy_pb";
import type {
  EconomicSeriesInfo,
  GetEconomicSeriesResponse,
} from "~/gen/shorts/v1alpha1/economy_pb";
import {
  SERVER_SHORTS_API_URL,
  serverFetchOutsideNextCache,
  skipForBuild,
} from "./config";

export interface EconomyTopicObservationSnapshot {
  /** UTC calendar date (YYYY-MM-DD), safe to cross the RSC boundary. */
  period: string;
  value: number;
}

export interface EconomyTopicSeriesSnapshot {
  seriesKey: string;
  topic: string;
  metric: string;
  product: string;
  regionType: string;
  regionCode: string;
  regionName: string;
  unit: string;
  frequency: string;
  adjustment: string;
  sourceKey: string;
  sourceLicence: string;
  /** UTC calendar date (YYYY-MM-DD), or an empty string when unavailable. */
  latestPeriod: string;
  observations: EconomyTopicObservationSnapshot[];
}

export interface EconomyTopicSnapshot {
  state: string;
  topic: string;
  series: EconomyTopicSeriesSnapshot[];
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
  info: EconomicSeriesInfo,
  response: GetEconomicSeriesResponse,
): EconomyTopicSeriesSnapshot | null {
  const resolved =
    response.series.find((series) => series.info?.seriesKey === info.seriesKey) ??
    response.series[0];
  if (!resolved) return null;

  const observations = resolved.observations
    .map((observation) => ({
      period: periodDate(observation.period),
      value: observation.value,
    }))
    .filter(
      (observation) =>
        observation.period.length > 0 && Number.isFinite(observation.value),
    )
    .sort((a, b) => a.period.localeCompare(b.period));
  if (observations.length === 0) return null;

  return {
    seriesKey: info.seriesKey,
    topic: info.topic,
    metric: info.metric,
    product: info.product,
    regionType: info.regionType,
    regionCode: info.regionCode,
    regionName: info.regionName,
    unit: info.unit,
    frequency: info.frequency,
    adjustment: info.adjustment,
    sourceKey: info.sourceKey,
    sourceLicence: info.sourceLicence,
    latestPeriod: periodDate(info.latestPeriod),
    observations,
  };
}

async function fetchEconomyTopicSnapshot(
  state: string,
  topic: string,
): Promise<EconomyTopicSnapshot> {
  const transport = createConnectTransport({
    fetch: serverFetchOutsideNextCache,
    baseUrl: SERVER_SHORTS_API_URL,
  });
  const client = createClient(EconomyService, transport);

  const catalog = await client.listEconomicSeries({
    topic,
    metric: "",
    regionType: "state",
    regionCode: state,
    product: "",
    limit: 500,
  });
  if (catalog.series.length === 0) {
    throw new Error(`ListEconomicSeries returned no series for ${state}/${topic}`);
  }

  // Isolate each history request: one damaged series must not blank the rest
  // of a valid topic family during ISR regeneration.
  const histories = await Promise.allSettled(
    catalog.series.map((info) =>
      client.getEconomicSeries({
        seriesKeys: [info.seriesKey],
        maxObservations: 600,
      }),
    ),
  );
  const series = histories.flatMap((result, index) => {
    if (result.status === "rejected") return [];
    const projected = projectSeries(catalog.series[index]!, result.value);
    return projected ? [projected] : [];
  });

  if (series.length === 0) {
    throw new Error(`GetEconomicSeries returned no observations for ${state}/${topic}`);
  }

  return { state, topic, series };
}

/**
 * One ISR-safe snapshot for a state/topic route. The Connect client uses the
 * unpatched transport inside unstable_cache, which owns the result cache.
 * Throwing inside the callback prevents an empty catalog or total history
 * failure from being cached; callers receive null and can bail out of the
 * route-cache render while leaving a previous good ISR page intact.
 */
export async function getEconomyTopicSnapshot(
  state: string,
  topic: string,
): Promise<EconomyTopicSnapshot | null> {
  if (skipForBuild()) return null;

  const stateKey = state.toLowerCase();
  const topicKey = topic.toLowerCase();
  try {
    return await unstable_cache(
      () => fetchEconomyTopicSnapshot(stateKey, topicKey),
      [`economy-topic-${stateKey}-${topicKey}-v1`],
      {
        tags: [
          "economy",
          "economy-topics",
          `economy-topic-${stateKey}-${topicKey}`,
        ],
        revalidate: 3600,
      },
    )();
  } catch (error) {
    console.error(
      `[getEconomyTopicSnapshot] failed for ${stateKey}/${topicKey}:`,
      error,
    );
    return null;
  }
}
