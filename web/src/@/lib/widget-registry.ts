import { type ComponentType } from "react";
import {
  type WidgetDefinition,
  WidgetType,
  WidgetCategory,
  type WidgetProps,
} from "@/types/dashboard";
import {
  TrendingUp,
  BarChart3,
  LineChart,
  PieChart,
  Briefcase,
  Eye,
  Grid3X3,
  Activity,
} from "lucide-react";
import { withErrorBoundary } from "@/components/widgets/with-error-boundary";

// Lazy load widget components
const widgetComponents = {
  [WidgetType.TOP_SHORTS]: () =>
    import("@/components/widgets/top-shorts-widget").then((m) => m.TopShortsWidget),
  [WidgetType.INDUSTRY_TREEMAP]: () =>
    import("@/components/widgets/industry-treemap-widget").then(
      (m) => m.IndustryTreemapWidget
    ),
  [WidgetType.STOCK_CHART]: () =>
    import("@/components/widgets/stock-chart-widget").then((m) => m.StockChartWidget),
  [WidgetType.PORTFOLIO_SUMMARY]: () =>
    import("@/components/widgets/portfolio-summary-widget").then(
      (m) => m.PortfolioSummaryWidget
    ),
  [WidgetType.WATCHLIST]: () =>
    import("@/components/widgets/watchlist-widget").then((m) => m.WatchlistWidget),
  [WidgetType.TIME_SERIES_ANALYSIS]: () =>
    import("@/components/widgets/time-series-widget").then((m) => m.TimeSeriesWidget),
  [WidgetType.CORRELATION_MATRIX]: () =>
    import("@/components/widgets/correlation-matrix-widget").then(
      (m) => m.CorrelationMatrixWidget
    ),
  [WidgetType.SECTOR_PERFORMANCE]: () =>
    import("@/components/widgets/sector-performance-widget").then(
      (m) => m.SectorPerformanceWidget
    ),
};

class WidgetRegistry {
  private widgets = new Map<WidgetType, WidgetDefinition>();
  private loadedComponents = new Map<WidgetType, ComponentType<WidgetProps>>();

  constructor() {
    this.registerDefaultWidgets();
  }

  private registerDefaultWidgets() {
    this.register({
      type: WidgetType.TOP_SHORTS,
      component: {} as ComponentType<WidgetProps>, // Will be loaded dynamically
      defaultLayout: { w: 6, h: 8, minW: 4, minH: 6 },
      icon: TrendingUp,
      category: WidgetCategory.OVERVIEW,
      configSchema: {
        type: "object",
        properties: {
          period: {
            type: "string",
            enum: ["1m", "3m", "6m", "1y", "2y", "max"],
            default: "3m",
          },
          limit: { type: "number", default: 10 },
        },
      },
    });

    this.register({
      type: WidgetType.INDUSTRY_TREEMAP,
      component: {} as ComponentType<WidgetProps>,
      defaultLayout: { w: 6, h: 8, minW: 4, minH: 6 },
      icon: Grid3X3,
      category: WidgetCategory.ANALYSIS,
      configSchema: {
        type: "object",
        properties: {
          period: {
            type: "string",
            enum: ["1m", "3m", "6m", "1y", "2y", "max"],
            default: "3m",
          },
          viewMode: {
            type: "string",
            enum: ["CURRENT_CHANGE", "PERCENTAGE_CHANGE"],
            default: "CURRENT_CHANGE",
          },
          showSectorGrouping: {
            type: "boolean",
            default: true,
            description: "Group stocks by sector/industry",
          },
        },
      },
    });

    this.register({
      type: WidgetType.STOCK_CHART,
      component: {} as ComponentType<WidgetProps>,
      defaultLayout: { w: 8, h: 6, minW: 4, minH: 4 },
      icon: LineChart,
      category: WidgetCategory.MARKET_DATA,
      configSchema: {
        type: "object",
        properties: {
          stockCode: { type: "string" },
          period: {
            type: "string",
            enum: ["1m", "3m", "6m", "1y", "2y", "max"],
            default: "3m",
          },
          chartType: {
            type: "string",
            enum: ["line", "candlestick", "area"],
            default: "line",
          },
        },
      },
    });

    this.register({
      type: WidgetType.TIME_SERIES_ANALYSIS,
      component: {} as ComponentType<WidgetProps>,
      defaultLayout: { w: 12, h: 8, minW: 6, minH: 6 },
      icon: Activity,
      category: WidgetCategory.ANALYSIS,
      configSchema: {
        type: "object",
        properties: {
          stocks: {
            type: "array",
            items: { type: "string" },
            default: [],
          },
          analysisType: {
            type: "string",
            enum: ["trend", "volatility", "comparison"],
            default: "trend",
          },
          period: {
            type: "string",
            enum: ["1m", "3m", "6m", "1y", "2y", "max"],
            default: "3m",
          },
        },
      },
    });

    this.register({
      type: WidgetType.SECTOR_PERFORMANCE,
      component: {} as ComponentType<WidgetProps>,
      defaultLayout: { w: 6, h: 6, minW: 4, minH: 4 },
      icon: PieChart,
      category: WidgetCategory.MARKET_DATA,
      configSchema: {
        type: "object",
        properties: {
          period: {
            type: "string",
            enum: ["1d", "1w", "1m", "3m"],
            default: "1w",
          },
          displayType: {
            type: "string",
            enum: ["pie", "bar", "heatmap"],
            default: "pie",
          },
        },
      },
    });

    this.register({
      type: WidgetType.WATCHLIST,
      component: {} as ComponentType<WidgetProps>,
      defaultLayout: { w: 4, h: 8, minW: 3, minH: 6 },
      icon: Eye,
      category: WidgetCategory.PORTFOLIO,
    });

    this.register({
      type: WidgetType.PORTFOLIO_SUMMARY,
      component: {} as ComponentType<WidgetProps>,
      defaultLayout: { w: 8, h: 4, minW: 6, minH: 3 },
      icon: Briefcase,
      category: WidgetCategory.PORTFOLIO,
    });

    this.register({
      type: WidgetType.CORRELATION_MATRIX,
      component: {} as ComponentType<WidgetProps>,
      defaultLayout: { w: 6, h: 6, minW: 4, minH: 4 },
      icon: BarChart3,
      category: WidgetCategory.ANALYSIS,
      configSchema: {
        type: "object",
        properties: {
          stocks: {
            type: "array",
            items: { type: "string" },
            minItems: 2,
            maxItems: 10,
          },
          period: {
            type: "string",
            enum: ["1m", "3m", "6m", "1y"],
            default: "3m",
          },
        },
      },
    });
  }

  register(definition: WidgetDefinition) {
    this.widgets.set(definition.type, definition);
  }

  async getComponent(type: WidgetType): Promise<ComponentType<WidgetProps>> {
    if (this.loadedComponents.has(type)) {
      return this.loadedComponents.get(type)!;
    }

    const loader = widgetComponents[type];
    if (!loader) {
      throw new Error(`No component loader found for widget type: ${type}`);
    }

    const component = await loader();
    
    // Get widget definition for the name
    const definition = this.getDefinition(type);
    const widgetName = definition ? type.replace(/_/g, ' ').replace(/\b\w/g, l => l.toUpperCase()) : 'Widget';
    
    // Wrap component with error boundary
    const wrappedComponent = withErrorBoundary(component, widgetName);
    
    this.loadedComponents.set(type, wrappedComponent);
    return wrappedComponent;
  }

  getDefinition(type: WidgetType): WidgetDefinition | undefined {
    return this.widgets.get(type);
  }

  getAllDefinitions(): WidgetDefinition[] {
    return Array.from(this.widgets.values());
  }

  getByCategory(category: WidgetCategory): WidgetDefinition[] {
    return this.getAllDefinitions().filter((def) => def.category === category);
  }
}

export const widgetRegistry = new WidgetRegistry();