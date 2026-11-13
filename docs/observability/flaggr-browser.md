# Flaggr browser monitoring

The production site `site_869df5560db33f777d73f0f9` belongs to the
`Shorted Web` service in Ben Ebsworth's Flaggr project. The root layout loads
the pinned Flaggr analytics script on `shorted.com.au` and
`www.shorted.com.au` only. Preview, local and Discord Activity hosts do not
send to this site. The bootstrap and Flaggr's script honour the browser's
`navigator.doNotTrack` setting. The bootstrap also skips WebDriver-controlled
browsers and user agents containing `Shorted-E2E` or `GoogleOther`, so release
smoke tests and the observed GoogleOther crawler do not distort reports. It
also skips the observed ownership-connections crawler signature: a 1366 × 1366
viewport, a connection selection, and at least three empty, space-prefixed
query fragments. Valid links and other viewports still count. This narrow
heuristic can also exclude a visitor with that exact malformed URL and viewport;
it does not change old events. These are analytics filters, not security
controls; other automated traffic can still appear in the reports.

Flaggr collects page views, Core Web Vitals and uncaught JavaScript errors and
unhandled promise rejections. It follows client-side navigation. Click and
scroll tracking are not enabled by the tag. React/Next error boundaries and
server-side errors caught by application code are not reported by this
integration; use the existing logs for those. No feature flags are currently
published by the browser, so reports will not have flag variant attribution.

The collector sends page URLs, referrers, page titles, performance timings and
error messages and stacks to Flaggr. Flaggr removes fragments and scrubs
credential-like query parameters, email addresses and tokens before storage;
other query values or error text may still contain user-provided information.
The script uses a random per-tab session identifier in sessionStorage and does
not read form fields or cookies. Do not publish user data as Flaggr values or
custom events.

The script is pinned with subresource integrity in
`web/src/@/components/flaggr-analytics.tsx`. To update it, check
`https://cdn.flaggr.dev/manifest.json`, select a non-deprecated release, update
both the URL and hash, and test. The main and embed CSPs in
`web/next.config.mjs` allow the script; `connect-src https:` already permits
`https://ingest.flaggr.dev`.

After deployment, inspect the browser's network requests for a successful POST
to `https://ingest.flaggr.dev/e`, then use the Flaggr MCP with this site ID:

- `list_recent_browser_events` verifies that page views and vitals arrive.
- `get_web_vitals` and `drilldown_browser_analytics` show percentiles and slow
  pages, devices and render traces. Compare samples over a meaningful window.
- `list_browser_issues` groups browser errors for this site. Project-wide
  `list_issues` also includes other applications in the same project.

Flaggr's site analytics queries also include legacy events keyed by the shared
project ID. In this project, the recent-events feed returned records from
September 2026 even though the Shorted site was created on 7 November 2026.
Do not attribute those older records to Shorted; project-level legacy events
can also affect aggregates. Check event timestamps and URLs when assessing a
report, and use a window with known Shorted traffic.

No production telemetry is available until the change is deployed and visitors
have generated events, apart from a labelled manual smoke visit at
`/?flaggr_smoke_test=1`. A zero-error result without traffic is not evidence
that the site is error-free.
