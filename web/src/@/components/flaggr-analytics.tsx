import { PRODUCTION_ANALYTICS_HOSTS } from "~/@/lib/analytics-host";

// This is a public site identifier, not a Flaggr API credential. The pinned
// script and its SRI hash come from https://cdn.flaggr.dev/manifest.json.
const FLAGGR_SITE_ID = "site_869df5560db33f777d73f0f9";
const FLAGGR_SCRIPT = "https://cdn.flaggr.dev/a-0.1.9.js";
const FLAGGR_INTEGRITY =
  "sha384-UbokEwOv+WfuKvg33yULNZRqXEMFKfrK39J4QItWznOG1IXviooN+w65ec5D6izH";

// Runs in the head before hydration, so early browser errors can be observed.
// The external script still loads asynchronously and respects Do Not Track.
export const flaggrAnalyticsBootstrap = `(() => {
  try {
    if (!${JSON.stringify(PRODUCTION_ANALYTICS_HOSTS)}.includes(window.location.hostname) ||
        navigator.doNotTrack === "1" || document.getElementById("flaggr-analytics")) return;
    var script = document.createElement("script");
    script.id = "flaggr-analytics";
    script.async = true;
    script.crossOrigin = "anonymous";
    script.integrity = ${JSON.stringify(FLAGGR_INTEGRITY)};
    script.src = ${JSON.stringify(FLAGGR_SCRIPT)};
    script.setAttribute("data-site-id", ${JSON.stringify(FLAGGR_SITE_ID)});
    script.setAttribute("data-track-errors", "true");
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
