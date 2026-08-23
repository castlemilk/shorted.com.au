// Tests for the Cloudflare edge error-rate sentinel.
//
// The behaviour under test is almost entirely about what does NOT count as an
// error. Both filters exist because the raw zone numbers are dominated by
// synthetic rows: Early Hints probes on the frontend, and Cache API operations
// (logged as GET/PUT with no origin) on the API host. An unfiltered alarm sits
// at 20-25% forever, so these tests pin the exclusions, not just the maths.
import assert from "node:assert/strict";
import test from "node:test";

import {
  API_5XX_PCT,
  EARLY_HINTS_MAX,
  FRONTEND_5XX_PCT,
  MIN_API_REQUESTS,
  MIN_FRONTEND_REQUESTS,
  PROBE_WINDOW_HOURS,
  buildQuery,
  evaluate,
  fetchSnapshot,
  isoSeconds,
  run,
  summarize,
} from "./edge-error-sentinel.mjs";

// ---------------------------------------------------------------------------
// Fixtures — the real 24h shape measured on 2026-08-23.
// ---------------------------------------------------------------------------

function realWorldZone() {
  return {
    frontend5xx: [
      { count: 37283, dimensions: { userAgent: "nginx-ssl early hints" } },
      { count: 2643, dimensions: { userAgent: "bastion early hints" } },
      { count: 7, dimensions: { userAgent: "Mozilla/5.0 AppleWebKit/537.36" } },
      { count: 6, dimensions: { userAgent: "Mozilla/5.0 (compatible; Barkrowler/0.9)" } },
      { count: 6, dimensions: { userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64)" } },
    ],
    frontendAll: [{ count: 176480 }],
    apiPost: [
      { count: 8546, dimensions: { edgeResponseStatus: 200 } },
      { count: 5628, dimensions: { edgeResponseStatus: 429 } },
      { count: 61, dimensions: { edgeResponseStatus: 500 } },
      { count: 32, dimensions: { edgeResponseStatus: 404 } },
      { count: 23, dimensions: { edgeResponseStatus: 400 } },
      { count: 2, dimensions: { edgeResponseStatus: 499 } },
    ],
    probes: [
      { count: 38986, dimensions: { userAgent: "nginx-ssl early hints" } },
      { count: 11146, dimensions: { userAgent: "Mozilla/5.0 (Windows NT 10.0)" } },
    ],
  };
}

/** A healthy post-fix zone: Early Hints off, ordinary error floor. */
function healthyZone() {
  return {
    frontend5xx: [{ count: 20, dimensions: { userAgent: "Mozilla/5.0" } }],
    frontendAll: [{ count: 150000 }],
    apiPost: [
      { count: 14000, dimensions: { edgeResponseStatus: 200 } },
      { count: 30, dimensions: { edgeResponseStatus: 500 } },
    ],
    probes: [{ count: 0, dimensions: { userAgent: "Mozilla/5.0" } }],
  };
}

// ---------------------------------------------------------------------------
// summarize — the exclusions
// ---------------------------------------------------------------------------

test("probe user-agents are excluded from the genuine frontend 5xx count", () => {
  const s = summarize(realWorldZone());
  assert.equal(s.frontend5xxTotal, 39945);
  assert.equal(s.frontend5xxProbes, 39926, "both probe UAs must be caught");
  assert.equal(s.frontend5xxReal, 19, "only real browser 5xx survive");
});

test("probe matching is case-insensitive and substring-based", () => {
  const s = summarize({
    frontend5xx: [
      { count: 100, dimensions: { userAgent: "NGINX-SSL Early Hints" } },
      { count: 50, dimensions: { userAgent: "some-new-internal early hints v2" } },
      { count: 5, dimensions: { userAgent: "Mozilla/5.0" } },
    ],
    frontendAll: [{ count: 1000 }],
    apiPost: [],
    probes: [],
  });
  assert.equal(s.frontend5xxReal, 5, "a third probe variant must not count as real");
});

test("only 5xx statuses count on the API, not 429 or 499", () => {
  const s = summarize(realWorldZone());
  assert.equal(s.apiPostRequests, 14292);
  assert.equal(
    s.apiPost5xx,
    61,
    "429 is a rate limit and 499 is a client cancel — neither is a server error",
  );
});

test("a missing userAgent dimension is treated as a real (non-probe) 5xx", () => {
  // Safe direction: an unknown UA should never be silently excluded.
  const s = summarize({
    frontend5xx: [{ count: 9, dimensions: {} }],
    frontendAll: [{ count: 1000 }],
    apiPost: [],
    probes: [],
  });
  assert.equal(s.frontend5xxReal, 9);
});

// ---------------------------------------------------------------------------
// evaluate — the actual alarm
// ---------------------------------------------------------------------------

test("the real 2026-08-23 numbers do NOT trip the frontend or API alarm", () => {
  // This is the crux. Unfiltered, this window is 22.6% 5xx on the frontend and
  // ~21% on the API. Filtered, it is 0.01% and 0.43% — healthy.
  const v = evaluate(summarize(realWorldZone()));
  assert.ok(
    !v.some((x) => x.check === "FRONTEND_5XX"),
    "the frontend alarm must not fire on probe noise",
  );
  assert.ok(
    !v.some((x) => x.check === "API_5XX"),
    "the API alarm must not fire on Cache API noise",
  );
});

test("that same window DOES flag Early Hints as re-enabled", () => {
  const v = evaluate(summarize(realWorldZone()));
  const hit = v.find((x) => x.check === "EARLY_HINTS_REENABLED");
  assert.ok(hit, "38,986 probes is a regression that must be reported");
  assert.match(hit.detail, /early_hints/);
});

test("a healthy post-fix zone produces no violations at all", () => {
  assert.deepEqual(evaluate(summarize(healthyZone())), []);
});

test("a genuine frontend regression trips the alarm", () => {
  const zone = healthyZone();
  zone.frontend5xx = [{ count: 4500, dimensions: { userAgent: "Mozilla/5.0" } }]; // 3%
  const v = evaluate(summarize(zone));
  const hit = v.find((x) => x.check === "FRONTEND_5XX");
  assert.ok(hit);
  assert.match(hit.detail, /3\.00%/);
});

test("a genuine API regression trips the alarm", () => {
  const zone = healthyZone();
  zone.apiPost = [
    { count: 14000, dimensions: { edgeResponseStatus: 200 } },
    { count: 600, dimensions: { edgeResponseStatus: 503 } }, // ~4.1%
  ];
  const v = evaluate(summarize(zone));
  const hit = v.find((x) => x.check === "API_5XX");
  assert.ok(hit);
  assert.match(hit.detail, /Cache API operations/, "the detail must warn against counting GETs");
});

test("low-traffic windows are not evaluated, so a quiet hour cannot page", () => {
  const v = evaluate(
    summarize({
      frontend5xx: [{ count: 1, dimensions: { userAgent: "Mozilla/5.0" } }],
      frontendAll: [{ count: 3 }],
      apiPost: [
        { count: 1, dimensions: { edgeResponseStatus: 500 } },
        { count: 2, dimensions: { edgeResponseStatus: 200 } },
      ],
      probes: [],
    }),
  );
  assert.deepEqual(v, [], "3 requests with 1 error is not a 33% outage");
});

test("thresholds sit above the measured baselines with real headroom", () => {
  const s = summarize(realWorldZone());
  const fe = (100 * s.frontend5xxReal) / s.frontendRequests;
  const api = (100 * s.apiPost5xx) / s.apiPostRequests;
  assert.ok(fe < FRONTEND_5XX_PCT / 10, `frontend baseline ${fe}% needs 10x+ headroom`);
  assert.ok(api < API_5XX_PCT / 2, `api baseline ${api}% needs 2x+ headroom`);
  assert.ok(MIN_FRONTEND_REQUESTS > 0 && MIN_API_REQUESTS > 0);
  assert.ok(EARLY_HINTS_MAX > 0);
});

// ---------------------------------------------------------------------------
// query + transport
// ---------------------------------------------------------------------------

test("the query filters the API host to POST and bounds 5xx correctly", () => {
  const q = buildQuery();
  assert.match(q, /clientRequestHTTPMethodName:"POST"/, "POST filter is the fix");
  assert.match(q, /edgeResponseStatus_geq:500/);
  assert.match(q, /edgeResponseStatus_leq:599/);
});

test("isoSeconds emits the second-precision form Cloudflare's Time scalar wants", () => {
  assert.equal(isoSeconds(new Date("2026-08-23T07:15:30.123Z")), "2026-08-23T07:15:30Z");
});

test("a permission error surfaces verbatim rather than reading as healthy", async () => {
  const logs = [];
  const code = await run({
    token: "t",
    out: { log: (m) => logs.push(m) },
    fetchImpl: async () => ({
      ok: true,
      json: async () => ({
        data: null,
        errors: [{ message: "does not have permission 'com.cloudflare.api.account.zone.analytics.read'" }],
      }),
    }),
  });
  assert.equal(code, 1, "an unreadable data source must fail, never pass");
  assert.match(logs.join("\n"), /QUERY_FAILED/);
  assert.match(logs.join("\n"), /analytics\.read/);
});

test("a missing token fails rather than silently reporting healthy", async () => {
  const logs = [];
  const code = await run({ token: "", out: { log: (m) => logs.push(m) }, fetchImpl: async () => {
    throw new Error("should not be called");
  } });
  assert.equal(code, 1);
  assert.match(logs.join("\n"), /CLOUDFLARE_ANALYTICS_TOKEN/);
});

test("run exits 0 on a healthy zone and 1 on a breach", async () => {
  const ok = async () => ({ ok: true, json: async () => ({ data: { viewer: { zones: [healthyZone()] } } }) });
  assert.equal(await run({ token: "t", fetchImpl: ok, out: { log() {} } }), 0);

  const bad = structuredClone(healthyZone());
  bad.frontend5xx = [{ count: 4500, dimensions: { userAgent: "Mozilla/5.0" } }];
  const breach = async () => ({ ok: true, json: async () => ({ data: { viewer: { zones: [bad] } } }) });
  assert.equal(await run({ token: "t", fetchImpl: breach, out: { log() {} } }), 1);
});

test("fetchSnapshot sends a bearer token and a bounded time window", async () => {
  let seen = null;
  await fetchSnapshot({
    token: "secret-token",
    now: new Date("2026-08-23T08:00:00Z"),
    fetchImpl: async (url, init) => {
      seen = { url, init };
      return { ok: true, json: async () => ({ data: { viewer: { zones: [healthyZone()] } } }) };
    },
  });
  assert.equal(seen.init.headers.Authorization, "Bearer secret-token");
  const body = JSON.parse(seen.init.body);
  assert.equal(body.variables.since, "2026-08-22T08:00:00Z");
  assert.equal(body.variables.until, "2026-08-23T08:00:00Z");
  // The probe window is deliberately shorter so a fix clears the alarm within
  // hours instead of leaving a stale issue open for a full day.
  assert.equal(body.variables.probeSince, "2026-08-23T02:00:00Z");
});

test("the probe check queries a shorter window than the error rates", () => {
  assert.ok(PROBE_WINDOW_HOURS < 24, "a 24h probe window guarantees a day-one false alarm");
  assert.match(buildQuery(), /probes:httpRequestsAdaptiveGroups\(limit:50,filter:\{datetime_geq:\$probeSince/);
});
