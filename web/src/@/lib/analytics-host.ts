/** Production measurement must never include localhost or preview traffic. */
export function isProductionAnalyticsHost(hostname: string): boolean {
  return hostname === "shorted.com.au" || hostname === "www.shorted.com.au";
}

export function canCollectAnalytics(): boolean {
  return typeof window !== "undefined" &&
    isProductionAnalyticsHost(window.location.hostname);
}
