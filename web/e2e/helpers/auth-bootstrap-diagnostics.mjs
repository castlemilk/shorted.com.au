const AUTH_PATHS = new Set(["/__/auth/iframe", "/__/auth/handler"]);
const SDK_CODES = [
  "auth/unauthorized-domain", "auth/popup-blocked", "auth/popup-closed-by-user",
  "auth/cancelled-popup-request", "auth/network-request-failed", "auth/internal-error",
  "auth/operation-not-allowed", "auth/invalid-api-key",
];
const NETWORK_CODES = new Set([
  "net::ERR_FAILED", "net::ERR_TIMED_OUT", "net::ERR_BLOCKED_BY_CLIENT",
  "net::ERR_CONNECTION_RESET", "net::ERR_ABORTED", "net::ERR_NAME_NOT_RESOLVED",
]);

// Only known endpoint classes are returned. URLs, query parameters and headers
// never become diagnostics, including API keys and OAuth state.
export function classifyAuthEndpoint(rawUrl, appOrigin) {
  let url;
  try { url = new URL(rawUrl); } catch { return null; }
  if (AUTH_PATHS.has(url.pathname)) {
    const surface = url.origin === appOrigin ? "app_origin"
      : ["shorted.com.au", "www.shorted.com.au"].includes(url.hostname) && url.protocol === "https:" ? "production_auth_proxy"
      : url.hostname.endsWith(".firebaseapp.com") && url.protocol === "https:" ? "firebase_helper" : null;
    return surface ? { surface, endpoint: url.pathname } : null;
  }
  if (url.protocol === "https:" && (
    url.hostname === "identitytoolkit.googleapis.com" ||
    (url.hostname === "www.googleapis.com" && url.pathname.startsWith("/identitytoolkit/"))
  )) {
    return { surface: "identity_toolkit", endpoint: url.pathname.endsWith(":createAuthUri") || url.pathname.endsWith("/createAuthUri")
      ? "create_auth_uri" : "config_or_other" };
  }
  return null;
}

export function inspectAuthConsole(text, summary) {
  summary.cspPolicyError ||= /Content Security Policy|violates.*(?:frame-src|child-src)/i.test(text);
  for (const code of SDK_CODES) {
    if (text.includes(code) && !summary.sdkErrorCodes.includes(code)) summary.sdkErrorCodes.push(code);
  }
}

export function recordAuthNetwork(summary, endpoint, { status, challenge = false, errorText } = {}) {
  if (!endpoint) return;
  const entry = {
    ...endpoint,
    ...(Number.isInteger(status) && status >= 100 && status <= 599 ? { status } : {}),
    ...(challenge ? { challenge: true } : {}),
    ...(errorText ? { error: NETWORK_CODES.has(errorText) ? errorText : "NETWORK_ERROR" } : {}),
  };
  if (summary.authNetwork.length < 8 && !summary.authNetwork.some((item) => JSON.stringify(item) === JSON.stringify(entry))) {
    summary.authNetwork.push(entry);
  }
}
