import { planPricePerMonth } from "~/@/config/pricing";

// The roadmap's features, read by both views of /roadmap: the interactive tree
// (roadmap-tree.tsx, a client component) and the server-rendered list beneath
// it (roadmap-feature-list.tsx). One source, so the two cannot disagree.

export type FeatureStatus = "done" | "in-progress" | "planned" | "exploring";
export type FeatureEntitlement = "free" | "account" | "premium" | "api_access" | "enterprise";

export interface Feature {
  id: string;
  name: string;
  description?: string;
  status: FeatureStatus;
  entitlement?: FeatureEntitlement;
  x?: number;
  y?: number;
  children?: Feature[];
}

export const roadmapData: Feature = {
  id: "root",
  name: "Shorted",
  status: "done",
  children: [
    {
      id: "analytics",
      name: "Analytics",
      description:
        "Comprehensive charting and analytics tools for visualizing ASX short positions and trends",
      status: "done",
      children: [
        {
          id: "short-charts",
          name: "Short Charts",
          description:
            "Interactive time-series charts tracking short interest positions over time for ASX stocks",
          status: "done",
        },
        {
          id: "price-data",
          name: "Price Data",
          description:
            "Historical candlestick charts with OHLC (Open, High, Low, Close) data and trading volume",
          status: "done",
        },
        {
          id: "treemap",
          name: "Treemap",
          description:
            "Visual treemap showing short positions organized by industry sectors for easy exploration",
          status: "done",
        },
        {
          id: "indicators",
          name: "Indicators",
          description:
            "Premium technical indicators including RSI, MACD, Bollinger Bands, and short-interest overlays",
          status: "planned",
          entitlement: "premium",
        },
        {
          id: "advanced-dashboards",
          name: "Dashboards",
          description:
            "Premium dashboard widgets for repeat monitoring workflows, saved layouts, and richer cross-stock comparisons",
          status: "in-progress",
          entitlement: "premium",
        },
      ],
    },
    {
      id: "company",
      name: "Company Intel",
      description:
        "AI-powered company insights and comprehensive metadata for ASX-listed companies",
      status: "done",
      children: [
        {
          id: "ai-insights",
          name: "AI Insights",
          description:
            "Machine learning powered company analysis and summaries providing intelligent insights",
          status: "done",
        },
        {
          id: "key-people",
          name: "Key People",
          description:
            "Executive and board member information including leadership team details",
          status: "done",
        },
        {
          id: "reports",
          name: "Reports",
          description:
            "Access to annual reports, financial statements, and company filings",
          status: "done",
        },
        {
          id: "news",
          name: "News",
          description:
            "Real-time news feeds and ASX announcements for companies",
          status: "planned",
        },
        {
          id: "ai-chat",
          name: "AI Chat",
          description:
            "Premium conversational research assistant for stock questions, market context, and portfolio investigation",
          status: "done",
          entitlement: "premium",
        },
        {
          id: "market-pulse",
          name: "Pulse",
          description:
            "Premium market pulse view for surfacing unusual short interest, crowded trades, and emerging risk signals",
          status: "done",
          entitlement: "premium",
        },
      ],
    },
    {
      id: "discovery",
      name: "Discovery",
      description:
        "Powerful search and discovery tools to find and explore ASX stocks efficiently",
      status: "done",
      children: [
        {
          id: "search",
          name: "Search",
          description:
            "Advanced search functionality to find ASX stocks by code, company name, or industry",
          status: "done",
        },
        {
          id: "top-shorts",
          name: "Top Shorts",
          description:
            "Live ranking of the most shorted ASX stocks with real-time updates",
          status: "done",
        },
      ],
    },
    {
      id: "portfolio",
      name: "Portfolio",
      description:
        "Track your stock holdings and monitor short interest exposure across your portfolio",
      status: "done",
    },
    {
      id: "api",
      name: "API",
      description: "Developer tools and programmatic access to Shorted data",
      status: "done",
      children: [
        {
          id: "rest-api",
          name: "REST API",
          description:
            "Paid API Access endpoints for programmatic short position and stock data usage",
          status: "done",
          entitlement: "api_access",
        },
        {
          id: "llm-docs",
          name: "LLM Docs",
          description:
            "AI-optimized documentation designed for LLM agents and copilots",
          status: "done",
        },
        {
          id: "api-tokens",
          name: "API Tokens",
          description:
            "Paid API token management with request limits tied to subscription tier",
          status: "done",
          entitlement: "api_access",
        },
        {
          id: "api-overages",
          name: "Overages",
          description:
            "Usage-based API overages for high-volume customers once request volume justifies metered billing",
          status: "exploring",
          entitlement: "api_access",
        },
      ],
    },
    {
      id: "personal",
      name: "Personal",
      description:
        "Personalized experience with custom views, alerts, and preferences",
      status: "in-progress",
      children: [
        {
          id: "auth",
          name: "Auth",
          description:
            "Secure OAuth authentication with multiple provider support",
          status: "done",
        },
        {
          id: "alerts",
          name: "Alerts",
          description:
            "Premium notifications for short position changes, price targets, portfolio moves, and watchlist events",
          status: "planned",
          entitlement: "premium",
        },
        {
          id: "watchlists",
          name: "Watchlists",
          description:
            "Account-based watchlists that become a conversion path into Premium alerts and monitoring",
          status: "exploring",
          entitlement: "account",
        },
      ],
    },
    {
      id: "commercial",
      name: "Commercial",
      description:
        "Monetisation roadmap for converting investor workflows and developer usage into recurring revenue",
      status: "in-progress",
      children: [
        {
          id: "premium-plan",
          name: "Premium",
          description:
            `${planPricePerMonth("premium")} investor workflow tier bundling AI Chat, Pulse, alerts, advanced dashboards, and priority support`,
          status: "done",
          entitlement: "premium",
        },
        {
          id: "api-access-plan",
          name: "API Access",
          description:
            `${planPricePerMonth("apiAccess")} developer tier for API tokens, higher request limits, and programmatic data access`,
          status: "done",
          entitlement: "api_access",
        },
        {
          id: "team-licenses",
          name: "Teams",
          description:
            "Multi-seat plans for funds, advisory teams, and research groups that need shared watchlists and alerts",
          status: "exploring",
          entitlement: "enterprise",
        },
        {
          id: "data-licensing",
          name: "Data Licensing",
          description:
            "Enterprise feeds, bulk exports, and commercial data licensing for high-volume professional users",
          status: "exploring",
          entitlement: "enterprise",
        },
      ],
    },
  ],
};

export const entitlementMeta: Record<
  FeatureEntitlement,
  { label: string; shortLabel: string; fill: string; text: string }
> = {
  free: {
    label: "Free",
    shortLabel: "F",
    fill: "hsl(var(--muted-foreground))",
    text: "hsl(var(--background))",
  },
  account: {
    label: "Account",
    shortLabel: "A",
    fill: "hsl(var(--secondary))",
    text: "hsl(var(--secondary-foreground))",
  },
  premium: {
    label: "Premium",
    shortLabel: "P",
    fill: "hsl(var(--primary))",
    text: "hsl(var(--primary-foreground))",
  },
  api_access: {
    label: "API Access",
    shortLabel: "API",
    fill: "var(--green)",
    text: "hsl(var(--background))",
  },
  enterprise: {
    label: "Enterprise",
    shortLabel: "E",
    fill: "hsl(var(--foreground))",
    text: "hsl(var(--background))",
  },
};

/** The order the list groups by, and each status's heading. */
export const ROADMAP_STATUSES: readonly FeatureStatus[] = [
  "done",
  "in-progress",
  "planned",
  "exploring",
];

export const ROADMAP_STATUS_LABEL: Record<FeatureStatus, string> = {
  done: "Shipped",
  "in-progress": "In progress",
  planned: "Planned",
  exploring: "Exploring",
};

/** One feature as the list shows it: `area` is the branch it sits under. */
export interface RoadmapFeature {
  id: string;
  name: string;
  description?: string;
  status: FeatureStatus;
  entitlement?: FeatureEntitlement;
  area?: string;
}

/** Every feature under the root, depth first, in the tree's own order. */
export function roadmapFeatures(root: Feature = roadmapData): RoadmapFeature[] {
  const features: RoadmapFeature[] = [];
  const visit = (node: Feature, area: string | undefined) => {
    for (const child of node.children ?? []) {
      features.push({
        id: child.id,
        name: child.name,
        description: child.description,
        status: child.status,
        entitlement: child.entitlement,
        area,
      });
      visit(child, child.name);
    }
  };
  visit(root, undefined);
  return features;
}
