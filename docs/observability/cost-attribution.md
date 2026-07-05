# Cost Attribution Observability

Shorted cost attribution uses a shared low-cardinality vocabulary across three layers:

1. Cloudflare RUM: real-user page views and performance by route.
2. Cloudflare Worker `edge_request` logs: API/frontend request volume, cache status, origin, and referer page group.
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
  "cf_client_bot": false
}
```

Key dimensions:
- `route_group`: normalized current request path. RPC requests use `/rpc/<family>/<method>`.
- `referer_group`: normalized browser page that caused the request, derived from `Referer`.
- `feature`: bounded product area such as `shorts`, `market-data`, `chat`, `community`, `portfolio`, `dashboard`, or `search`.
- `cache_status`: `HOT`, `HIT`, `KV`, `MISS`, `BYPASS`, or `UNKNOWN`.
- `cacheable`: true when the request is intended to be cacheable or was served by a cache layer.

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

## Optimization Loop

1. Use Cloudflare RUM to rank real user page groups.
2. Use `edge_request.referer_group` to find API/cache work caused by those pages.
3. Use `product_event` to confirm which feature flow users are actually attempting.
4. Use backend AI and Firestore events to find the provider cost behind the feature.
5. Optimize the highest `cost per 1,000 page views` first with caching, query limits, batching, or write suppression.
