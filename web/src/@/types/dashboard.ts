import { type ComponentType } from "react";

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

export interface WidgetProps {
  config: WidgetConfig;
  data?: unknown;
  isLoading?: boolean;
  error?: Error;
  onSettingsChange?: (settings: Record<string, unknown>) => void;
  onRemove?: () => void;
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