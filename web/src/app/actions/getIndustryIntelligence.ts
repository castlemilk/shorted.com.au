import { createClient } from "@connectrpc/connect";
import { createConnectTransport } from "@connectrpc/connect-web";
import { cache } from "react";

import {
  type GetIndustryIntelligenceResponse,
  ShortedStocksService,
} from "~/gen/shorts/v1alpha1/shorts_pb";
import type {
  IndustryEvidenceEntityTotalInput,
  IndustryEvidenceRecordInput,
  IndustryEvidenceSourceInput,
  IndustryEvidenceTimeBucketInput,
} from "~/@/lib/industry-intelligence";
import { CACHE_KEYS, getOrSetCached } from "~/@/lib/kv-cache";
import { SERVER_SHORTS_API_URL, serverFetchWithUserAgent } from "./config";
import { withRetryAndNotFound } from "./withRetry";

/**
 * Plain, JSON-serializable projection of a GetIndustryIntelligence response —
 * safe to store in the KV cache (the raw proto response carries BigInt
 * timestamps) and to pass across the RSC boundary.
 */
export interface IndustryIntelligenceSnapshot {
  sources: IndustryEvidenceSourceInput[];
  records: IndustryEvidenceRecordInput[];
  timeBuckets: IndustryEvidenceTimeBucketInput[];
  entityTotals: IndustryEvidenceEntityTotalInput[];
}

const SNAPSHOT_TTL_SECONDS = 60 * 60; // evidence updates at most daily

type GetIndustryIntelligenceAction = (
  industry: string,
  recordLimit?: number,
) => Promise<GetIndustryIntelligenceResponse>;

const fetchIndustryIntelligence: GetIndustryIntelligenceAction = async (
  industry,
  recordLimit = 50,
) => {
  const transport = createConnectTransport({
    fetch: serverFetchWithUserAgent,
    baseUrl: SERVER_SHORTS_API_URL,
  });
  const client = createClient(ShortedStocksService, transport);
  return await client.getIndustryIntelligence({
    industry,
    recordLimit,
  });
};

export const getIndustryIntelligence = cache(
  withRetryAndNotFound(fetchIndustryIntelligence),
);

function toSnapshot(
  response: GetIndustryIntelligenceResponse,
): IndustryIntelligenceSnapshot {
  return {
    sources: response.sources.map((source) => ({
      sourceKey: source.sourceKey,
      displayName: source.displayName,
      publisher: source.publisher,
      sourceUrl: source.sourceUrl,
      licence: source.licence,
    })),
    records: response.records.map((record) => ({
      sourceKey: record.sourceKey,
      signalKind: record.signalKind,
      stockCode: record.stockCode,
      title: record.title,
      summary: record.summary,
      metricKey: record.metricKey,
      metricLabel: record.metricLabel,
      metricValue: record.hasMetricValue ? record.metricValue : null,
      unit: record.unit,
      asOf: record.asOf,
      sourceUrl: record.sourceUrl,
    })),
    timeBuckets: response.timeBuckets.map((bucket) => ({
      signalKind: bucket.signalKind,
      sourceKey: bucket.sourceKey,
      metricKey: bucket.metricKey,
      metricLabel: bucket.metricLabel,
      unit: bucket.unit,
      bucketLabel: bucket.bucketLabel,
      bucketStart: bucket.bucketStart,
      totalValue: bucket.totalValue,
      recordCount: bucket.recordCount,
      entityCount: bucket.entityCount,
      zeroValueCount: bucket.zeroValueCount,
    })),
    entityTotals: response.entityTotals.map((total) => ({
      signalKind: total.signalKind,
      sourceKey: total.sourceKey,
      metricKey: total.metricKey,
      stockCode: total.stockCode,
      entityLabel: total.entityLabel,
      unit: total.unit,
      totalValue: total.totalValue,
      recordCount: total.recordCount,
      latestAsOf: total.latestAsOf,
    })),
  };
}

/**
 * KV-cached (Redis, 1h; flushed with the homepage prefix on daily data
 * refresh) evidence snapshot for one industry. Returns null when the backend
 * is unreachable or has no data — failures are never cached.
 */
export const getIndustryIntelligenceSnapshot = cache(
  async (
    industry: string,
    recordLimit = 50,
  ): Promise<IndustryIntelligenceSnapshot | null> => {
    try {
      return await getOrSetCached(
        CACHE_KEYS.industryIntelligence(industry, recordLimit),
        async () => {
          const response = await getIndustryIntelligence(
            industry,
            recordLimit,
          );
          if (!response) {
            throw new Error("industry intelligence unavailable");
          }
          const snapshot = toSnapshot(response);
          if (
            snapshot.sources.length === 0 &&
            snapshot.records.length === 0 &&
            snapshot.timeBuckets.length === 0
          ) {
            // Do not cache emptiness: sources flip public as imports land.
            throw new Error("industry intelligence empty");
          }
          return snapshot;
        },
        SNAPSHOT_TTL_SECONDS,
      );
    } catch {
      return null;
    }
  },
);
