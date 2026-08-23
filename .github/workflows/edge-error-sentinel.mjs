// Cloudflare edge error-rate sentinel.
//
// Runs from the `Edge Error Sentinel` workflow. Reads the zone's Cloudflare
// GraphQL analytics and alerts when the share of genuine 5xx responses rises.
//
// Exit code 0 = healthy, 1 = breach (or the analytics API could not be read).
// Violations print as TAB-separated CHECK/SOURCE/DETAIL rows, the same shape
// housing-freshness.yml and shorts-data-freshness.mjs use, so the issue body
// reads identically.
//
// ---------------------------------------------------------------------------
// WHY THE FILTERS ARE THE WHOLE POINT (2026-08-23)
// ---------------------------------------------------------------------------
// A naive "5xx rate on this zone" alarm is worthless here, because most of the
// zone's 5xx responses are not requests that failed — they are not requests at
// all. Measured over 24h on 2026-08-23:
//
//   * shorted.com.au   39,962 × 5xx, of which 39,926 (99.9%) were Cloudflare
//     EARLY HINTS PROBES (user-agent "nginx-ssl early hints" / "bastion early
//     hints"). Cloudflare fires these itself to harvest `Link: rel=preload`
//     headers; Next.js on Vercel emits none, so 96% of them timed out. Genuine
//     browser 5xx in the same window: 36, i.e. 0.02%.
//
//   * api.shorted.com.au  ~21% of requests logged as 504. Every one was a GET,
//     but those Connect-RPC paths are POST-only. They are the worker's own
//     Cache API operations surfacing in zone analytics: buildCacheKey()
//     synthesizes a GET Request as the cache key (the Cache API accepts GET
//     keys only), so `cache.match()` / `cache.put()` appear as GET/PUT rows
//     with originResponseStatus=0. The real origin is a *.run.app host OUTSIDE
//     this zone, so a genuine worker->origin fetch cannot appear here at all.
//     Filtering to POST leaves the real client traffic: 61 × 5xx of 14,292
//     requests, i.e. 0.43%.
//
// So: the frontend check EXCLUDES probe user-agents, and the API check counts
// POST only. Without those two filters this alarm would sit at 20-25% forever
// and teach everyone to ignore it — the same failure mode as the housing crawl
// freshness alarm that fired on its own designed steady state.
//
// Early Hints is now off (terraform/modules/cloudflare-edge/main.tf), which is
// why there is a third check: if probe volume returns, someone re-enabled it
// and the frontend is burning ~34k failed origin requests a day again.

export const GRAPHQL_ENDPOINT = "https://api.cloudflare.com/client/v4/graphql";
export const ZONE_ID = "41b338d2d75853d7bedb9a93f1e824f1";

export const FRONTEND_HOSTS = ["shorted.com.au", "www.shorted.com.au"];
export const API_HOST = "api.shorted.com.au";

// Cloudflare's own Early Hints probe user-agents. Matched case-insensitively on
// the substring "early hints" so a third internal variant is excluded too.
export const PROBE_UA_MARKER = "early hints";

// --- Thresholds ------------------------------------------------------------
// Every number below is measured, not guessed. Re-measure before changing one.

// Genuine (non-probe) frontend 5xx. Measured 0.02% over 176,480 requests, so
// 1% is ~50x headroom — high enough never to fire on background noise, low
// enough that a real regression on a page route is caught within a day.
export const FRONTEND_5XX_PCT = 1.0;

// API 5xx on POST traffic only. Measured 0.43% over 14,292 POSTs (61 × 500),
// so 2% is ~5x headroom. Tighter than the frontend because this surface has a
// real, non-zero baseline that we do NOT want to drift upward unnoticed.
export const API_5XX_PCT = 2.0;

// Regression guard: Early Hints is off, so probe volume should be ~0. A small
// floor absorbs any straggling cached probe rather than paging on a single row.
export const EARLY_HINTS_MAX = 500;

// The probe check deliberately uses a SHORTER window than the error rates.
// It is a binary "is the zone setting on or off" signal, not a rate: probes
// fire continuously while Early Hints is enabled, so a few hours is ample to
// detect it. Using the full 24h window would instead mean that for a whole day
// after any fix the sentinel keeps reporting the pre-fix probes and files an
// issue that is already resolved — a guaranteed day-one false alarm, which is
// the fastest way to teach everyone to ignore a red sentinel.
export const PROBE_WINDOW_HOURS = 6;

// Denominator floors. Without these a quiet window (3 requests, 1 error) reads
// as a 33% error rate and pages at 3am over nothing.
export const MIN_FRONTEND_REQUESTS = 500;
export const MIN_API_REQUESTS = 200;

export const WINDOW_HOURS = 24;

// ---------------------------------------------------------------------------

/** ISO-8601 seconds, which is what the Cloudflare `Time` scalar accepts. */
export function isoSeconds(date) {
  return `${date.toISOString().slice(0, 19)}Z`;
}

export function buildQuery() {
  const base = "datetime_geq:$since,datetime_leq:$until";
  const feHosts = JSON.stringify(FRONTEND_HOSTS);
  return (
    "query($zid:String!,$since:Time!,$until:Time!,$probeSince:Time!){viewer{zones(filter:{zoneTag:$zid}){" +
    // Frontend 5xx, broken down by user-agent so probes can be subtracted.
    `frontend5xx:httpRequestsAdaptiveGroups(limit:200,filter:{${base},clientRequestHTTPHost_in:${feHosts},edgeResponseStatus_geq:500,edgeResponseStatus_leq:599},orderBy:[count_DESC])` +
    "{count dimensions{userAgent}}" +
    // Frontend denominator.
    `frontendAll:httpRequestsAdaptiveGroups(limit:1,filter:{${base},clientRequestHTTPHost_in:${feHosts}})` +
    "{count}" +
    // API, POST only, by status — numerator and denominator in one shot.
    `apiPost:httpRequestsAdaptiveGroups(limit:100,filter:{${base},clientRequestHTTPHost:"${API_HOST}",clientRequestHTTPMethodName:"POST"},orderBy:[count_DESC])` +
    "{count dimensions{edgeResponseStatus}}" +
    // Early Hints probe volume across the whole zone (regression guard), over
    // the SHORT window — see PROBE_WINDOW_HOURS.
    "probes:httpRequestsAdaptiveGroups(limit:50,filter:{datetime_geq:$probeSince,datetime_leq:$until},orderBy:[count_DESC])" +
    "{count dimensions{userAgent}}" +
    "}}}"
  );
}

export async function fetchSnapshot({
  fetchImpl = fetch,
  token,
  zoneId = ZONE_ID,
  now = new Date(),
  windowHours = WINDOW_HOURS,
} = {}) {
  if (!token) throw new Error("CLOUDFLARE_ANALYTICS_TOKEN is not set");

  const until = new Date(now.getTime());
  const since = new Date(now.getTime() - windowHours * 3600 * 1000);
  const probeSince = new Date(now.getTime() - PROBE_WINDOW_HOURS * 3600 * 1000);

  const res = await fetchImpl(GRAPHQL_ENDPOINT, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      query: buildQuery(),
      variables: {
        zid: zoneId,
        since: isoSeconds(since),
        until: isoSeconds(until),
        probeSince: isoSeconds(probeSince),
      },
    }),
  });

  if (!res.ok) {
    throw new Error(`Cloudflare GraphQL HTTP ${res.status}`);
  }
  const payload = await res.json();
  if (payload.errors?.length) {
    // Surfacing the message verbatim matters: the usual failure is a token
    // missing `com.cloudflare.api.account.zone.analytics.read`, and that reads
    // nothing like a data problem.
    throw new Error(`Cloudflare GraphQL: ${payload.errors[0].message}`);
  }
  const zone = payload?.data?.viewer?.zones?.[0];
  if (!zone) throw new Error("Cloudflare GraphQL returned no zone data");
  return zone;
}

function isProbeUA(ua) {
  return (ua || "").toLowerCase().includes(PROBE_UA_MARKER);
}

/** Reduce the raw zone response into the handful of numbers we alert on. */
export function summarize(zone) {
  const fe5xxRows = zone.frontend5xx || [];
  const frontend5xxTotal = fe5xxRows.reduce((n, r) => n + r.count, 0);
  const frontend5xxProbes = fe5xxRows
    .filter((r) => isProbeUA(r.dimensions?.userAgent))
    .reduce((n, r) => n + r.count, 0);

  const apiRows = zone.apiPost || [];
  const apiTotal = apiRows.reduce((n, r) => n + r.count, 0);
  const apiPost5xx = apiRows
    .filter((r) => {
      const s = Number(r.dimensions?.edgeResponseStatus);
      return s >= 500 && s <= 599;
    })
    .reduce((n, r) => n + r.count, 0);

  const probeRequests = (zone.probes || [])
    .filter((r) => isProbeUA(r.dimensions?.userAgent))
    .reduce((n, r) => n + r.count, 0);

  return {
    frontendRequests: zone.frontendAll?.[0]?.count ?? 0,
    frontend5xxTotal,
    frontend5xxProbes,
    // The number that actually means "users saw an error".
    frontend5xxReal: frontend5xxTotal - frontend5xxProbes,
    apiPostRequests: apiTotal,
    apiPost5xx,
    probeRequests,
  };
}

const pct = (n, d) => (d > 0 ? (100 * n) / d : 0);
const fmt = (v) => `${v.toFixed(2)}%`;

/** @returns {Array<{check:string,source:string,detail:string}>} violations */
export function evaluate(summary, thresholds = {}) {
  const {
    frontendPct = FRONTEND_5XX_PCT,
    apiPct = API_5XX_PCT,
    earlyHintsMax = EARLY_HINTS_MAX,
    minFrontend = MIN_FRONTEND_REQUESTS,
    minApi = MIN_API_REQUESTS,
  } = thresholds;

  const violations = [];

  if (summary.frontendRequests >= minFrontend) {
    const rate = pct(summary.frontend5xxReal, summary.frontendRequests);
    if (rate > frontendPct) {
      violations.push({
        check: "FRONTEND_5XX",
        source: FRONTEND_HOSTS.join(","),
        detail:
          `${fmt(rate)} of ${summary.frontendRequests} requests returned 5xx ` +
          `(${summary.frontend5xxReal} genuine, probes excluded) — threshold ${fmt(frontendPct)}`,
      });
    }
  }

  if (summary.apiPostRequests >= minApi) {
    const rate = pct(summary.apiPost5xx, summary.apiPostRequests);
    if (rate > apiPct) {
      violations.push({
        check: "API_5XX",
        source: API_HOST,
        detail:
          `${fmt(rate)} of ${summary.apiPostRequests} POST requests returned 5xx ` +
          `(${summary.apiPost5xx}) — threshold ${fmt(apiPct)}. NOTE: GET rows on ` +
          `this host are Cache API operations, not requests; do not count them.`,
      });
    }
  }

  if (summary.probeRequests > earlyHintsMax) {
    violations.push({
      check: "EARLY_HINTS_REENABLED",
      source: "cloudflare zone setting",
      detail:
        `${summary.probeRequests} Early Hints probe requests in the last ${PROBE_WINDOW_HOURS}h ` +
        `(threshold ${earlyHintsMax}). ` +
        `Early Hints should be OFF — 96% of these probes time out against Vercel and ` +
        `generate ~34k failed origin requests/day. Check early_hints in ` +
        `terraform/modules/cloudflare-edge/main.tf.`,
    });
  }

  return violations;
}

export async function run({
  fetchImpl = fetch,
  token = process.env.CLOUDFLARE_ANALYTICS_TOKEN,
  zoneId = process.env.CLOUDFLARE_ZONE_ID || ZONE_ID,
  now = new Date(),
  out = console,
} = {}) {
  let zone;
  try {
    zone = await fetchSnapshot({ fetchImpl, token, zoneId, now });
  } catch (err) {
    // A sentinel that cannot read its own data source must fail loudly rather
    // than report "healthy".
    out.log(["QUERY_FAILED", "cloudflare-graphql", err.message].join("\t"));
    return 1;
  }

  const summary = summarize(zone);
  const violations = evaluate(summary);

  out.log(
    `frontend: ${summary.frontendRequests} requests, ` +
      `${summary.frontend5xxReal} genuine 5xx (${fmt(pct(summary.frontend5xxReal, summary.frontendRequests))}), ` +
      `${summary.frontend5xxProbes} probe 5xx excluded`,
  );
  out.log(
    `api POST: ${summary.apiPostRequests} requests, ` +
      `${summary.apiPost5xx} 5xx (${fmt(pct(summary.apiPost5xx, summary.apiPostRequests))})`,
  );
  out.log(`early-hints probes (last ${PROBE_WINDOW_HOURS}h): ${summary.probeRequests}`);

  for (const v of violations) {
    out.log([v.check, v.source, v.detail].join("\t"));
  }
  return violations.length > 0 ? 1 : 0;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  process.exitCode = await run();
}
