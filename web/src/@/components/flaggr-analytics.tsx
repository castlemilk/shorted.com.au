import { PRODUCTION_ANALYTICS_HOSTS } from "~/@/lib/analytics-host";
import { serializeJsonLd } from "~/@/lib/seo/json-ld";

// This is a public site identifier, not a Flaggr API credential. The pinned
// script and its SRI hash come from https://cdn.flaggr.dev/manifest.json.
const FLAGGR_SITE_ID = "site_869df5560db33f777d73f0f9";
const FLAGGR_SCRIPT = "https://cdn.flaggr.dev/a-0.1.11.js";
const FLAGGR_INTEGRITY =
  "sha384-DEhTV0Cu1DFoo3I77UdD/JWTUk4e2P5vG5OTxFUtVDBZYD3ZWwu6LBo4Tt3KdaL4";
const FLAGGR_CONFIG = serializeJsonLd({
  hosts: PRODUCTION_ANALYTICS_HOSTS,
  integrity: FLAGGR_INTEGRITY,
  script: FLAGGR_SCRIPT,
  siteId: FLAGGR_SITE_ID,
  releaseVersion: process.env.NEXT_PUBLIC_RELEASE_COMMIT,
});

// Runs in the head before hydration, so early browser errors can be observed.
// The external script still loads asynchronously and respects Do Not Track.
export const flaggrAnalyticsBootstrap = `(() => {
  try {
    var config = ${FLAGGR_CONFIG};
    if (!config.hosts.includes(window.location.hostname) ||
        navigator.doNotTrack === "1" || navigator.webdriver === true ||
        navigator.userAgent.includes("Shorted-E2E") ||
        navigator.userAgent.includes("GoogleOther") ||
        document.getElementById("flaggr-analytics")) return;
    // A crawler repeatedly visits this route with a square viewport and
    // empty, space-prefixed fragments from broken connection URLs. Keep the
    // filter narrow: valid links, normal viewports and other routes still count.
    if (/^\\/ownership\\/connections\\/?$/.test(window.location.pathname) &&
        window.innerWidth === 1366 && window.innerHeight === 1366) {
      var params = new URLSearchParams(window.location.search);
      var emptyFragments = 0;
      params.forEach(function(value, key) {
        if (value === "" && key.charAt(0) === " ") emptyFragments++;
      });
      if (emptyFragments >= 1) return;
    }
    var script = document.createElement("script");
    script.id = "flaggr-analytics";
    script.async = true;
    script.crossOrigin = "anonymous";
    script.integrity = config.integrity;
    script.src = config.script;
    script.setAttribute("data-site-id", config.siteId);
    script.setAttribute("data-track-errors", "true");
    if (config.releaseVersion && config.releaseVersion !== "local") {
      script.setAttribute("data-release-version", config.releaseVersion);
    }
    document.head.appendChild(script);
  } catch (_) {
    // Telemetry must never prevent the application from rendering.
  }
})();`;

export function FlaggrAnalytics() {
  return (
    <script
      id="flaggr-analytics-bootstrap"
      dangerouslySetInnerHTML={{ __html: flaggrAnalyticsBootstrap }}
    />
  );
}
