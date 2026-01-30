import {
  WidgetType,
  type WidgetSettingsMap,
  type TopShortsSettings,
  type WatchlistSettings,
  type StockChartSettings,
  type IndustryTreemapSettings,
  type PortfolioSummarySettings,
  type TimeSeriesAnalysisSettings,
  type SectorPerformanceSettings,
  type CorrelationMatrixSettings,
  type MarketWatchlistSettings,
} from "@/types/dashboard";

/**
 * Default settings for each widget type
 */
export const defaultWidgetSettings: WidgetSettingsMap = {
  [WidgetType.TOP_SHORTS]: {
    period: "3m",
    limit: 10,
  } as TopShortsSettings,

  [WidgetType.WATCHLIST]: {
    watchlist: ["CBA", "BHP", "CSL", "WBC", "ANZ", "RIO", "WOW", "TLS"],
    timeInterval: "1m",
  } as WatchlistSettings,

  [WidgetType.STOCK_CHART]: {
    stocks: ["CBA"],
    period: "5y",
    viewMode: "absolute",
    dataTypes: ["market"],
    indicators: [],
    stockShortsVisibility: {},
  } as StockChartSettings,

  [WidgetType.INDUSTRY_TREEMAP]: {
    period: "3m",
    viewMode: "CURRENT_CHANGE",
    showSectorGrouping: true,
  } as IndustryTreemapSettings,

  [WidgetType.PORTFOLIO_SUMMARY]: {
    portfolio: [
      { symbol: "CBA", shares: 100 },
      { symbol: "BHP", shares: 50 },
      { symbol: "CSL", shares: 25 },
      { symbol: "WBC", shares: 80 },
      { symbol: "WOW", shares: 40 },
    ],
    refreshInterval: 300000,
  } as PortfolioSummarySettings,

  [WidgetType.TIME_SERIES_ANALYSIS]: {
    stocks: [],
    analysisType: "trend",
    period: "3m",
  } as TimeSeriesAnalysisSettings,

  [WidgetType.SECTOR_PERFORMANCE]: {
    period: "1w",
    displayType: "pie",
  } as SectorPerformanceSettings,

  [WidgetType.CORRELATION_MATRIX]: {
    stocks: [],
    period: "3m",
  } as CorrelationMatrixSettings,

  [WidgetType.MARKET_WATCHLIST]: {
    stocks: ["CBA", "BHP", "CSL", "WBC", "ANZ"],
    timeInterval: "1m",
    refreshInterval: 120000,
  } as MarketWatchlistSettings,
};

/**
 * Get typed settings for a widget, merging with defaults
 */
export function getTypedSettings<T extends WidgetType>(
  type: T,
  settings?: Partial<WidgetSettingsMap[T]> | Record<string, unknown>
): WidgetSettingsMap[T] {
  const defaults = defaultWidgetSettings[type];
  if (!settings) return defaults;

  return {
    ...defaults,
    ...settings,
  } as WidgetSettingsMap[T];
}

/**
 * Type guard to check if settings match a specific widget type
 */
export function isSettingsOfType<T extends WidgetType>(
  type: T,
  settings: unknown
): settings is WidgetSettingsMap[T] {
  if (!settings || typeof settings !== "object") return false;

  // Basic validation based on widget type
  switch (type) {
    case WidgetType.TOP_SHORTS:
      return "period" in settings || "limit" in settings;
    case WidgetType.WATCHLIST:
      return "watchlist" in settings || "timeInterval" in settings;
    case WidgetType.STOCK_CHART:
      return "stocks" in settings || "period" in settings || "dataTypes" in settings;
    case WidgetType.INDUSTRY_TREEMAP:
      return "period" in settings || "viewMode" in settings;
    case WidgetType.PORTFOLIO_SUMMARY:
      return "portfolio" in settings;
    case WidgetType.TIME_SERIES_ANALYSIS:
      return "analysisType" in settings || "stocks" in settings;
    case WidgetType.SECTOR_PERFORMANCE:
      return "displayType" in settings;
    case WidgetType.CORRELATION_MATRIX:
      return "stocks" in settings;
    case WidgetType.MARKET_WATCHLIST:
      return "stocks" in settings || "timeInterval" in settings;
    default:
      return true;
  }
}

/**
 * Validate and sanitize settings for a widget type
 */
export function validateSettings<T extends WidgetType>(
  type: T,
  settings: unknown
): Partial<WidgetSettingsMap[T]> {
  const defaults = defaultWidgetSettings[type];
  if (!settings || typeof settings !== "object") {
    return defaults;
  }

  const validated: Record<string, unknown> = {};
  const settingsObj = settings as Record<string, unknown>;

  // Copy over valid keys from the settings that match the default structure
  for (const key of Object.keys(defaults)) {
    if (key in settingsObj) {
      validated[key] = settingsObj[key];
    }
  }

  return validated as Partial<WidgetSettingsMap[T]>;
}
