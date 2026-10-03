// Browser release checks must not contribute synthetic sessions or RUM events.
// Restrict interception to collectors; Firebase/OAuth and application traffic
// retain their normal requests, authentication and existing bot controls.
const collectorDomains = [
  "google-analytics.com",
  "googletagmanager.com",
  "doubleclick.net",
  "cloudflareinsights.com",
];

export function isBrowserAnalyticsRequest(url, appOrigin) {
  if (collectorDomains.some((domain) =>
    url.hostname === domain || url.hostname.endsWith(`.${domain}`))) return true;
  return url.origin === appOrigin && (
    url.pathname === "/cdn-cgi/rum" ||
    url.pathname.startsWith("/_vercel/insights/") ||
    url.pathname.startsWith("/_vercel/speed-insights/")
  );
}

export async function isolateBrowserAnalytics(context, baseUrl) {
  const appOrigin = new URL(baseUrl).origin;
  await context.route(
    (url) => isBrowserAnalyticsRequest(url, appOrigin),
    // An empty response prevents collection without producing a network error
    // that obscures unrelated release failures. No request reaches a collector.
    (route) => route.fulfill({ status: 204, body: "" }),
  );
}
