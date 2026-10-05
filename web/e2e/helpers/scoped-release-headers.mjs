/** @param {string} rawUrl */
function trustedOrigin(rawUrl) {
  try {
    const url = new URL(rawUrl);
    const ownedHost = ["shorted.com.au", "www.shorted.com.au", "api.shorted.com.au"].includes(url.hostname) ||
      /^shorted-com-[a-z0-9]+-document-analyser\.vercel\.app$/.test(url.hostname);
    return url.protocol === "https:" && !url.port && ownedHost ? url.origin : null;
  } catch { return null; }
}

/**
 * Preserve ordinary headers; send the test bypass only to the configured,
 * owned app/API origins. Third-party requests keep their own auth headers.
 * @param {string} rawUrl
 * @param {string} appBaseUrl
 * @param {string} apiBaseUrl
 * @param {Record<string, string>} headers
 * @returns {Record<string, string>}
 */
export function scopedReleaseHeaders(rawUrl, appBaseUrl, apiBaseUrl, headers) {
  const result = { ...headers };
  const origin = trustedOrigin(rawUrl);
  const allowed = origin && [trustedOrigin(appBaseUrl), trustedOrigin(apiBaseUrl)].includes(origin);
  if (!allowed) {
    for (const name of Object.keys(result)) {
      if (name.toLowerCase() === "x-shorted-testing-bypass") delete result[name];
    }
  }
  return result;
}

/**
 * @param {import("@playwright/test").BrowserContext} context
 * @param {string} appBaseUrl
 * @param {string} apiBaseUrl
 */
export async function scopeReleaseBrowserHeaders(context, appBaseUrl, apiBaseUrl) {
  await context.route("**/*", (route) => route.fallback({
    headers: scopedReleaseHeaders(route.request().url(), appBaseUrl, apiBaseUrl, route.request().headers()),
  }));
}
