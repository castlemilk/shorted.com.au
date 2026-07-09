export type StockCrowdingStatus = "crowded" | "elevated" | "watching";

export interface IndustrySummary {
  name: string;
  slug: string;
  stockCount: number;
  avgShortPercent: number;
  totalShortPercent: number;
  topStock: {
    code: string;
    name: string;
    shortPercent: number;
  } | null;
}

export interface IndustryStockInput {
  code: string;
  name: string;
  shortPercent: number;
  change?: number;
  logoUrl?: string | null;
}

export interface IndustryEvidenceSourceInput {
  sourceKey: string;
  displayName: string;
  publisher: string;
  sourceUrl: string;
  licence: string;
}

export interface IndustryEvidenceRecordInput {
  sourceKey: string;
  signalKind: string;
  stockCode: string;
  title: string;
  summary: string;
  metricKey: string;
  metricLabel: string;
  metricValue: number | null;
  unit: string;
  asOf: string;
  sourceUrl: string;
}

export interface IndustryEvidenceTimeBucketInput {
  signalKind: string;
  sourceKey: string;
  metricKey: string;
  metricLabel: string;
  unit: string;
  bucketLabel: string;
  bucketStart: string;
  totalValue: number;
  recordCount: number;
  entityCount: number;
  zeroValueCount: number;
}

export interface IndustryEvidenceEntityTotalInput {
  signalKind: string;
  sourceKey: string;
  metricKey: string;
  stockCode: string;
  entityLabel: string;
  unit: string;
  totalValue: number;
  recordCount: number;
  latestAsOf: string;
}

/**
 * Neutral display labels per evidence signal kind. Wording follows the
 * editorial standards: descriptive channel names, never causal framing.
 */
export const SIGNAL_KIND_LABELS: Record<string, string> = {
  short_interest: "Crowding",
  tax_environment: "Tax Environment",
  public_money: "Public Money",
  emissions: "Emissions",
  trade_exposure: "Trade Exposure",
  policy_footprint: "Policy Footprint",
};

/**
 * Standing caveats that must accompany a channel wherever its figures render
 * (editorial standards: tax != wrongdoing; AusTender values are life-of-contract
 * maxima, not annual spend).
 */
export const SIGNAL_KIND_CAVEATS: Record<string, string> = {
  tax_environment:
    "Tax outcomes reflect lawful provisions. Nil or low tax payable is often the result of deductions, offsets, or prior-year losses and is not evidence of wrongdoing.",
  public_money:
    "Contract values are life-of-contract maximums as published on AusTender, not annual spend.",
  policy_footprint:
    "Register entries are declarations made under disclosure law. Their presence describes participation in a public process, not influence over outcomes.",
};

/** Fixed rendering order for evidence channels on the dashboard. */
export const SIGNAL_KIND_ORDER = [
  "tax_environment",
  "public_money",
  "emissions",
  "trade_exposure",
  "policy_footprint",
] as const;

export interface EvidenceChannel {
  kind: string;
  label: string;
  caveat: string | null;
  sources: IndustryEvidenceSourceInput[];
  records: IndustryEvidenceRecordInput[];
  timeBuckets: IndustryEvidenceTimeBucketInput[];
  entityTotals: IndustryEvidenceEntityTotalInput[];
  latestAsOf: string | null;
}

/**
 * Groups evidence into per-channel dashboard modules. Channels with no
 * aggregates AND no records are dropped entirely — the page never renders an
 * empty or "coming soon" channel (the no-fake-data contract).
 */
export function buildEvidenceChannels({
  sources,
  records,
  timeBuckets = [],
  entityTotals = [],
}: {
  sources: IndustryEvidenceSourceInput[];
  records: IndustryEvidenceRecordInput[];
  timeBuckets?: IndustryEvidenceTimeBucketInput[];
  entityTotals?: IndustryEvidenceEntityTotalInput[];
}): EvidenceChannel[] {
  const kinds = new Map<string, EvidenceChannel>();
  const sourceKeyToKind = new Map<string, string>();

  const ensure = (kind: string): EvidenceChannel => {
    let channel = kinds.get(kind);
    if (!channel) {
      channel = {
        kind,
        label: SIGNAL_KIND_LABELS[kind] ?? kind,
        caveat: SIGNAL_KIND_CAVEATS[kind] ?? null,
        sources: [],
        records: [],
        timeBuckets: [],
        entityTotals: [],
        latestAsOf: null,
      };
      kinds.set(kind, channel);
    }
    return channel;
  };

  for (const record of records) {
    if (!record.signalKind) continue;
    ensure(record.signalKind).records.push(record);
    sourceKeyToKind.set(record.sourceKey, record.signalKind);
  }
  for (const bucket of timeBuckets) {
    if (!bucket.signalKind) continue;
    ensure(bucket.signalKind).timeBuckets.push(bucket);
    sourceKeyToKind.set(bucket.sourceKey, bucket.signalKind);
  }
  for (const total of entityTotals) {
    if (!total.signalKind) continue;
    ensure(total.signalKind).entityTotals.push(total);
    sourceKeyToKind.set(total.sourceKey, total.signalKind);
  }
  for (const source of sources) {
    const kind = sourceKeyToKind.get(source.sourceKey);
    if (!kind) continue;
    const channel = ensure(kind);
    if (!channel.sources.some((s) => s.sourceKey === source.sourceKey)) {
      channel.sources.push(source);
    }
  }

  const channels: EvidenceChannel[] = [];
  for (const channel of kinds.values()) {
    if (
      channel.records.length === 0 &&
      channel.timeBuckets.length === 0 &&
      channel.entityTotals.length === 0
    ) {
      continue;
    }
    channel.records.sort((a, b) => b.asOf.localeCompare(a.asOf));
    channel.timeBuckets.sort((a, b) =>
      a.bucketStart.localeCompare(b.bucketStart),
    );
    channel.entityTotals.sort((a, b) => b.totalValue - a.totalValue);
    const asOfCandidates = [
      ...channel.records.map((r) => r.asOf),
      ...channel.entityTotals.map((t) => t.latestAsOf),
    ].filter(Boolean);
    channel.latestAsOf =
      asOfCandidates.length > 0
        ? asOfCandidates.reduce((a, b) => (a >= b ? a : b))
        : null;
    channels.push(channel);
  }

  channels.sort((a, b) => {
    const ai = SIGNAL_KIND_ORDER.indexOf(
      a.kind as (typeof SIGNAL_KIND_ORDER)[number],
    );
    const bi = SIGNAL_KIND_ORDER.indexOf(
      b.kind as (typeof SIGNAL_KIND_ORDER)[number],
    );
    return (ai === -1 ? 99 : ai) - (bi === -1 ? 99 : bi);
  });
  return channels;
}

export interface CrowdingPoint {
  /** ISO date of the weekly bucket (Monday). */
  date: string;
  /** Mean short interest across the industry's tracked stocks (%). */
  avg: number;
  /** 10th percentile of the constituents (%). */
  p10: number;
  /** 90th percentile of the constituents (%). */
  p90: number;
  /** Number of constituents contributing to the bucket. */
  constituents: number;
}

export interface IndustryCrowdingSeries {
  points: CrowdingPoint[];
}

interface CrowdingStockInput {
  code: string;
  points: { date: string; value: number }[];
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = (sorted.length - 1) * p;
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  const frac = idx - lo;
  return sorted[lo]! + (sorted[hi]! - sorted[lo]!) * frac;
}

function isoWeekStart(dateIso: string): string | null {
  const date = new Date(`${dateIso.slice(0, 10)}T00:00:00Z`);
  if (Number.isNaN(date.getTime())) return null;
  const day = date.getUTCDay();
  const diff = (day + 6) % 7; // days since Monday
  date.setUTCDate(date.getUTCDate() - diff);
  return date.toISOString().slice(0, 10);
}

const round2 = (value: number): number => Math.round(value * 100) / 100;

/**
 * Aggregates per-stock short-interest time series into a weekly industry
 * crowding series (mean + p10-p90 dispersion band). Buckets with fewer than
 * `minConstituents` stocks are dropped; returns null when fewer than three
 * usable weekly buckets exist so callers simply skip the chart.
 */
export function buildIndustryCrowdingSeries(
  stocks: CrowdingStockInput[],
  { minConstituents = 3 }: { minConstituents?: number } = {},
): IndustryCrowdingSeries | null {
  const weekly = new Map<string, Map<string, number>>();
  for (const stock of stocks) {
    for (const point of stock.points) {
      if (!Number.isFinite(point.value)) continue;
      const week = isoWeekStart(point.date);
      if (!week) continue;
      let bucket = weekly.get(week);
      if (!bucket) {
        bucket = new Map();
        weekly.set(week, bucket);
      }
      // Last observation per stock per week wins (points arrive date-ascending).
      bucket.set(stock.code, point.value);
    }
  }

  const points: CrowdingPoint[] = [];
  for (const [week, values] of [...weekly.entries()].sort(([a], [b]) =>
    a.localeCompare(b),
  )) {
    if (values.size < minConstituents) continue;
    const sorted = [...values.values()].sort((a, b) => a - b);
    const mean = sorted.reduce((sum, v) => sum + v, 0) / sorted.length;
    points.push({
      date: week,
      avg: round2(mean),
      p10: round2(percentile(sorted, 0.1)),
      p90: round2(percentile(sorted, 0.9)),
      constituents: values.size,
    });
  }

  if (points.length < 3) return null;
  return { points };
}

export interface IntelligenceSource {
  name: string;
  asAt: string | null;
  cadence: string;
}

export interface IndustryTopStock {
  rank: number;
  code: string;
  name: string;
  detail: string;
  logoUrl: string | null;
  shortPercent: number;
  change: number;
  status: StockCrowdingStatus;
  href: string;
}

export interface ShortSignalModule {
  averageShortPercent: number;
  highlyShortedCount: number;
  risingCount: number;
  source: IntelligenceSource;
}

export interface IndustryIntelligenceStory {
  industry: IndustrySummary;
  topShortedStocks: IndustryTopStock[];
  shortSignals: ShortSignalModule;
  alerts: {
    previewEnabled: true;
    cadences: ["Daily", "Weekly"];
  };
  evidenceSources: IndustryEvidenceSourceInput[];
  evidenceRecords: IndustryEvidenceRecordInput[];
  channels: EvidenceChannel[];
  crowding: IndustryCrowdingSeries | null;
}

export function getStockCrowdingStatus(
  shortPercent: number,
): StockCrowdingStatus {
  if (shortPercent >= 10) return "crowded";
  if (shortPercent >= 5) return "elevated";
  return "watching";
}

export function buildIndustryIntelligenceStory({
  industry,
  stocks,
  asAt,
  evidenceSources = [],
  evidenceRecords = [],
  evidenceTimeBuckets = [],
  evidenceEntityTotals = [],
  crowding = null,
}: {
  industry: IndustrySummary;
  stocks: IndustryStockInput[];
  asAt: string;
  evidenceSources?: IndustryEvidenceSourceInput[];
  evidenceRecords?: IndustryEvidenceRecordInput[];
  evidenceTimeBuckets?: IndustryEvidenceTimeBucketInput[];
  evidenceEntityTotals?: IndustryEvidenceEntityTotalInput[];
  crowding?: IndustryCrowdingSeries | null;
}): IndustryIntelligenceStory {
  const topShortedStocks = [...stocks]
    .filter((stock) => stock.code.trim().length > 0)
    .sort((a, b) => b.shortPercent - a.shortPercent)
    .slice(0, 10)
    .map((stock, index) => {
      const code = stock.code.toUpperCase();
      const stockName = stock.name.trim() || code;
      const hasCompanyName = stockName.toUpperCase() !== code;

      return {
        rank: index + 1,
        code,
        name: stockName,
        detail: hasCompanyName
          ? `${industry.name} company`
          : `${industry.name} short-interest leader`,
        logoUrl: stock.logoUrl ?? null,
        shortPercent: stock.shortPercent,
        change: stock.change ?? 0,
        status: getStockCrowdingStatus(stock.shortPercent),
        href: `/shorts/${code}`,
      };
    });

  return {
    industry,
    topShortedStocks,
    shortSignals: {
      averageShortPercent: industry.avgShortPercent,
      highlyShortedCount: topShortedStocks.filter(
        (stock) => stock.shortPercent > 10,
      ).length,
      risingCount: topShortedStocks.filter((stock) => stock.change > 0).length,
      source: {
        name: "ASIC",
        asAt,
        cadence: "Daily, T+4",
      },
    },
    alerts: {
      previewEnabled: true,
      cadences: ["Daily", "Weekly"],
    },
    evidenceSources,
    evidenceRecords,
    channels: buildEvidenceChannels({
      sources: evidenceSources,
      records: evidenceRecords,
      timeBuckets: evidenceTimeBuckets,
      entityTotals: evidenceEntityTotals,
    }),
    crowding,
  };
}

export function buildIndustryIntelligenceStories({
  industries,
  stocksByIndustry,
  asAt,
  evidenceByIndustry = {},
  crowdingByIndustry = {},
}: {
  industries: IndustrySummary[];
  stocksByIndustry: Record<string, IndustryStockInput[]>;
  asAt: string;
  evidenceByIndustry?: Record<
    string,
    {
      sources: IndustryEvidenceSourceInput[];
      records: IndustryEvidenceRecordInput[];
      timeBuckets?: IndustryEvidenceTimeBucketInput[];
      entityTotals?: IndustryEvidenceEntityTotalInput[];
    }
  >;
  crowdingByIndustry?: Record<string, IndustryCrowdingSeries | null>;
}): IndustryIntelligenceStory[] {
  return industries.map((industry) =>
    buildIndustryIntelligenceStory({
      industry,
      stocks: stocksByIndustry[industry.slug] ?? [],
      asAt,
      evidenceSources: evidenceByIndustry[industry.slug]?.sources ?? [],
      evidenceRecords: evidenceByIndustry[industry.slug]?.records ?? [],
      evidenceTimeBuckets: evidenceByIndustry[industry.slug]?.timeBuckets ?? [],
      evidenceEntityTotals:
        evidenceByIndustry[industry.slug]?.entityTotals ?? [],
      crowding: crowdingByIndustry[industry.slug] ?? null,
    }),
  );
}
