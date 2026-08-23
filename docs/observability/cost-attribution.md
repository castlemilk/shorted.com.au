# Cost Attribution Observability

Shorted cost attribution uses a shared low-cardinality vocabulary across three layers:

1. Cloudflare RUM: real-user page views and performance by route.
2. Cloudflare Worker `edge_request` logs: API/frontend request volume, cache status, origin, and referer page group.
3. Cloudflare Worker `edge_rate_limit` logs: every edge rate limit decision, by bucket class, window and surface. Rejections are emitted at 100%; allowed decisions are sampled.
3. Web `firestore_operation` logs and OpenTelemetry metrics: Firebase read/write load by feature and collection.
4. Web/backend `product_event` logs: payment, chat, search, and rate-limit funnel attempts.
5. Backend `cost_event` logs and OpenTelemetry metrics: Gemini token usage, embedding input size, and chat tool call payload size.

Do not add user IDs, stock codes, thread IDs, dashboard IDs, raw URLs, or query strings to these events. Use the normalized fields below.

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

**Nowhere durable, yet.** As of 2026-08-23 the account has **no Logpush job configured** on either the zone or the account, so worker `console.log` output is only visible:

1. live via `wrangler tail --format=json` (filter with `jq 'select(.type=="edge_rate_limit")'`), and
2. in the Workers Logs / Log Explorer dashboard, if Workers observability is enabled on the script (the account does hold a `log_explorer_basic` subscription).

To run the SQL below against a real table, an operator must enable **one** of:

- **Logpush** (`workers_trace_events` dataset) to GCS/BigQuery — gives durable, joinable `edge_rate_limit` rows alongside the existing `edge_request` stream. This is the option that makes the `edge_request` join queries possible.
- **Analytics Engine** (`edge_rate_limit_analytics_dataset`, above) — gives aggregates over the rate limit stream only, with no pipeline to run. Cheaper and faster to stand up; cannot join `edge_request`.

The queries below are written against a parsed `edge_rate_limit` table; the Analytics Engine equivalents substitute `blobN`/`doubleN` per the positional schema and use `SUM(_sample_interval)` in place of `COUNT(*)`.

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

## Optimization Loop

1. Use Cloudflare RUM to rank real user page groups.
2. Use `edge_request.referer_group` to find API/cache work caused by those pages.
3. Use `product_event` to confirm which feature flow users are actually attempting.
4. Use backend AI and Firestore events to find the provider cost behind the feature.
5. Optimize the highest `cost per 1,000 page views` first with caching, query limits, batching, or write suppression.
