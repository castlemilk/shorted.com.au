/**
 * Query key factory for TanStack Query
 * Provides consistent, type-safe query keys with proper invalidation patterns
 */

export const queryKeys = {
  // Stock-related queries
  stock: {
    all: ["stock"] as const,
    quotes: (codes: string[]) => ["stock", "quotes", codes.sort().join(",")] as const,
    quote: (code: string) => ["stock", "quote", code] as const,
    timeSeries: (code: string, period: string) => ["stock", "timeSeries", code, period] as const,
    search: (query: string) => ["stock", "search", query] as const,
    details: (code: string) => ["stock", "details", code] as const,
  },

  // Market data queries
  market: {
    all: ["market"] as const,
    historical: (code: string, period: string) => ["market", "historical", code, period] as const,
    multipleHistorical: (codes: string[], period: string) =>
      ["market", "historical", "multiple", codes.sort().join(","), period] as const,
  },

  // Short position queries
  shorts: {
    all: ["shorts"] as const,
    top: (period: string, limit: number) => ["shorts", "top", period, limit] as const,
    stock: (code: string) => ["shorts", "stock", code] as const,
    industryTreemap: (period: string) => ["shorts", "industryTreemap", period] as const,
    correlation: (codes: string[], period: string) =>
      ["shorts", "correlation", codes.sort().join(","), period] as const,
  },

  // Dashboard queries
  dashboard: {
    all: ["dashboard"] as const,
    list: (userId: string) => ["dashboard", "list", userId] as const,
    detail: (dashboardId: string) => ["dashboard", "detail", dashboardId] as const,
  },

  // Watchlist queries
  watchlist: {
    all: ["watchlist"] as const,
    data: (codes: string[], period: string) => ["watchlist", codes.sort().join(","), period] as const,
  },

  // Portfolio queries
  portfolio: {
    all: ["portfolio"] as const,
    summary: (holdings: string[]) => ["portfolio", "summary", holdings.sort().join(",")] as const,
  },
} as const;

// Helper type for extracting query key types
export type QueryKey<T extends (...args: unknown[]) => readonly unknown[]> = ReturnType<T>;
