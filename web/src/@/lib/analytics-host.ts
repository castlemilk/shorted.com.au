/** Production measurement must never include localhost or preview traffic. */
export const PRODUCTION_ANALYTICS_HOSTS = ["shorted.com.au", "www.shorted.com.au"] as const;

export function isProductionAnalyticsHost(hostname: string): boolean {
  return PRODUCTION_ANALYTICS_HOSTS.some((host) => host === hostname);
}

export function canCollectAnalytics(): boolean {
  return typeof window !== "undefined" &&
    isProductionAnalyticsHost(window.location.hostname);
}
