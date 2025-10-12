/**
 * Centralized configuration for server actions
 * Uses environment variables with fallbacks for different environments
 */

// Get the Shorts API URL with proper fallbacks
export function getShortsApiUrl(): string {
  return (
    process.env.NEXT_PUBLIC_API_URL ??
    process.env.NEXT_PUBLIC_SHORTS_SERVICE_ENDPOINT ??
    "http://localhost:9091"
  );
}

// Get the Market Data API URL with proper fallbacks
export function getMarketDataApiUrl(): string {
  return (
    process.env.NEXT_PUBLIC_MARKET_DATA_API_URL ??
    process.env.NEXT_PUBLIC_MARKET_DATA_URL ??
    process.env.MARKET_DATA_API_URL ??
    "http://localhost:8090"
  );
}

// Export for convenience
export const SHORTS_API_URL = getShortsApiUrl();
export const MARKET_DATA_API_URL = getMarketDataApiUrl();

// Log URLs in development
if (process.env.NODE_ENV === "development") {
  console.log("Server Action API URLs:", {
    shorts: SHORTS_API_URL,
    marketData: MARKET_DATA_API_URL,
  });
}
