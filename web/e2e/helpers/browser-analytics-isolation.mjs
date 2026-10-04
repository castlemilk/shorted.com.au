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
  // Cloudflare injects this library with Subresource Integrity. Replacing its
  // bytes with an empty response produces an integrity error. Let the signed
  // library load normally; its RUM requests below remain intercepted.
  if (url.origin === "https://static.cloudflareinsights.com" &&
    /^\/beacon\.min\.js(?:\/v[a-f0-9]+)?$/.test(url.pathname)) return false;
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
