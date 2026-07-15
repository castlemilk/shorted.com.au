import type { GetIndustryIntelligenceResponse } from "~/gen/shorts/v1alpha1/shorts_pb";
import type {
  IndustryEvidenceEntityTotalInput,
  IndustryEvidenceRecordInput,
  IndustryEvidenceSourceInput,
  IndustryEvidenceTimeBucketInput,
} from "~/@/lib/industry-intelligence";

/**
 * Plain, JSON-serializable projection of a GetIndustryIntelligence response —
 * safe to store in caches (the raw proto response carries BigInt timestamps)
 * and to pass across the RSC boundary. Pure module: usable from both server
 * actions and client fetchers.
 */
export interface IndustryIntelligenceSnapshot {
  sources: IndustryEvidenceSourceInput[];
  records: IndustryEvidenceRecordInput[];
  timeBuckets: IndustryEvidenceTimeBucketInput[];
  entityTotals: IndustryEvidenceEntityTotalInput[];
}

export function toSnapshot(
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
