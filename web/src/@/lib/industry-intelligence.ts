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
  metricLabel: string;
  metricValue: number | null;
  unit: string;
  asOf: string;
  sourceUrl: string;
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
}: {
  industry: IndustrySummary;
  stocks: IndustryStockInput[];
  asAt: string;
  evidenceSources?: IndustryEvidenceSourceInput[];
  evidenceRecords?: IndustryEvidenceRecordInput[];
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
  };
}

export function buildIndustryIntelligenceStories({
  industries,
  stocksByIndustry,
  asAt,
  evidenceByIndustry = {},
}: {
  industries: IndustrySummary[];
  stocksByIndustry: Record<string, IndustryStockInput[]>;
  asAt: string;
  evidenceByIndustry?: Record<
    string,
    {
      sources: IndustryEvidenceSourceInput[];
      records: IndustryEvidenceRecordInput[];
    }
  >;
}): IndustryIntelligenceStory[] {
  return industries.map((industry) =>
    buildIndustryIntelligenceStory({
      industry,
      stocks: stocksByIndustry[industry.slug] ?? [],
      asAt,
      evidenceSources: evidenceByIndustry[industry.slug]?.sources ?? [],
      evidenceRecords: evidenceByIndustry[industry.slug]?.records ?? [],
    }),
  );
}
