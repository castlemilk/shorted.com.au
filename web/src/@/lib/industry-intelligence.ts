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
  /** Median (50th percentile) of the constituents (%). */
  median?: number;
  /** 25th percentile of the constituents (%). */
  p25?: number;
  /** 75th percentile of the constituents (%). */
  p75?: number;
  /** Population standard deviation of the constituents (pp). */
  stddev?: number;
  /** Lowest constituent value in the bucket (%). */
  min?: number;
  /** Highest constituent value in the bucket (%). */
  max?: number;
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

/** Advance an ISO week-start (Monday) date string by seven days. */
function nextWeek(weekIso: string): string {
  const date = new Date(`${weekIso}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + 7);
  return date.toISOString().slice(0, 10);
}

/**
 * Aggregates per-stock short-interest time series into a weekly industry
 * crowding series (mean/median + p10-p90 and p25-p75 dispersion, stddev).
 *
 * Upstream series are decimated (~60 points per stock regardless of window),
 * so over long windows a stock's observations skip weeks. Short interest is a
 * step function — the last reported value holds until it changes — so each
 * stock's last observation is carried forward through gap weeks, but only
 * within its own observed range (first to last observation; never
 * extrapolated), keeping the weekly cross-section stable instead of churning
 * with decimation artifacts.
 *
 * Buckets with fewer than `minConstituents` stocks are dropped; returns null
 * when fewer than three usable weekly buckets exist so callers simply skip
 * the chart.
 */
export function buildIndustryCrowdingSeries(
  stocks: CrowdingStockInput[],
  { minConstituents = 3 }: { minConstituents?: number } = {},
): IndustryCrowdingSeries | null {
  // Sparse weekly observations per stock (last observation per week wins —
  // points arrive date-ascending).
  const perStock = new Map<string, Map<string, number>>();
  let firstWeek: string | null = null;
  let lastWeek: string | null = null;
  for (const stock of stocks) {
    for (const point of stock.points) {
      if (!Number.isFinite(point.value)) continue;
      const week = isoWeekStart(point.date);
      if (!week) continue;
      let observed = perStock.get(stock.code);
      if (!observed) {
        observed = new Map();
        perStock.set(stock.code, observed);
      }
      observed.set(week, point.value);
      if (!firstWeek || week < firstWeek) firstWeek = week;
      if (!lastWeek || week > lastWeek) lastWeek = week;
    }
  }
  if (!firstWeek || !lastWeek) return null;

  // Walk every calendar week in range, carrying each stock's last value
  // forward until its final observation.
  const lastObservedWeek = new Map<string, string>();
  for (const [code, observed] of perStock) {
    let max = "";
    for (const week of observed.keys()) if (week > max) max = week;
    lastObservedWeek.set(code, max);
  }

  const carried = new Map<string, number>();
  const points: CrowdingPoint[] = [];
  for (let week = firstWeek; week <= lastWeek; week = nextWeek(week)) {
    const values: number[] = [];
    for (const [code, observed] of perStock) {
      const fresh = observed.get(week);
      if (fresh !== undefined) carried.set(code, fresh);
      const value = carried.get(code);
      if (value !== undefined && week <= lastObservedWeek.get(code)!) {
        values.push(value);
      }
    }
    if (values.length < minConstituents) continue;
    const sorted = values.sort((a, b) => a - b);
    const mean = sorted.reduce((sum, v) => sum + v, 0) / sorted.length;
    const variance =
      sorted.reduce((sum, v) => sum + (v - mean) * (v - mean), 0) /
      sorted.length;
    points.push({
      date: week,
      avg: round2(mean),
      p10: round2(percentile(sorted, 0.1)),
      p90: round2(percentile(sorted, 0.9)),
      constituents: sorted.length,
      median: round2(percentile(sorted, 0.5)),
      p25: round2(percentile(sorted, 0.25)),
      p75: round2(percentile(sorted, 0.75)),
      stddev: round2(Math.sqrt(variance)),
      // Full envelope. /themes shades min–max rather than p10–p90 because a
      // hand-curated basket of 8-15 names has too few constituents for a
      // percentile band to mean anything (p10 of 9 values is nearly the min).
      min: round2(sorted[0]!),
      max: round2(sorted[sorted.length - 1]!),
    });
  }

  if (points.length < 3) return null;
  return { points };
}

/**
 * Trailing simple moving average; indices with fewer than `period`
 * observations yield null so chart lines simply start later.
 */
export function trailingSma(
  values: number[],
  period: number,
): (number | null)[] {
  return values.map((_, i) => {
    if (i < period - 1) return null;
    let sum = 0;
    for (let j = i - period + 1; j <= i; j += 1) sum += values[j]!;
    return round2(sum / period);
  });
}

/** Change vs `lag` observations ago (percentage points for % inputs). */
export function changeOverLag(
  values: number[],
  lag: number,
): (number | null)[] {
  return values.map((v, i) => (i < lag ? null : round2(v - values[i - lag]!)));
}

/**
 * Z-score of each observation against its trailing `window` (inclusive).
 * Needs at least `minObs` points of history; a near-zero deviation yields
 * null rather than an exploding score.
 */
export function trailingZScore(
  values: number[],
  window: number,
  minObs = 8,
): (number | null)[] {
  return values.map((v, i) => {
    const start = Math.max(0, i - window + 1);
    const slice = values.slice(start, i + 1);
    if (slice.length < minObs) return null;
    const mean = slice.reduce((sum, x) => sum + x, 0) / slice.length;
    const sd = Math.sqrt(
      slice.reduce((sum, x) => sum + (x - mean) * (x - mean), 0) /
        slice.length,
    );
    if (sd < 1e-6) return null;
    return round2((v - mean) / sd);
  });
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
    // The client renders evidence EXCLUSIVELY from channels[] (each channel
    // carries its own sources/records/timeBuckets/entityTotals). The top-level
    // arrays are a byte-for-byte duplicate of that same data — nothing reads
    // them, but they shipped in the RSC flight of every /industry-intelligence
    // visitor (~284KB uncompressed across 8 stories). Keep the fields (builder
    // inputs / test scratch still type-check) but emit them empty.
    evidenceSources: [],
    evidenceRecords: [],
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
