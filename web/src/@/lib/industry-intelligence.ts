export type StockCrowdingStatus = "crowded" | "elevated" | "watching";

export type SourceModuleStatus = "live" | "source-ready";

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

export interface SourceReadyModule {
  label: "Trade Exposure" | "Public Money" | "Tax Environment" | "Policy Footprint";
  status: SourceModuleStatus;
  value: string | null;
  source: IntelligenceSource;
}

export interface IndustryIntelligenceStory {
  industry: IndustrySummary;
  topShortedStocks: IndustryTopStock[];
  shortSignals: ShortSignalModule;
  tradeExposure: SourceReadyModule;
  publicMoney: SourceReadyModule;
  taxEnvironment: SourceReadyModule;
  policyFootprint: SourceReadyModule;
  entitlement: {
    free: true;
    premiumRequiredForEvidencePack: true;
    apiRequiredForBulkFeeds: true;
  };
  alerts: {
    previewEnabled: true;
    premiumCadences: ["Daily", "Weekly"];
  };
}

export function getStockCrowdingStatus(shortPercent: number): StockCrowdingStatus {
  if (shortPercent >= 10) return "crowded";
  if (shortPercent >= 5) return "elevated";
  return "watching";
}

function sourceReadyModule(
  label: SourceReadyModule["label"],
  sourceName: string,
): SourceReadyModule {
  return {
    label,
    status: "source-ready",
    value: null,
    source: {
      name: sourceName,
      asAt: null,
      cadence: "Planned import",
    },
  };
}

export function buildIndustryIntelligenceStory({
  industry,
  stocks,
  asAt,
}: {
  industry: IndustrySummary;
  stocks: IndustryStockInput[];
  asAt: string;
}): IndustryIntelligenceStory {
  const topShortedStocks = [...stocks]
    .filter((stock) => stock.code.trim().length > 0)
    .sort((a, b) => b.shortPercent - a.shortPercent)
    .slice(0, 10)
    .map((stock, index) => {
      const code = stock.code.toUpperCase();

      return {
        rank: index + 1,
        code,
        name: stock.name || code,
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
      highlyShortedCount: topShortedStocks.filter((stock) => stock.shortPercent > 10)
        .length,
      risingCount: topShortedStocks.filter((stock) => stock.change > 0).length,
      source: {
        name: "ASIC",
        asAt,
        cadence: "Daily, T+4",
      },
    },
    tradeExposure: sourceReadyModule("Trade Exposure", "ABS, DFAT, UN Comtrade"),
    publicMoney: sourceReadyModule("Public Money", "AusTender, GrantConnect"),
    taxEnvironment: sourceReadyModule("Tax Environment", "ATO, NGER, NPI"),
    policyFootprint: sourceReadyModule("Policy Footprint", "AEC, AGD, FITS, APH"),
    entitlement: {
      free: true,
      premiumRequiredForEvidencePack: true,
      apiRequiredForBulkFeeds: true,
    },
    alerts: {
      previewEnabled: true,
      premiumCadences: ["Daily", "Weekly"],
    },
  };
}

export function buildIndustryIntelligenceStories({
  industries,
  stocksByIndustry,
  asAt,
}: {
  industries: IndustrySummary[];
  stocksByIndustry: Record<string, IndustryStockInput[]>;
  asAt: string;
}): IndustryIntelligenceStory[] {
  return industries.map((industry) =>
    buildIndustryIntelligenceStory({
      industry,
      stocks: stocksByIndustry[industry.slug] ?? [],
      asAt,
    }),
  );
}

