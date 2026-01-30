import { type ComponentType } from "react";

// Type-safe widget settings
export interface TopShortsSettings {
  period: "1m" | "3m" | "6m" | "1y" | "2y" | "max";
  limit: number;
}

export interface WatchlistSettings {
  watchlist: string[];
  timeInterval: "1d" | "1w" | "1m" | "3m" | "1y";
}

export interface IndicatorConfig {
  type: "SMA" | "WMA" | "EMA";
  period: number;
  stockCode: string;
  color: string;
  enabled: boolean;
}

export interface StockChartSettings {
  stocks: string[];
  period: "1m" | "3m" | "6m" | "1y" | "2y" | "5y" | "10y" | "max";
  viewMode: "absolute" | "normalized";
  dataTypes: ("shorts" | "market")[];
  indicators: IndicatorConfig[];
  stockShortsVisibility: Record<string, boolean>;
}

export interface IndustryTreemapSettings {
  period: "1m" | "3m" | "6m" | "1y" | "2y" | "max";
  viewMode: "CURRENT_CHANGE" | "PERCENTAGE_CHANGE";
  showSectorGrouping: boolean;
}

export interface PortfolioHolding {
  symbol: string;
  shares: number;
}

export interface PortfolioSummarySettings {
  portfolio: PortfolioHolding[];
  refreshInterval: number;
}

export interface TimeSeriesAnalysisSettings {
  stocks: string[];
  analysisType: "trend" | "volatility" | "comparison";
  period: "1m" | "3m" | "6m" | "1y" | "2y" | "max";
}

export interface SectorPerformanceSettings {
  period: "1d" | "1w" | "1m" | "3m";
  displayType: "pie" | "bar" | "heatmap";
}

export interface CorrelationMatrixSettings {
  stocks: string[];
  period: "1m" | "3m" | "6m" | "1y";
}

export interface MarketWatchlistSettings {
  stocks: string[];
  timeInterval: "1d" | "1w" | "1m" | "3m" | "1y";
  refreshInterval: number;
}

// Map widget types to their settings types
export type WidgetSettingsMap = {
  [WidgetType.TOP_SHORTS]: TopShortsSettings;
  [WidgetType.WATCHLIST]: WatchlistSettings;
  [WidgetType.STOCK_CHART]: StockChartSettings;
  [WidgetType.INDUSTRY_TREEMAP]: IndustryTreemapSettings;
  [WidgetType.PORTFOLIO_SUMMARY]: PortfolioSummarySettings;
  [WidgetType.TIME_SERIES_ANALYSIS]: TimeSeriesAnalysisSettings;
  [WidgetType.SECTOR_PERFORMANCE]: SectorPerformanceSettings;
  [WidgetType.CORRELATION_MATRIX]: CorrelationMatrixSettings;
  [WidgetType.MARKET_WATCHLIST]: MarketWatchlistSettings;
};

export interface WidgetConfig {
  id: string;
  type: WidgetType;
  title: string;
  description?: string;
  dataSource: DataSourceConfig;
  layout: WidgetLayout;
  settings?: Record<string, unknown>;
}

export interface WidgetLayout {
  x: number;
  y: number;
  w: number;
  h: number;
  minW?: number;
  maxW?: number;
  minH?: number;
  maxH?: number;
}

export interface DataSourceConfig {
  endpoint: string;
  params?: Record<string, unknown>;
  refreshInterval?: number;
  cacheKey?: string;
}

export enum WidgetType {
  TOP_SHORTS = "TOP_SHORTS",
  INDUSTRY_TREEMAP = "INDUSTRY_TREEMAP",
  STOCK_CHART = "STOCK_CHART",
  PORTFOLIO_SUMMARY = "PORTFOLIO_SUMMARY",
  WATCHLIST = "WATCHLIST",
  TIME_SERIES_ANALYSIS = "TIME_SERIES_ANALYSIS",
  CORRELATION_MATRIX = "CORRELATION_MATRIX",
  SECTOR_PERFORMANCE = "SECTOR_PERFORMANCE",
  MARKET_WATCHLIST = "MARKET_WATCHLIST",
}

export interface WidgetDefinition {
  type: WidgetType;
  component: ComponentType<WidgetProps>;
  defaultLayout: Partial<WidgetLayout>;
  configSchema?: Record<string, unknown>; // JSON Schema for widget configuration
  icon: ComponentType<{ className?: string }>;
  category: WidgetCategory;
}

export enum WidgetCategory {
  OVERVIEW = "Overview",
  ANALYSIS = "Analysis",
  PORTFOLIO = "Portfolio",
  MARKET_DATA = "Market Data",
}

// Widget size variants for responsive design
export type WidgetSizeVariant = "compact" | "standard" | "expanded";

export interface WidgetProps {
  config: WidgetConfig;
  data?: unknown;
  isLoading?: boolean;
  error?: Error;
  onSettingsChange?: (settings: Record<string, unknown>) => void;
  onRemove?: () => void;
  sizeVariant?: WidgetSizeVariant;
  isVisible?: boolean;
}

export interface DashboardConfig {
  id: string;
  name: string;
  description?: string;
  widgets: WidgetConfig[];
  isDefault?: boolean;
  createdAt: Date;
  updatedAt: Date;
}

export interface DashboardState {
  dashboards: DashboardConfig[];
  activeDashboardId: string | null;
  isEditMode: boolean;
  selectedWidgetId: string | null;
}

// Save status for auto-save functionality
export type SaveStatus = "idle" | "pending" | "saving" | "saved" | "error" | "offline";

export interface SaveState {
  status: SaveStatus;
  lastSavedAt?: Date;
  error?: string;
}
