/**
 * Environment configuration
 * Handles different settings for production, preview, and development
 */

export type Environment = "production" | "preview" | "development";

export const environment = (process.env.NEXT_PUBLIC_ENVIRONMENT ??
  "development") as Environment;

// API URLs with fallbacks for different environments
export const config = {
  environment,
  isDevelopment: environment === "development",
  isPreview: environment === "preview",
  isProduction: environment === "production",

  // API endpoints
  api: {
    shorts: process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:9091",
    marketData:
      process.env.NEXT_PUBLIC_MARKET_DATA_API_URL ??
      process.env.NEXT_PUBLIC_MARKET_DATA_URL ??
      "http://localhost:8090",
  },

  // Feature flags for different environments
  features: {
    // Enable debug logging in development and preview
    debugLogging: environment !== "production",

    // Show environment banner in preview
    showEnvironmentBanner: environment === "preview",

    // Enable performance monitoring in production
    performanceMonitoring: environment === "production",

    // Enable error reporting in production
    errorReporting: environment === "production",
  },

  // Cache settings
  cache: {
    // Shorter cache in preview environments
    ttl:
      environment === "production" ? 3600 : environment === "preview" ? 300 : 0,
  },

  // Analytics (only in production)
  analytics: {
    enabled: environment === "production",
    googleAnalyticsId: process.env.NEXT_PUBLIC_GA_ID,
  },
};

// Helper to get environment-specific URLs
export function getApiUrl(service: "shorts" | "marketData" = "shorts"): string {
  return config.api[service];
}

// Helper to check if we're in a preview deployment
export function isPreviewDeployment(): boolean {
  // Check if URL contains PR number pattern
  if (typeof window !== "undefined") {
    return (
      window.location.hostname.includes("pr-") ||
      window.location.hostname.includes("preview")
    );
  }
  return config.isPreview;
}

// Helper to get PR number from preview deployment
export function getPreviewPRNumber(): string | null {
  if (typeof window !== "undefined") {
    const match = window.location.hostname.match(/pr-(\d+)/);
    return match?.[1] ?? null;
  }
  return null;
}

// Log configuration (only in development)
if (config.isDevelopment) {
  console.log("Environment Configuration:", {
    environment: config.environment,
    apis: config.api,
    features: config.features,
  });
}
