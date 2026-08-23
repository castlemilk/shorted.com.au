# Cost Attribution Observability

Shorted cost attribution uses a shared low-cardinality vocabulary across three layers:

1. Cloudflare RUM: real-user page views and performance by route.
2. Cloudflare Worker `edge_request` logs: API/frontend request volume, cache status, origin, and referer page group.
3. Cloudflare Worker `edge_rate_limit` logs: every edge rate limit decision, by bucket class, window and surface. Rejections are emitted at 100%; allowed decisions are sampled.
4. Cloudflare Worker **edge health** logs — `edge_origin_error`, `edge_upstream_latency`, `edge_config`, `edge_bypass_used`, `edge_kv_error`, `edge_cache_purge`. Origin health, latency distribution, deployed configuration, bypass usage, KV faults and purge outcomes.
5. Web `firestore_operation` logs and OpenTelemetry metrics: Firebase read/write load by feature and collection.
6. Web/backend `product_event` logs: payment, chat, search, and rate-limit funnel attempts.
7. Backend `cost_event` logs and OpenTelemetry metrics: Gemini token usage, embedding input size, and chat tool call payload size.

Do not add user IDs, stock codes, thread IDs, dashboard IDs, raw URLs, or query strings to these events. Use the normalized fields below.

### The sampling rule for the whole edge stream

One rule governs every edge event type, and it is why the sample rates are not uniform:

> **Rare and actionable is emitted at 100%. Routine and high-volume is sampled.**

Sampling a rare event at 1% does not reduce its cost meaningfully — it makes the event *invisible*, and an invisible alarm reads exactly like a healthy system. So origin errors, KV faults, purge outcomes, testing-bypass usage and rejected bypass attempts are unconditional, while allowed rate limit decisions, upstream latency and routine SSR bypass usage are sampled.

Because rates differ **between arms of the same event type**, every edge event carries the `sample_rate` that produced it. Any query mixing arms must divide each side by its own `sample_rate` before comparing.

Every emitter is a void function wrapped in `try/catch`, is never awaited by the request path, and emits only bounded vocabularies — no raw paths, no query strings, no credentials, no IPs, and **no raw error messages** (a Workers `TypeError` can embed a request URL, and that URL can carry a token). Regression coverage: `services/edge-worker/events.test.mjs` and `services/edge-worker/ratelimit-observability.test.mjs`, both of which grep serialized events for real secret values.

## Cloudflare RUM Setup

Shorted production traffic is proxied through Cloudflare, so prefer Cloudflare Web Analytics automatic setup for `shorted.com.au` and `www.shorted.com.au`. Automatic setup injects the beacon at the Cloudflare edge and reports to the same production hostname's `/cdn-cgi/rum` endpoint, avoiding cross-origin `cloudflareinsights.com` CORS failures.

The app component `web/src/@/components/cloudflare-web-analytics.tsx` exists only as an explicit app-managed fallback. It is disabled by default. Enable it only when Cloudflare automatic injection is not present in the served HTML and the token has been confirmed for the apex production hostname:

```bash
NEXT_PUBLIC_CLOUDFLARE_WEB_ANALYTICS_MANUAL_ENABLED=1
NEXT_PUBLIC_CLOUDFLARE_WEB_ANALYTICS_TOKEN=<shorted.com.au-site-token>
```

When manual mode is enabled, the rendered app beacon intentionally posts to the same-origin Cloudflare endpoint. Do not render the stock manual-only config with just `{"token":"..."}` on a proxied production page; that path posts to `https://cloudflareinsights.com/cdn-cgi/rum` and can fail CORS validation.

```html
<script
  defer
  src="https://static.cloudflareinsights.com/beacon.min.js"
  data-cf-beacon='{"token":"<site-token>","send":{"to":"/cdn-cgi/rum"}}'
></script>
```

The manual script is not rendered unless manual mode is enabled and the token is non-empty. Cloudflare's SPA support tracks client-side route changes through the History API by default, so do not add `spa: true`; only set `spa: false` if route-change tracking must be disabled.

If browser console logs show `POST https://cloudflareinsights.com/cdn-cgi/rum` with `404`/CORS from `shorted.com.au`, the app fallback has regressed to the cross-origin manual endpoint or the wrong snippet is present. Cloudflare documents this error as a hostname mismatch between the browser origin and the configured Web Analytics site, or missing `Referer`/`Origin` headers. The app sends `Referrer-Policy: strict-origin-when-cross-origin`, which is compatible with Cloudflare's requirement.

Use Cloudflare Web Analytics page views as the real-user denominator for cost-per-route queries.

## Edge Request Event

Emitted by `services/edge-worker/worker.js` when `EDGE_ANALYTICS_SAMPLE_RATE` allows the sample.

```json
{
  "type": "edge_request",
  "host": "api.shorted.com.au",
  "path": "/shorts.v1alpha1.ShortsService/GetStock",
  "route_group": "/rpc/shorts/GetStock",
  "referer_group": "/shorts/[code]",
  "feature": "shorts",
  "api_family": "shorts",
  "rpc_method": "GetStock",
  "method": "POST",
  "origin": "shorts",
  "cache_status": "MISS",
  "cacheable": true,
  "status": 200,
  "cache_ttl_seconds": 120,
  "duration_ms": 275,
  "response_bytes": 2048,
  "cf_ray": "abc123-MEL",
  "cf_colo": "MEL",
  "cf_client_bot": false,
  "rate_limited": false,
  "rate_limit_bucket": ""
}
```

Key dimensions:
- `route_group`: normalized current request path. RPC requests use `/rpc/<family>/<method>`.
- `referer_group`: normalized browser page that caused the request, derived from `Referer`.
- `feature`: bounded product area such as `shorts`, `market-data`, `chat`, `community`, `portfolio`, `dashboard`, or `search`.
- `cache_status`: `HOT`, `HIT`, `KV`, `MISS`, `BYPASS`, or `UNKNOWN`.
- `cacheable`: true when the request is intended to be cacheable or was served by a cache layer.
- `rate_limited`: true only when the **edge worker's own** bucket produced the response. A `429` in this stream is otherwise ambiguous — the Go API's app-layer limiter and the Cloudflare zone rule both emit `429` too. The worker's `429` is the only one that carries `X-Shorted-Cache: RATELIMITED` and an `edge-<n>s` scope, and that is what this field keys on.
- `rate_limit_bucket`: the traffic class that rejected (`api-key`, `api-anon`, `first-party`, `browser-anon`, `browser-auth`), or `""` when `rate_limited` is false.

These two fields are **additive**; nothing else in the `edge_request` contract changed. They exist so an existing `edge_request` query can slice out edge rejections without joining another table. For anything more detailed than "was this a 429 from the edge", use `edge_rate_limit` below — `edge_request` is sampled uniformly and will under-count rejections 100x.

## Edge Rate Limit Event

Emitted by `services/edge-worker/worker.js` (`recordRateLimitDecision`) for every rate limit decision the edge worker actually makes. This is the only visibility into edge enforcement: the Cloudflare rate limiting bindings expose no analytics of their own, and a `429` leaves no trace beyond the response.

```json
{
  "type": "edge_rate_limit",
  "decision": "limited",
  "bucket_class": "api-anon",
  "surface": "api",
  "window": "10s",
  "limit": 10,
  "burst_limit": 10,
  "sustained_limit": 30,
  "path": "/shorts.v1alpha1.MarketService/GetTopShorts",
  "route_group": "/rpc/shorts/GetTopShorts",
  "api_family": "shorts",
  "rpc_method": "GetTopShorts",
  "method": "POST",
  "key_type": "ip",
  "bypass_class": "",
  "cf_colo": "MEL",
  "cf_ray": "abc123-MEL",
  "sample_rate": 1
}
```

Field contract:

| Field | Values | Meaning |
|---|---|---|
| `decision` | `limited` \| `allowed` | Whether the request was rejected. |
| `bucket_class` | `api-key`, `api-anon`, `first-party`, `browser-anon`, `browser-auth`, `""` | Traffic class. `""` means no bucket was consulted (a bypass or crawler exemption). |
| `surface` | `api` \| `browser` | Which route the worker was serving. |
| `window` | `10s` \| `60s` \| `""` | Which of the two windows tripped. `""` on every allowed decision. |
| `limit` | number | The ceiling that tripped. `0` on an allowed decision. |
| `burst_limit` | number | The 10s ceiling in effect for this class. |
| `sustained_limit` | number | The 60s ceiling in effect, or `0` for burst-only classes (`first-party`). |
| `path` | string | Normalized via `normalizeAnalyticsPath` — same low-cardinality contract as `edge_request.path`. Never a raw URL or query string. |
| `route_group` | string | Normalized route, `/rpc/<family>/<method>` for RPCs. |
| `api_family` | `shorts`, `market-data`, `chat`, `auth`, `""` | Parsed from the RPC path. |
| `rpc_method` | string | Parsed from the RPC path. |
| `method` | string | HTTP method. |
| `key_type` | `token-hash` \| `ip` \| `session-hash` \| `""` | Which **kind** of identity keyed the bucket. |
| `bypass_class` | `""`, `testing`, `ssr`, `crawler` | Which exemption/marker applied. |
| `cf_colo`, `cf_ray` | string | Cloudflare colo and ray id. |
| `sample_rate` | number | The rate that produced this event. **Load-bearing — see below.** |

### Privacy

The rate limit **key** — an API-token hash, a session-cookie hash, or a raw client IP — is **never** emitted, in any form, hashed or truncated. `key_type` reports only which kind of identity keyed the bucket. Bypass secrets are never emitted either, only the class name that matched. Paths are normalized before emission, so a raw URL or query string cannot leak in. Regression coverage: `services/edge-worker/ratelimit-observability.test.mjs`.

### Sampling is asymmetric, and that is the point

- **`decision: "limited"` is emitted at 100%, always.** Sampling is not applied and no setting can disable it. A `429` is rare and high-signal; at the 1% general analytics rate, a bucket that fires a dozen times a day would show as literally nothing and you would conclude the limiter was idle.
- **`decision: "allowed"` IS sampled** at `EDGE_RATE_LIMIT_SAMPLE_RATE`, which inherits `EDGE_ANALYTICS_SAMPLE_RATE` (default `0.01`) when blank. Allowed decisions are every eligible request on the zone; they are a denominator, not a signal.

**Therefore every ratio query must divide each arm by its own `sample_rate` before comparing**, or the allowed side is under-counted 100x and every rejection rate reads as ~100%. The `sample_rate` field is on every event precisely so this correction is always possible.

### What is and is not emitted

Only decisions where the worker had a say are emitted. Requests skipped before any decision — enforcement disabled (`EDGE_RATE_LIMIT_ENABLED != "true"`), or an ineligible path (HTML documents, static assets, `/api/auth/*`, `/health`) — produce no event. Two skips **are** emitted because they are worth watching:

- `bypass_class: "crawler"` — the verified-crawler exemption. When Cloudflare Bot Management is not populating `request.cf.botManagement`, the worker trusts a crawler **user-agent**, which is spoofable. If this becomes a large share of traffic, that exemption is being abused; set `edge_rate_limit_trust_crawler_ua = false` to require real verification.
- `bypass_class: "testing"` — the E2E bypass. It should be near-zero outside a test run; sustained volume means the bypass secret has leaked.

### Optional: Cloudflare Workers Analytics Engine

`"429s by bucket over the last 7 days"` is a time-series aggregate, and grepping sampled JSON console lines is the wrong tool for it. The worker therefore has an **optional** Analytics Engine `writeDataPoint` path, which gives that question a SQL endpoint with no log pipeline to build.

It is **off by default**. Terraform attaches the binding only when `edge_rate_limit_analytics_dataset` is set to a non-empty dataset name (`terraform/modules/cloudflare-edge`); with no binding, the worker no-ops and the JSON console event — which remains the source of truth — is unaffected. Enable it with:

```hcl
edge_rate_limit_analytics_dataset = "shorted_edge_rate_limit"
```

Analytics Engine requires a Workers Paid subscription, which this account has. Datasets are created implicitly on first write; there is no dataset resource to declare. Cloudflare's ingestion limits are 20 blobs, 20 doubles and 1 index per data point, 96 bytes per index, and 250 data points per invocation — this schema uses 11 blobs, 4 doubles and 1 index, well inside all of them.

**Positional schema.** Analytics Engine columns are positional (`blob1`, `double1`, …), so entries may be **appended but never reordered or removed** without rewriting every saved query:

| Column | Field | | Column | Field |
|---|---|---|---|---|
| `index1` | `bucket_class` | | `blob7` | `api_family` |
| `blob1` | `decision` | | `blob8` | `rpc_method` |
| `blob2` | `bucket_class` | | `blob9` | `path` |
| `blob3` | `surface` | | `blob10` | `method` |
| `blob4` | `window` | | `blob11` | `cf_colo` |
| `blob5` | `key_type` | | `double1` | `limit` |
| `blob6` | `bypass_class` | | `double2` | `burst_limit` |
| | | | `double3` | `sustained_limit` |
| | | | `double4` | `sample_rate` |

Query it via the SQL API (read-only, no dashboard needed):

```bash
curl -sS "https://api.cloudflare.com/client/v4/accounts/$CF_ACCOUNT_ID/analytics_engine/sql" \
  -H "Authorization: Bearer $CF_API_TOKEN" \
  --data "SELECT index1 AS bucket, SUM(_sample_interval) AS events
          FROM shorted_edge_rate_limit
          WHERE timestamp > NOW() - INTERVAL '1' DAY AND blob1 = 'limited'
          GROUP BY bucket ORDER BY events DESC"
```

### Where these logs land today

**Nowhere durable, yet — and this applies to EVERY edge event type in this document** (`edge_request`, `edge_rate_limit`, `edge_origin_error`, `edge_upstream_latency`, `edge_config`, `edge_bypass_used`, `edge_kv_error`, `edge_cache_purge`). As of 2026-08-23 the account has **no Logpush job configured** on either the zone or the account, so worker `console.log` output is only visible:

1. live via `wrangler tail --format=json` (filter with `jq 'select(.type=="edge_rate_limit")'`), and
2. in the Workers Logs / Log Explorer dashboard, if Workers observability is enabled on the script (the account does hold a `log_explorer_basic` subscription).

Until then, every query in this document is a `wrangler tail` filter. That is genuinely usable for the 100% streams, because they are rare by construction:

```bash
# All edge health events, live.
wrangler tail shorted-edge-cache --format=json \
  | jq -r 'select(.logs[]?.message[0]? | fromjson? | .type
        | IN("edge_origin_error","edge_config","edge_bypass_used","edge_kv_error","edge_cache_purge"))'
```

To run the SQL below against a real table, an operator must enable **one** of:

- **Logpush** (`workers_trace_events` dataset) to GCS/BigQuery — gives durable, joinable rows for *every* stream alongside the existing `edge_request` one. This is the option that makes the join queries possible, and the only one that captures `edge_config`, `edge_bypass_used`, `edge_kv_error` and `edge_cache_purge` (none of which write Analytics Engine data points — they are low-volume by design and a SQL aggregate adds nothing a tail filter cannot answer).
- **Analytics Engine** — two optional datasets: `edge_rate_limit_analytics_dataset` (rate limit decisions) and `edge_events_analytics_dataset` (origin errors + upstream latency). Aggregates over those streams only, with no pipeline to run. Cheaper and faster to stand up; cannot join `edge_request`.

The queries below are written against parsed tables named after the event `type`; the Analytics Engine equivalents substitute `blobN`/`doubleN` per the positional schemas and use `SUM(_sample_interval)` in place of `COUNT(*)`.

## Edge Origin Error Event

Emitted by `services/edge-worker/worker.js` (`recordOriginError`, via the `fetchOrigin` wrapper) whenever an origin fetch fails.

**This was previously invisible.** An origin outage surfaced only as user-facing errors; the `edge_request` stream carried the `status` but at a 1% sample, so a Cloud Run service returning 502 for ten minutes produced a handful of sampled lines indistinguishable from noise.

```json
{
  "type": "edge_origin_error",
  "origin": "shorts",
  "status": 503,
  "status_class": "5xx",
  "error_class": "",
  "path": "/shorts.v1alpha1.MarketService/GetTopShorts",
  "route_group": "/rpc/shorts/GetTopShorts",
  "api_family": "shorts",
  "rpc_method": "GetTopShorts",
  "method": "POST",
  "cf_colo": "MEL",
  "cf_ray": "abc123-MEL",
  "duration_ms": 412,
  "served_stale": false,
  "retried": false,
  "sample_rate": 1
}
```

| Field | Values | Meaning |
|---|---|---|
| `origin` | `shorts`, `market-data`, `chat`, `frontend`, `other`, `unknown` | Bounded origin name, resolved from the configured origin URLs. The raw origin URL is **never** emitted — it is a per-revision Cloud Run hostname that changes every deploy and would fragment every group-by. |
| `status` | number | HTTP status, or `0` when the fetch threw before producing a response. A **value**, not a dimension. |
| `status_class` | `1xx`, `3xx`, `5xx`, `error` | The dimension. `error` means the fetch threw. |
| `error_class` | `""`, `timeout`, `aborted`, `network`, `internal` | `""` when the origin answered with a status. Otherwise a bounded classification of the thrown error — **the raw message is discarded**, because a Workers `TypeError` can embed the request URL and its query string. |
| `duration_ms` | number | How long the failing attempt took. `timeout` + a large value is a different incident from `network` + 3ms. |
| `served_stale` | boolean | Whether a cache tier absorbed the failure for the user. See below. |
| `retried` | boolean | `true` on the second attempt of the transparent retry in `proxyWithHeaders` / `proxyFrontend`. **Two events sharing one `cf_ray` means both attempts failed and the user definitely saw an error.** |

**What is deliberately NOT an origin error: 4xx.** A `404`, `401` or `429` from the origin is the origin working correctly and telling a caller something. Emitting those here would bury the rare actionable signal (the origin is broken) under a routine one (a client sent a bad request). A `3xx` **is** counted from the API origins — none of them should ever redirect, so one means a misrouted request or a changed service URL — but is **not** counted from the `frontend` origin, where Vercel redirects are normal traffic.

**About `served_stale`.** As of this change the worker has **no stale-on-error fallback**: on an origin failure the error reaches the user, so this field is always `false`. It is emitted anyway for two reasons. First, `served_stale: false` on a 5xx is the accurate and load-bearing statement that *the user ate the error* — it is not a placeholder. Second, a stale-on-error tier is the obvious next thing to build here, and the "how often did the SWR save us" query should not need rewriting when it lands.

**Sampling: 100%, unconditionally.** No environment variable can sample this stream. Origin failures are rare and always actionable.

## Edge Upstream Latency Event

Emitted by `services/edge-worker/worker.js` (`recordUpstreamLatency`, from `withEdgeAnalytics`) for every request, sampled.

```json
{
  "type": "edge_upstream_latency",
  "origin": "shorts",
  "cache_status": "MISS",
  "duration_bucket": "500-1000ms",
  "status": 200,
  "status_class": "2xx",
  "path": "/shorts.v1alpha1.MarketService/GetTopShorts",
  "route_group": "/rpc/shorts/GetTopShorts",
  "api_family": "shorts",
  "rpc_method": "GetTopShorts",
  "method": "POST",
  "cf_colo": "MEL",
  "cf_ray": "abc123-MEL",
  "cache_ttl_seconds": 300,
  "sample_rate": 0.01
}
```

`duration_bucket` is one of exactly six values, forever: `<50ms`, `50-200ms`, `200-500ms`, `500-1000ms`, `1000-3000ms`, `3000ms+`. **Raw milliseconds are never a dimension here** — `GROUP BY duration_ms` has as many groups as there are requests. The raw number is still available on `edge_request.duration_ms` if you have a table that can compute percentiles.

`cache_status` is the load-bearing field. Comparing the bucket distribution for `HIT`/`HOT`/`KV` against `MISS` **for the same `rpc_method`** is the "is the cache earning its keep" answer, and it is the reason this event carries a cache dimension at all.

**Why this is not redundant with `edge_request.duration_ms`.** It is the same measurement, deliberately. What differs is that it is bucketed and therefore usable as a group-by dimension in **Analytics Engine**, which has no percentile functions and no cheap way to aggregate a raw millisecond column — and Analytics Engine is the only durable destination this account currently has (there is no Logpush job; see below). It also carries its own sample rate, so latency can be turned up to 100% while investigating a regression without multiplying the cost of every other event.

**Sampling:** `EDGE_UPSTREAM_LATENCY_SAMPLE_RATE`, inheriting `EDGE_ANALYTICS_SAMPLE_RATE` (default `0.01`) when blank. A distribution is meaningful at a low rate.

## Edge Config Event

Emitted by `services/edge-worker/worker.js` (`recordEdgeConfigOnce`) **once per isolate**, on the first request that isolate handles, and never again for its lifetime.

**This closes the deploy loop.** Today, "did the config I just deployed actually land?" requires reading Terraform state or querying the Cloudflare API — both of which report what was *intended* or what is *stored*, not what the code running in an isolate right now actually *reads*. Those three have diverged before.

```json
{
  "type": "edge_config",
  "deploy_id": "a1b2c3d4e5f6",
  "cf_colo": "MEL",
  "rate_limit_enabled": true,
  "trust_crawler_ua": true,
  "buckets": {
    "api-key":      { "burst_limit": 100, "sustained_limit": 600,  "burst_bound": true, "sustained_bound": true },
    "api-anon":     { "burst_limit": 10,  "sustained_limit": 30,   "burst_bound": true, "sustained_bound": true },
    "first-party":  { "burst_limit": 600, "sustained_limit": 0,    "burst_bound": true, "sustained_bound": false },
    "browser-anon": { "burst_limit": 100, "sustained_limit": 600,  "burst_bound": true, "sustained_bound": true },
    "browser-auth": { "burst_limit": 200, "sustained_limit": 1200, "burst_bound": true, "sustained_bound": true }
  },
  "sample_rates": {
    "edge_request": 0.01,
    "rate_limit_allowed": 0.01,
    "upstream_latency": 0.01,
    "bypass_routine": 0.01
  },
  "secrets_present": { "testing_bypass": true, "ssr_bypass": true, "cache_purge": true },
  "bypass_markers": {
    "testing_user_agent": "Shorted-E2E",
    "testing_header": "x-shorted-testing-bypass",
    "ssr_user_agent": "shorted-web-ssr",
    "ssr_header": "x-shorted-ssr-bypass"
  },
  "bindings": { "edge_kv": true, "rate_limit_analytics": false, "edge_events_analytics": false },
  "origins": {
    "shorts": "shorts-uiekqxovma-km.a.run.app",
    "market_data": "market-data-uiekqxovma-km.a.run.app",
    "chat": "chat-service-uiekqxovma-km.a.run.app"
  },
  "cache_ttl_seconds": { "default": 60, "top_shorts": 300, "stock_data": 120, "news": 300, "public_daily": 3600, "public_stale": 86400, "hot_cache_ms": 120000 },
  "sample_rate": 1
}
```

- **`deploy_id`** is the field that closes the loop. Terraform sets it to `substr(sha256(file("…/worker.js")), 0, 12)` — derived from the *same* `file()` call that produces the uploaded script, so it cannot drift from what was deployed. Compute the same hash locally and compare:
  ```bash
  shasum -a 256 services/edge-worker/worker.js | cut -c1-12
  ```
- **`burst_bound` / `sustained_bound`** are the highest-value fields in the object. `rate_limit_enabled: true` with `burst_bound: false` means enforcement is configured, believed on, and **silently doing nothing**, because the Cloudflare rate limiting binding never landed. Nothing else in the system reports that state.
- **`secrets_present` is booleans only.** Values are never read into an event, never hashed into one, and never length-reported — a length is a real hint. The bypass **markers** (user-agent substrings, header names) are not secrets and *are* reported, because knowing which marker is configured is the point.
- **`origins` are hostnames, not URLs** — no scheme, no path, no query string. This is what you check after re-pointing an origin at a new Cloud Run revision.

**Once per isolate, guaranteed.** The emitted flag is set *before* the event is built, so even a failure inside the builder cannot turn this into a per-request emitter. Isolates are recycled often enough (deploys, colo churn, eviction) that a fresh snapshot lands from every colo within minutes of any deploy, at no per-request cost. Regression coverage asserts one event across 25 requests and across 500 direct calls.

## Edge Bypass Used Event

Emitted by `services/edge-worker/worker.js` (`recordBypassUsage`) from the top of `fetch`, before any routing decision.

**The gap this closes:** bypass usage previously rode only inside `edge_rate_limit`, which never fires when `EDGE_RATE_LIMIT_ENABLED` is not `"true"`, when the path is ineligible, or when a bypass short-circuits before any bucket is consulted. A leaked E2E secret used against an unlimited path was therefore completely silent.

```json
{
  "type": "edge_bypass_used",
  "bypass_class": "ssr",
  "outcome": "accepted",
  "surface": "api",
  "path": "/shorts.v1alpha1.MarketService/GetTopShorts",
  "route_group": "/rpc/shorts/GetTopShorts",
  "api_family": "shorts",
  "rpc_method": "GetTopShorts",
  "method": "POST",
  "cf_colo": "MEL",
  "cf_ray": "abc123-MEL",
  "enforcement_enabled": true,
  "eligible_path": true,
  "sample_rate": 0.01
}
```

| Field | Values | Meaning |
|---|---|---|
| `bypass_class` | `testing`, `ssr` | Which marker was presented. |
| `outcome` | `accepted`, `rejected`, `unconfigured` | See below. |
| `enforcement_enabled` | boolean | Whether edge rate limiting was on. `false` means `edge_rate_limit` emitted nothing for this request — the gap. |
| `eligible_path` | boolean | Whether the path was rate-limit eligible at all. |

**`outcome` is where the security signal lives:**

- **`accepted`** — marker plus the correct secret. Routine for `ssr`; **alarming for `testing` outside a deliberate test window**, which means the E2E bypass secret has leaked.
- **`rejected`** — the marker was presented with a **wrong or missing** secret while a secret *is* configured. This is somebody probing, and it is the loudest thing in this document.
- **`unconfigured`** — the marker arrived but the worker has **no secret bound** for that class. Not an attack, a misconfiguration — and it is the exact signature of "the SSR secret did not reach Cloudflare", the failure that 429s real users through the Vercel rewrite path.

**Sampling is asymmetric, and this is a deliberate deviation from a flat 100%:**

- **`testing`, every outcome — always 100%.** No knob can sample it away. The E2E bypass should be near-zero outside a test run, so its volume is negligible and its appearance *is* the alarm.
- **Any `rejected` outcome — always 100%.** A wrong secret against a real marker is rare by definition.
- **`ssr` `accepted`/`unconfigured` — sampled** (`EDGE_BYPASS_SAMPLE_RATE`, inheriting `EDGE_ANALYTICS_SAMPLE_RATE`). This arm is *every* first-party request the Vercel rewrites proxy: the steady state, the highest-volume class on the API host, and a condition that is true by design. Emitting it at 100% would mean logging 100% of first-party traffic to observe normality. The `sample_rate` field makes the volume query exact regardless.

## Edge KV Error Event

Emitted by `services/edge-worker/worker.js` (`recordKvError`) when a Workers KV operation fails.

**Why this exists:** KV failures are swallowed in four places in `worker.js`, and every one of those catches is *correct* — a KV fault must never fail a request. The consequence was that a KV outage was invisible while silently converting every cacheable request into an origin fetch. That is a latency event and a Cloud Run bill event that had no log line anywhere.

```json
{
  "type": "edge_kv_error",
  "op": "get",
  "key_kind": "prewarm",
  "error_class": "internal",
  "path": "/shorts.v1alpha1.MarketService/GetTopShorts",
  "route_group": "/rpc/shorts/GetTopShorts",
  "api_family": "shorts",
  "rpc_method": "GetTopShorts",
  "method": "POST",
  "cf_colo": "MEL",
  "cf_ray": "abc123-MEL",
  "suppressed": 0,
  "sample_rate": 1
}
```

| Field | Values | Meaning |
|---|---|---|
| `op` | `get`, `put`, `version-get`, `version-put` | Which operation failed. |
| `key_kind` | `prewarm`, `control` | Which **key space** — never the key. `prewarm` is the cached-response space (a failure costs an origin fetch). `control` is the cache-version pointer; a failure there means **a purge cannot take effect at all**, so stale data is served until TTL. |
| `error_class` | `timeout`, `aborted`, `network`, `internal` | Bounded. The raw message is discarded — it typically contains the failing key. |
| `suppressed` | number | Events dropped by the rate cap since the last emitted one. |

**Rate-capped, at 100% otherwise.** A KV outage is not one failure, it is *every request* failing; at 100% with no cap this emitter would become the outage. The cap is **20 events per isolate per 60s window**, which preserves the signal (you learn KV is broken within one request) while bounding the cost. `suppressed` on the first event of the next window reports exactly how much was dropped, so the volume is never silently understated.

## Edge Cache Purge Event

Emitted by `services/edge-worker/worker.js` (`recordCachePurge`) for every `/api/cache/purge` attempt.

```json
{
  "type": "edge_cache_purge",
  "outcome": "purged",
  "reason": "",
  "hot_entries_cleared": 14,
  "duration_ms": 38,
  "path": "/*page",
  "route_group": "/api/*",
  "api_family": "",
  "rpc_method": "",
  "method": "POST",
  "cf_colo": "MEL",
  "cf_ray": "abc123-MEL",
  "sample_rate": 1
}
```

| Field | Values | Meaning |
|---|---|---|
| `outcome` | `purged`, `failed`, `unauthorized` | |
| `reason` | `""`, `kv-unbound`, `kv-write-failed`, `bad-secret`, `secret-unconfigured` | Bounded reason code, never a raw message. |
| `hot_entries_cleared` | number | In-memory hot cache entries dropped on this isolate. |

**100%, and volume is a non-issue** — a purge happens a handful of times a day (deploys, revalidation sweeps). A **failed** purge means stale data is served for up to the full 24h KV TTL, and the only previous record of it was an HTTP response body nobody reads. `unauthorized` is included deliberately: the purge endpoint takes a shared secret **in the request body**, so repeated unauthorized attempts are someone probing for it. The request body is never echoed into the event.

## Optional: Analytics Engine for origin errors and latency

`edge_origin_error` and `edge_upstream_latency` also have an **optional** Analytics Engine `writeDataPoint` path, behind a **second** dataset binding — `EDGE_EVENTS_ANALYTICS`, distinct from `RATE_LIMIT_ANALYTICS`.

**Two datasets, deliberately.** Analytics Engine columns are positional *per dataset*, and the rate limit schema is pinned to rate limit fields; two differently-shaped events cannot share one table without writing nonsense into each other's columns. These two events *do* share a shape, so they share one dataset keyed by `blob1`/`index1`.

Off by default. Enable with:

```hcl
edge_events_analytics_dataset = "shorted_edge_events"
```

**Positional schema** — entries may be **appended but never reordered or removed**:

| Column | Field | | Column | Field |
|---|---|---|---|---|
| `index1` | `event_kind` | | `blob7` | `path` |
| `blob1` | `event_kind` | | `blob8` | `method` |
| `blob2` | `origin` | | `blob9` | `cf_colo` |
| `blob3` | `outcome_class` | | `blob10` | `route_group` |
| `blob4` | `cache_status` | | `blob11` | `status_class` |
| `blob5` | `api_family` | | `blob12` | `error_class` |
| `blob6` | `rpc_method` | | `double1` | `status` |
| | | | `double2` | `duration_ms` |
| | | | `double3` | `sample_rate` |
| | | | `double4` | `served_stale` (1\|0) |

`event_kind` is `origin_error` or `upstream_latency`. `outcome_class` is the one field whose meaning depends on it: the `status_class` for an origin error, the `duration_bucket` for a latency event — so one `GROUP BY blob3` works for both. 12 blobs, 4 doubles, 1 index: inside Cloudflare's limits of 20/20/1 and 96 bytes per index. Pinned by test in `services/edge-worker/events.test.mjs`.

## Firestore Operation Event

Emitted by `web/src/@/lib/firestore-cost.ts` around server-side Firebase Admin SDK calls.

```json
{
  "type": "firestore_operation",
  "feature": "community",
  "collection": "stock_communities/threads",
  "operation": "query_get",
  "status": "success",
  "duration_ms": 42,
  "documents_read": 12,
  "documents_written": 0,
  "document_count_bucket": "11-50",
  "write_count_bucket": "0",
  "error_name": ""
}
```

OpenTelemetry metrics emitted from the same helper:
- `shorted.firebase.firestore.operations_total`
- `shorted.firebase.firestore.documents_read_total`
- `shorted.firebase.firestore.documents_written_total`
- `shorted.firebase.firestore.operation_duration_ms`

Safe dimensions:
- `feature`
- `collection`
- `operation`
- `status`
- `document_count_bucket`
- `write_count_bucket`

## Product Event

Emitted by `web/src/@/lib/product-events.ts` for browser/server product funnels and by chat backend helpers for chat experience state.

```json
{
  "type": "product_event",
  "feature": "payment",
  "action": "checkout_create",
  "status": "attempt",
  "tier": "premium"
}
```

Safe dimensions:
- `feature`
- `action`
- `status`
- `tier`
- `event_type`
- `error_name`
- `error_type`
- `query_length_bucket`
- `result_count_bucket`
- `route_group`

All property values are bounded before logging. Unknown tiers, raw query strings, or route groups with query strings are collapsed to `unknown`.

## Cost Event

Emitted by chat, news aggregation, and enrichment services for AI-provider and chat-tool cost attribution.

```json
{
  "type": "cost_event",
  "event_type": "gemini_request",
  "feature": "chat",
  "model": "gemini-2.5-flash",
  "phase": "initial",
  "status": "success",
  "prompt_tokens": 120,
  "cached_prompt_tokens": 35,
  "billable_prompt_tokens": 85,
  "candidate_tokens": 40,
  "total_tokens": 160
}
```

Chat tool calls use `event_type = 'chat_tool_call'` and include `tool_name` plus `result_bytes`. News embeddings use `event_type = 'gemini_embedding'` and include `input_chars`.

## Query Examples

Examples assume JSON logs have been parsed into queryable tables named `edge_request`, `firestore_operation`, `product_event`, `cost_event`, and `cloudflare_rum_pageviews`.

### Edge Cache Miss Rate By Referring Page

```sql
SELECT
  referer_group,
  route_group,
  COUNT(*) AS sampled_requests,
  SUM(CASE WHEN cache_status = 'MISS' THEN 1 ELSE 0 END) AS origin_misses,
  SAFE_DIVIDE(SUM(CASE WHEN cache_status = 'MISS' THEN 1 ELSE 0 END), COUNT(*)) AS miss_rate
FROM edge_request
WHERE type = 'edge_request'
  AND cacheable = TRUE
GROUP BY referer_group, route_group
ORDER BY origin_misses DESC;
```

Use this to find high-traffic pages that are still driving origin work.

### Firebase Reads And Writes By Feature

```sql
SELECT
  feature,
  collection,
  operation,
  SUM(documents_read) AS documents_read,
  SUM(documents_written) AS documents_written,
  COUNT(*) AS operations,
  APPROX_QUANTILES(duration_ms, 100)[OFFSET(95)] AS p95_duration_ms
FROM firestore_operation
WHERE type = 'firestore_operation'
GROUP BY feature, collection, operation
ORDER BY documents_read DESC, documents_written DESC;
```

Use this to identify unbounded query reads, repeated read-modify-write flows, and write-heavy features.

### Product Funnel Attempts And Errors

```sql
SELECT
  feature,
  action,
  status,
  tier,
  COUNT(*) AS events
FROM product_event
WHERE type = 'product_event'
GROUP BY feature, action, status, tier
ORDER BY events DESC;
```

Use this to confirm users attempting payment flows, search, chat, and rate-limited actions are visible before optimizing or gating them.

### AI Provider Cost By Feature

```sql
SELECT
  feature,
  model,
  phase,
  status,
  SUM(prompt_tokens) AS prompt_tokens,
  SUM(cached_prompt_tokens) AS cached_prompt_tokens,
  SUM(billable_prompt_tokens) AS billable_prompt_tokens,
  SUM(candidate_tokens) AS candidate_tokens,
  COUNT(*) AS requests
FROM cost_event
WHERE type = 'cost_event'
  AND event_type = 'gemini_request'
GROUP BY feature, model, phase, status
ORDER BY billable_prompt_tokens DESC;
```

Use this to find prompts or features that need tighter limits, stronger caching, smaller context windows, or suppression.

### Edge 429s By Bucket Over Time

```sql
SELECT
  TIMESTAMP_TRUNC(timestamp, HOUR) AS hour,
  bucket_class,
  window,
  COUNT(*) AS rejections
FROM edge_rate_limit
WHERE type = 'edge_rate_limit'
  AND decision = 'limited'
GROUP BY hour, bucket_class, window
ORDER BY hour DESC, rejections DESC;
```

No sample-rate correction is needed: limited decisions are emitted at 100%, so `COUNT(*)` is the true rejection count. This is the first query to run after any limit change, and the one to alert on.

Note that as of 2026-08-23 the worker is routed **only** on `api.shorted.com.au/*`. The `shorted.com.au/*` route does not exist, so `browser-anon` and `browser-auth` will legitimately return **zero rows** — they are configured but inert. If they ever start appearing, the browser route has been added; if you added it and they stay empty, the route did not take.

### Top RPC Methods Being Limited

```sql
SELECT
  bucket_class,
  api_family,
  rpc_method,
  route_group,
  COUNT(*) AS rejections,
  COUNT(DISTINCT cf_colo) AS colos
FROM edge_rate_limit
WHERE type = 'edge_rate_limit'
  AND decision = 'limited'
  AND timestamp > TIMESTAMP_SUB(CURRENT_TIMESTAMP(), INTERVAL 7 DAY)
GROUP BY bucket_class, api_family, rpc_method, route_group
ORDER BY rejections DESC
LIMIT 50;
```

Use this to tell a scraper from a product problem. A rejection concentrated on one expensive RPC is usually a caller looping; rejections spread evenly across many methods are usually a legitimate bulk consumer who needs a higher tier, not a tighter limit. `colos` distinguishes one client (few colos) from distributed traffic.

### Limited-vs-Allowed Ratio Per Surface

```sql
SELECT
  surface,
  bucket_class,
  -- Each arm MUST be divided by its own sample_rate: limited is emitted at
  -- 100% (sample_rate = 1) and allowed is sampled (typically 0.01). Comparing
  -- raw counts overstates the rejection rate by ~100x.
  SUM(CASE WHEN decision = 'limited' THEN 1 / sample_rate ELSE 0 END) AS est_limited,
  SUM(CASE WHEN decision = 'allowed' THEN 1 / sample_rate ELSE 0 END) AS est_allowed,
  SAFE_DIVIDE(
    SUM(CASE WHEN decision = 'limited' THEN 1 / sample_rate ELSE 0 END),
    SUM(1 / sample_rate)
  ) AS est_rejection_rate
FROM edge_rate_limit
WHERE type = 'edge_rate_limit'
  AND timestamp > TIMESTAMP_SUB(CURRENT_TIMESTAMP(), INTERVAL 1 DAY)
GROUP BY surface, bucket_class
ORDER BY est_rejection_rate DESC;
```

These are origin-protection ceilings, not tiers: **nothing at the edge should fire for a real reader or a paying customer.** A non-trivial `est_rejection_rate` on `first-party`, `browser-anon` or `browser-auth` means the number is wrong, not the traffic — raise it. A high rate on `api-anon` is expected and healthy.

### Is Any Bypass Class Being Hit?

```sql
SELECT
  bypass_class,
  surface,
  COUNT(*) AS sampled_events,
  SUM(1 / sample_rate) AS est_requests
FROM edge_rate_limit
WHERE type = 'edge_rate_limit'
  AND bypass_class != ''
  AND timestamp > TIMESTAMP_SUB(CURRENT_TIMESTAMP(), INTERVAL 1 DAY)
GROUP BY bypass_class, surface
ORDER BY est_requests DESC;
```

Three different alarms in one result:
- `testing` outside a test window means the E2E bypass secret has leaked — rotate `TF_VAR_rate_limit_testing_bypass_secret`.
- `crawler` at a large share of traffic means the spoofable-UA crawler exemption is being abused (Bot Management is not populating `verifiedBot`). Set `edge_rate_limit_trust_crawler_ua = false` to require real verification.
- `ssr` is expected and is the healthy case — see the next query.

### Is The First-Party Marker Landing?

```sql
SELECT
  bucket_class,
  SUM(1 / sample_rate) AS est_requests,
  SUM(CASE WHEN decision = 'limited' THEN 1 / sample_rate ELSE 0 END) AS est_rejections
FROM edge_rate_limit
WHERE type = 'edge_rate_limit'
  AND surface = 'api'
  AND bucket_class IN ('first-party', 'api-anon')
  AND timestamp > TIMESTAMP_SUB(CURRENT_TIMESTAMP(), INTERVAL 1 DAY)
GROUP BY bucket_class;
```

**This is the highest-value query here, because it cannot be tested from outside.** The Next.js rewrites in `web/next.config.mjs` proxy Connect-RPC calls through Vercel, so those requests reach the worker from a handful of **shared Vercel egress IPs**. `web/src/middleware.ts` stamps the SSR bypass marker (UA suffix + `x-shorted-ssr-bypass` secret) so the worker routes them to `first-party` instead of `api-anon`. If the middleware deploy regressed or the secret drifted between Cloudflare and Vercel, that marker stops matching, every browser collapses onto a few `api-anon` keys, and real users get 429'd en masse.

Healthy: `first-party` carries meaningful volume and roughly zero rejections. Broken: `first-party` is near zero **and** `api-anon` rejections spike. The same signal is visible live in a response header — an edge 429 carrying `X-RateLimit-Bucket: api-anon` at volume means the marker is not reaching the worker.

### Rate-Limited Requests In The edge_request Stream

```sql
SELECT
  route_group,
  rate_limit_bucket,
  COUNT(*) AS sampled_requests
FROM edge_request
WHERE type = 'edge_request'
  AND rate_limited = TRUE
GROUP BY route_group, rate_limit_bucket
ORDER BY sampled_requests DESC;
```

Use this only to cross-check that the two streams agree, or to correlate a rejection with cache/latency fields that `edge_rate_limit` does not carry. It is uniformly sampled, so it under-counts rejections ~100x — never quote its counts as rejection volume. `edge_rate_limit` is the source of truth for that.

### Is The Origin Healthy Right Now?

```sql
SELECT
  origin,
  status_class,
  error_class,
  api_family,
  rpc_method,
  COUNT(*) AS failures,
  COUNT(DISTINCT cf_colo) AS colos,
  SUM(CASE WHEN retried THEN 1 ELSE 0 END) AS retry_attempts,
  SUM(CASE WHEN served_stale THEN 1 ELSE 0 END) AS absorbed_by_cache,
  APPROX_QUANTILES(duration_ms, 100)[OFFSET(50)] AS p50_failure_ms
FROM edge_origin_error
WHERE type = 'edge_origin_error'
  AND timestamp > TIMESTAMP_SUB(CURRENT_TIMESTAMP(), INTERVAL 15 MINUTE)
GROUP BY origin, status_class, error_class, api_family, rpc_method
ORDER BY failures DESC;
```

**This is the first query to run in any "the site is broken" incident**, and it is emitted at 100%, so `COUNT(*)` is the true failure count with no sample correction.

Read it like this:

- **`error_class = 'timeout'` with a large `p50_failure_ms`** — the origin is up but wedged (cold starts, a slow query, a saturated pool). Check Cloud Run instance count and the database first.
- **`error_class = 'network'` with a tiny `p50_failure_ms`** — the origin is refusing connections outright. It is down or misrouted; check the revision and `edge_config.origins`.
- **`status_class = '5xx'`** — the origin is up and answering, and the fault is in the application.
- **`status_class = '3xx'` from an API origin** — never normal. A Cloud Run service URL changed and the worker is pointed at a stale one.
- **`colos = 1`** — a single-PoP anomaly, not a global outage.
- **`retry_attempts` approaching `failures`/2** — every request is failing twice, so the transparent retry is buying nothing and the origin is comprehensively down.
- **`absorbed_by_cache = 0`** on a large `failures` count — every one of those users saw an error. (Today this is always 0; see the `served_stale` note in the event contract.)

Cross-check against `edge_upstream_latency` for the same `rpc_method`: failures with *healthy* latency elsewhere on the same origin points at one endpoint, not the service.

### Which RPCs Are Slowest, And Is The Cache Helping?

```sql
SELECT
  api_family,
  rpc_method,
  cache_status,
  duration_bucket,
  SUM(1 / sample_rate) AS est_requests,
  SAFE_DIVIDE(
    SUM(1 / sample_rate),
    SUM(SUM(1 / sample_rate)) OVER (PARTITION BY api_family, rpc_method, cache_status)
  ) AS share_of_bucket
FROM edge_upstream_latency
WHERE type = 'edge_upstream_latency'
  AND timestamp > TIMESTAMP_SUB(CURRENT_TIMESTAMP(), INTERVAL 1 DAY)
GROUP BY api_family, rpc_method, cache_status, duration_bucket
ORDER BY api_family, rpc_method, cache_status, duration_bucket;
```

Every row is sampled at the same rate here, but the `1 / sample_rate` correction is kept so the query stays correct if `EDGE_UPSTREAM_LATENCY_SAMPLE_RATE` is changed mid-window.

Read it as a pair of distributions per `rpc_method`:

- **`HIT`/`HOT`/`KV` concentrated in `<50ms` while `MISS` sits in `500-1000ms`+** — the cache is doing exactly its job. The lever is *hit rate* (TTL, prewarm coverage), not origin speed.
- **`MISS` and `HIT` in the same bucket** — the cache is buying nothing for this method. Either the origin is already fast (stop caching it and take the freshness back) or the "hit" is not actually short-circuiting work.
- **`HOT` slower than `HIT`** — the in-memory tier is being poisoned or thrashed; check `buildHotCacheKey` (see the PR #139 hot-cache regression).
- **Any mass in `3000ms+`** — that is at or beyond user abandonment. Cross-reference `edge_origin_error` for the same method: if `timeout` events appear there, this is the same incident seen from the other side.

To rank cheaply, collapse to a single number per method:

```sql
SELECT
  rpc_method,
  cache_status,
  SAFE_DIVIDE(
    SUM(CASE WHEN duration_bucket IN ('1000-3000ms','3000ms+') THEN 1 / sample_rate ELSE 0 END),
    SUM(1 / sample_rate)
  ) AS slow_share
FROM edge_upstream_latency
WHERE type = 'edge_upstream_latency'
  AND timestamp > TIMESTAMP_SUB(CURRENT_TIMESTAMP(), INTERVAL 1 DAY)
GROUP BY rpc_method, cache_status
ORDER BY slow_share DESC;
```

### Did The Config I Just Deployed Actually Reach The Worker?

```sql
SELECT
  deploy_id,
  MIN(timestamp) AS first_seen,
  MAX(timestamp) AS last_seen,
  COUNT(*) AS isolates,
  COUNT(DISTINCT cf_colo) AS colos,
  ANY_VALUE(rate_limit_enabled) AS rate_limit_enabled,
  ANY_VALUE(buckets) AS buckets,
  ANY_VALUE(secrets_present) AS secrets_present,
  ANY_VALUE(origins) AS origins,
  ANY_VALUE(sample_rates) AS sample_rates
FROM edge_config
WHERE type = 'edge_config'
  AND timestamp > TIMESTAMP_SUB(CURRENT_TIMESTAMP(), INTERVAL 2 HOUR)
GROUP BY deploy_id
ORDER BY last_seen DESC;
```

**This is the highest-value query added here, because it closes the deploy loop.** Terraform state says what was *intended*; the Cloudflare API says what is *stored*; this says what the code running in an isolate right now actually *reads*.

Procedure after any `terraform apply` touching the edge:

```bash
# 1. What did I just deploy?
shasum -a 256 services/edge-worker/worker.js | cut -c1-12

# 2. Live, without any log pipeline:
wrangler tail shorted-edge-cache --format=json \
  | jq -r 'select(.logs[]?.message[0]? | fromjson? | .type == "edge_config")'
```

Then check, in order:

1. **`deploy_id` matches the local hash.** If it does not, the script did not upload — the apply reported success against unchanged content, or a route is still bound to an older script.
2. **Two `deploy_id` values are live simultaneously.** Normal for a few minutes after a deploy (old isolates draining). Persisting beyond ~15 minutes means a colo is pinned to the old script.
3. **`isolates` and `colos` are climbing.** One event per isolate means volume here is a rough proxy for isolate churn, and a `deploy_id` seen from only one colo has not propagated.
4. **`buckets[*].burst_bound` is `true` wherever `rate_limit_enabled` is `true`.** This pair is the one thing no other system reports: enforcement configured, believed on, and doing nothing because the binding never landed.
5. **`secrets_present` matches what you set.** `ssr_bypass: false` after a rotation means the Cloudflare side of the rotation did not apply, and first-party traffic is about to be classified as `api-anon` — cross-check with the "Is The First-Party Marker Landing?" query above.
6. **`origins` are the hostnames you expect**, and `sample_rates` are the numbers you set.

### Is KV Degraded, And What Is It Costing?

```sql
SELECT
  op,
  key_kind,
  error_class,
  cf_colo,
  COUNT(*) AS emitted_failures,
  SUM(suppressed) AS dropped_by_cap,
  COUNT(*) + SUM(suppressed) AS est_total_failures
FROM edge_kv_error
WHERE type = 'edge_kv_error'
  AND timestamp > TIMESTAMP_SUB(CURRENT_TIMESTAMP(), INTERVAL 1 HOUR)
GROUP BY op, key_kind, error_class, cf_colo
ORDER BY est_total_failures DESC;
```

100% emission with a 20-per-isolate-per-minute cap, so **always add `suppressed`** — `COUNT(*)` alone understates a real outage by design.

- **`key_kind = 'prewarm'`, `op = 'get'`** — every one of these is a cacheable request that went to origin instead. Correlate with a `MISS` spike in `edge_upstream_latency` and an origin cost bump; this is the silent Cloud Run bill event.
- **`key_kind = 'control'`** — worse than it looks. The cache-version pointer is unreadable or unwritable, which means **a purge cannot take effect at all** and stale data is served until TTL. If a revalidation sweep "worked" but the site is still stale, look here first.
- **`op = 'put'`** — reads still work; the KV tier has stopped backstopping CF cache expiry across PoPs, so cross-region misses will rise gradually rather than immediately.
- **`dropped_by_cap` non-zero** — KV is failing faster than the cap reports. Treat `est_total_failures` as a floor.

### Is Anyone Probing Or Misusing A Bypass?

```sql
SELECT
  bypass_class,
  outcome,
  surface,
  enforcement_enabled,
  route_group,
  COUNT(*) AS sampled_events,
  SUM(1 / sample_rate) AS est_requests,
  COUNT(DISTINCT cf_colo) AS colos
FROM edge_bypass_used
WHERE type = 'edge_bypass_used'
  AND timestamp > TIMESTAMP_SUB(CURRENT_TIMESTAMP(), INTERVAL 1 DAY)
GROUP BY bypass_class, outcome, surface, enforcement_enabled, route_group
ORDER BY est_requests DESC;
```

The `1 / sample_rate` correction is **mandatory** here: `testing` and every `rejected` row is emitted at 100% (`sample_rate = 1`) while routine `ssr` rows are sampled, so raw counts make a leak look smaller than the steady state.

- **`outcome = 'rejected'`, any class** — someone presented a real bypass marker with a wrong secret. Rare by definition; a sustained rate is an active probe. Rotate nothing yet (the secret held), but check whether the marker leaked in a client bundle or a log.
- **`bypass_class = 'testing'`, `outcome = 'accepted'`, outside a test window** — the E2E secret has leaked and is being used. Rotate `TF_VAR_rate_limit_testing_bypass_secret` immediately; this traffic is skipping every edge bucket.
- **`outcome = 'unconfigured'`** — the marker is arriving but no secret is bound. For `ssr` this is the exact signature of "the SSR secret did not reach Cloudflare", and real users are about to be classified as `api-anon` and 429'd through the Vercel rewrite path.
- **`enforcement_enabled = false`** — these requests produced **no** `edge_rate_limit` event at all. This is the visibility gap that `edge_bypass_used` exists to close, and the reason it is emitted from the top of `fetch` rather than from inside the limiter.
- **`ssr` `accepted` volume dropping toward zero** — pair this with the "Is The First-Party Marker Landing?" query; both are measuring the same failure from different sides.

### Did The Last Purge Actually Land?

```sql
SELECT
  timestamp,
  outcome,
  reason,
  hot_entries_cleared,
  duration_ms,
  cf_colo
FROM edge_cache_purge
WHERE type = 'edge_cache_purge'
  AND timestamp > TIMESTAMP_SUB(CURRENT_TIMESTAMP(), INTERVAL 1 DAY)
ORDER BY timestamp DESC
LIMIT 50;
```

Run this whenever a deploy or revalidation sweep did not visibly refresh the site. A `failed` outcome means stale data is being served for up to the full 24h KV TTL, and before this event the only record was an HTTP response body nobody reads.

- **`reason = 'kv-write-failed'`** — the cache-version bump did not persist; nothing was purged anywhere. There will be a matching `edge_kv_error` with `op = 'version-put'`.
- **`reason = 'kv-unbound'`** — the worker has no KV namespace at all. Cross-check `edge_config.bindings.edge_kv`.
- **`outcome = 'unauthorized'` at volume** — the purge endpoint takes its shared secret in the request body, so this is someone probing for it. `reason = 'secret-unconfigured'` is worse: the endpoint is unprotected *and* being hit.
- **`hot_entries_cleared`** is per-isolate, so a small number is normal and is not evidence the purge failed.

### Cost Pressure Per 1,000 Page Views

```sql
WITH rum AS (
  SELECT
    route_group,
    COUNT(*) AS page_views
  FROM cloudflare_rum_pageviews
  GROUP BY route_group
),
edge AS (
  SELECT
    referer_group AS route_group,
    COUNT(*) AS api_requests,
    SUM(CASE WHEN cache_status = 'MISS' THEN 1 ELSE 0 END) AS origin_misses
  FROM edge_request
  WHERE type = 'edge_request'
  GROUP BY referer_group
),
firebase AS (
  SELECT
    feature,
    SUM(documents_read) AS firestore_reads,
    SUM(documents_written) AS firestore_writes
  FROM firestore_operation
  WHERE type = 'firestore_operation'
  GROUP BY feature
)
SELECT
  rum.route_group,
  rum.page_views,
  edge.api_requests,
  edge.origin_misses,
  SAFE_DIVIDE(edge.api_requests * 1000, rum.page_views) AS api_requests_per_1k_views,
  SAFE_DIVIDE(edge.origin_misses * 1000, rum.page_views) AS origin_misses_per_1k_views
FROM rum
LEFT JOIN edge USING (route_group)
ORDER BY origin_misses_per_1k_views DESC;
```

Use this to prioritize cache work by user-visible page rather than raw request volume alone.

## Alert Candidates

- `edge_request`: cacheable `MISS` rate above 25% for a high-volume `route_group`.
- `edge_request`: `chat` requests per 1,000 page views rising faster than signups.
- `firestore_operation`: `documents_read` per `community` page view rising week over week.
- `firestore_operation`: `documents_written` spikes for `dashboard`, `portfolio`, or `watchlist`.
- `firestore_operation`: query buckets reaching `101-500` or `501+` on user-facing paths.
- `product_event`: payment `attempt` volume drops without corresponding `success` or `error`.
- `cost_event`: billable Gemini prompt tokens rise while cached prompt tokens stay flat.
- `cost_event`: chat tool `result_bytes` increases for hot tools, indicating oversized tool responses.
- `edge_rate_limit`: any `limited` decision on `first-party`, `browser-anon` or `browser-auth`. These ceilings are sized so a real reader can never reach them, so a single rejection means the number is wrong.
- `edge_rate_limit`: `first-party` volume drops toward zero while `api-anon` rejections rise — the SSR marker has stopped landing and real users are being 429'd through the Vercel rewrite path.
- `edge_rate_limit`: `bypass_class = 'testing'` outside a known test window (leaked bypass secret).
- `edge_rate_limit`: `bypass_class = 'crawler'` exceeding a meaningful share of API traffic (spoofed crawler UA, Bot Management not verifying).
- `edge_rate_limit`: `api-anon` rejections spiking on one `rpc_method` (a looping or scraping client).
- `edge_origin_error`: **any** sustained rate against one `origin`. This stream is 100% and rare; a non-zero rate for more than a minute or two is an incident, not noise. Page on `error_class = 'network'` (origin refusing connections) faster than on `status_class = '5xx'` (origin up, application faulting).
- `edge_origin_error`: `status_class = '3xx'` from `shorts` / `market-data` / `chat` — an API origin should never redirect; this means the worker is pointed at a stale Cloud Run URL.
- `edge_upstream_latency`: the `1000-3000ms` + `3000ms+` share for a `MISS` on any high-volume `rpc_method` crossing ~10%.
- `edge_upstream_latency`: the bucket distributions for `HIT` and `MISS` on the same `rpc_method` converging — the cache has stopped buying anything.
- `edge_config`: `rate_limit_enabled = true` with any `buckets[*].burst_bound = false`. Enforcement is believed on and is silently doing nothing.
- `edge_config`: more than one `deploy_id` observed for longer than ~15 minutes, or a `deploy_id` that does not match the merged `worker.js`.
- `edge_config`: `secrets_present.ssr_bypass` flipping to `false` — a rotation applied to only one side, and first-party traffic is about to be classified as `api-anon`.
- `edge_bypass_used`: **any** `outcome = 'rejected'`. A real marker with a wrong secret is a probe.
- `edge_bypass_used`: `bypass_class = 'testing'` with `outcome = 'accepted'` outside a known test window (leaked E2E secret in active use).
- `edge_bypass_used`: `outcome = 'unconfigured'` on `ssr` — the marker is landing but no secret is bound on the worker.
- `edge_kv_error`: any `key_kind = 'control'` failure. Purges cannot take effect while this is happening.
- `edge_kv_error`: `dropped_by_cap` (`SUM(suppressed)`) non-zero — KV is failing faster than the emitter reports.
- `edge_cache_purge`: any `outcome = 'failed'`, or `outcome = 'unauthorized'` at volume.

## Optimization Loop

1. Use Cloudflare RUM to rank real user page groups.
2. Use `edge_request.referer_group` to find API/cache work caused by those pages.
3. Use `product_event` to confirm which feature flow users are actually attempting.
4. Use backend AI and Firestore events to find the provider cost behind the feature.
5. Optimize the highest `cost per 1,000 page views` first with caching, query limits, batching, or write suppression.
