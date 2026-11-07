# Shorted private API

The Connect-RPC methods of api.shorted.com.au that need a credential: a signed-in user's (any account) or an administrator's. Not published; generated for the admin console. The public methods are documented at https://shorted.com.au/docs/api.

Version `1.0.0`.

PRIVATE: generated for the Shorted admin console (/admin/api-docs) from the
protos, with every method that needs a credential. Not published. Regenerate
with `make openapi`.

## Authentication

Every method here needs `Authorization: Bearer <credential>`; each one states
who may call it.

- **Any signed-in account**: a Shorted API token (minted at
  https://shorted.com.au/account) or a Firebase ID token.
- **An administrator**: an administrator's Firebase ID token (a verified
  address on the admin allowlist), or the web tier's internal secret
  asserting the admin role.

A missing or bad credential is `unauthenticated`; a good one without the
role is `permission_denied`. Market moves are posted over plain HTTP, not
Connect: see the Market moves posting API document.

## Base URL

```
https://api.shorted.com.au
```

Most endpoints are Connect-RPC methods on the API host above. A few endpoints
live on the web app instead; those state their own base URL below.

## Endpoints

### shorts.v1alpha1.AlertsService

#### `POST /shorts.v1alpha1.AlertsService/CreateAlertMonitor`

Create a premium short-interest alert monitor for the current user.

Who may call it: any signed-in account.

Request body fields:

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `cadence` | enum (ALERT_MONITOR_CADENCE_UNSPECIFIED \\| ALERT_MONITOR_CADENCE_DAILY \\| ALERT_MONITOR_CADENCE_WEEKLY) | no | (proto shorts.v1alpha1.AlertMonitorCadence) |
| `condition` | enum (ALERT_MONITOR_CONDITION_UNSPECIFIED \\| ALERT_MONITOR_CONDITION_SHORT_INTEREST_ABOVE \\| ALERT_MONITOR_CONDITION_SHORT_INTEREST_RISES \\| ALERT_MONITOR_CONDITION_NEW_TOP_TEN_ENTRY) | no | (proto shorts.v1alpha1.AlertMonitorCondition) |
| `hasThreshold` | boolean | no | (proto bool) |
| `scope` | enum (ALERT_MONITOR_SCOPE_UNSPECIFIED \\| ALERT_MONITOR_SCOPE_INDUSTRY \\| ALERT_MONITOR_SCOPE_STOCK) | no | (proto shorts.v1alpha1.AlertMonitorScope) |
| `target` | string | no | (proto string) |
| `threshold` | number (double) | no | (proto double) |

```bash
curl -X POST 'https://api.shorted.com.au/shorts.v1alpha1.AlertsService/CreateAlertMonitor' \
  -A 'my-app/1.0' \
  -H "Authorization: Bearer $SHORTED_API_TOKEN" \
  -H 'Content-Type: application/json' \
  -H 'Connect-Protocol-Version: 1' \
  -d '{}'
```

#### `POST /shorts.v1alpha1.AlertsService/DeleteAlertMonitor`

Delete one of the current user's monitors and its event history.

Who may call it: any signed-in account.

Request body fields:

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `id` | string | no | (proto string) |

```bash
curl -X POST 'https://api.shorted.com.au/shorts.v1alpha1.AlertsService/DeleteAlertMonitor' \
  -A 'my-app/1.0' \
  -H "Authorization: Bearer $SHORTED_API_TOKEN" \
  -H 'Content-Type: application/json' \
  -H 'Connect-Protocol-Version: 1' \
  -d '{}'
```

#### `POST /shorts.v1alpha1.AlertsService/ListAlertEvents`

Recent alert events (monitors that fired) for the current user, newest report first.

Who may call it: any signed-in account.

Request body fields:

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `limit` | integer (int32) | no | (proto int32) |
| `monitorId` | string | no | Restrict to one of the caller's monitors. Empty means all of them. (proto string) |
| `offset` | integer (int32) | no | (proto int32) |

```bash
curl -X POST 'https://api.shorted.com.au/shorts.v1alpha1.AlertsService/ListAlertEvents' \
  -A 'my-app/1.0' \
  -H "Authorization: Bearer $SHORTED_API_TOKEN" \
  -H 'Content-Type: application/json' \
  -H 'Connect-Protocol-Version: 1' \
  -d '{}'
```

#### `POST /shorts.v1alpha1.AlertsService/ListAlertMonitors`

List short-interest alert monitors for the current user.

Who may call it: any signed-in account.

Request body fields:

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `limit` | integer (int32) | no | (proto int32) |
| `offset` | integer (int32) | no | (proto int32) |

```bash
curl -X POST 'https://api.shorted.com.au/shorts.v1alpha1.AlertsService/ListAlertMonitors' \
  -A 'my-app/1.0' \
  -H "Authorization: Bearer $SHORTED_API_TOKEN" \
  -H 'Content-Type: application/json' \
  -H 'Connect-Protocol-Version: 1' \
  -d '{}'
```

#### `POST /shorts.v1alpha1.AlertsService/UpdateAlertMonitorStatus`

Pause or resume one of the current user's monitors. Resuming requires Premium.

Who may call it: any signed-in account.

Request body fields:

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `id` | string | no | (proto string) |
| `status` | enum (ALERT_MONITOR_STATUS_UNSPECIFIED \\| ALERT_MONITOR_STATUS_ACTIVE \\| ALERT_MONITOR_STATUS_PAUSED) | no | (proto shorts.v1alpha1.AlertMonitorStatus) |

```bash
curl -X POST 'https://api.shorted.com.au/shorts.v1alpha1.AlertsService/UpdateAlertMonitorStatus' \
  -A 'my-app/1.0' \
  -H "Authorization: Bearer $SHORTED_API_TOKEN" \
  -H 'Content-Type: application/json' \
  -H 'Connect-Protocol-Version: 1' \
  -d '{}'
```

### shorts.v1alpha1.BillingService

#### `POST /shorts.v1alpha1.BillingService/GetMySubscription`

Get the current user's subscription status. Requires authentication.

Who may call it: any signed-in account.

Request body: an empty JSON object, `{}`.

```bash
curl -X POST 'https://api.shorted.com.au/shorts.v1alpha1.BillingService/GetMySubscription' \
  -A 'my-app/1.0' \
  -H "Authorization: Bearer $SHORTED_API_TOKEN" \
  -H 'Content-Type: application/json' \
  -H 'Connect-Protocol-Version: 1' \
  -d '{}'
```

#### `POST /shorts.v1alpha1.BillingService/MintToken`

Mint an API token for the user. Requires valid authentication.

Who may call it: any signed-in account.

Request body: an empty JSON object, `{}`.

```bash
curl -X POST 'https://api.shorted.com.au/shorts.v1alpha1.BillingService/MintToken' \
  -A 'my-app/1.0' \
  -H "Authorization: Bearer $SHORTED_API_TOKEN" \
  -H 'Content-Type: application/json' \
  -H 'Connect-Protocol-Version: 1' \
  -d '{}'
```

### shorts.v1alpha1.EnrichmentService

#### `POST /shorts.v1alpha1.EnrichmentService/EnrichStock`

Trigger enrichment for a specific stock. Admin only.
 Returns enrichment data for review before applying to company-metadata.

Who may call it: an administrator (`admin` role).

Request body fields:

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `force` | boolean | no | If true, re-enrich even if already enriched (proto bool) |
| `stockCode` | string | no | Stock code to enrich (e.g., "CBA") (proto string) |

```bash
curl -X POST 'https://api.shorted.com.au/shorts.v1alpha1.EnrichmentService/EnrichStock' \
  -A 'my-app/1.0' \
  -H "Authorization: Bearer $SHORTED_API_TOKEN" \
  -H 'Content-Type: application/json' \
  -H 'Connect-Protocol-Version: 1' \
  -d '{}'
```

#### `POST /shorts.v1alpha1.EnrichmentService/GetEnrichmentJobStatus`

Get enrichment job status by job ID. Admin only.

Who may call it: an administrator (`admin` role).

Request body fields:

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `jobId` | string | no | (proto string) |

```bash
curl -X POST 'https://api.shorted.com.au/shorts.v1alpha1.EnrichmentService/GetEnrichmentJobStatus' \
  -A 'my-app/1.0' \
  -H "Authorization: Bearer $SHORTED_API_TOKEN" \
  -H 'Content-Type: application/json' \
  -H 'Connect-Protocol-Version: 1' \
  -d '{}'
```

#### `POST /shorts.v1alpha1.EnrichmentService/GetPendingEnrichment`

Get a specific pending enrichment by ID. Admin only.

Who may call it: an administrator (`admin` role).

Request body fields:

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `enrichmentId` | string | no | (proto string) |

```bash
curl -X POST 'https://api.shorted.com.au/shorts.v1alpha1.EnrichmentService/GetPendingEnrichment' \
  -A 'my-app/1.0' \
  -H "Authorization: Bearer $SHORTED_API_TOKEN" \
  -H 'Content-Type: application/json' \
  -H 'Connect-Protocol-Version: 1' \
  -d '{}'
```

#### `POST /shorts.v1alpha1.EnrichmentService/GetTopStocksForEnrichment`

Get top stocks for enrichment batching/prioritization. Admin only.

Who may call it: an administrator (`admin` role).

Request body fields:

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `limit` | integer (int32) | no | Number of stocks to return (default: 100) (proto int32) |
| `priority` | enum (ENRICHMENT_PRIORITY_UNSPECIFIED \\| ENRICHMENT_PRIORITY_MARKET_CAP \\| ENRICHMENT_PRIORITY_SHORT_POSITION \\| ENRICHMENT_PRIORITY_UNENRICHED \\| ENRICHMENT_PRIORITY_STALE) | no | How to prioritize stocks (proto shorts.v1alpha1.EnrichmentPriority) |

```bash
curl -X POST 'https://api.shorted.com.au/shorts.v1alpha1.EnrichmentService/GetTopStocksForEnrichment' \
  -A 'my-app/1.0' \
  -H "Authorization: Bearer $SHORTED_API_TOKEN" \
  -H 'Content-Type: application/json' \
  -H 'Connect-Protocol-Version: 1' \
  -d '{}'
```

#### `POST /shorts.v1alpha1.EnrichmentService/ListEnrichmentJobs`

List enrichment jobs with optional status filter. Admin only.

Who may call it: an administrator (`admin` role).

Request body fields:

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `limit` | integer (int32) | no | Default: 100 (proto int32) |
| `offset` | integer (int32) | no | Default: 0 (proto int32) |
| `status` | enum (ENRICHMENT_JOB_STATUS_UNSPECIFIED \\| ENRICHMENT_JOB_STATUS_QUEUED \\| ENRICHMENT_JOB_STATUS_PROCESSING \\| ENRICHMENT_JOB_STATUS_COMPLETED \\| ENRICHMENT_JOB_STATUS_FAILED \\| ENRICHMENT_JOB_STATUS_CANCELLED) | no | Optional filter by status (proto shorts.v1alpha1.EnrichmentJobStatus) |

```bash
curl -X POST 'https://api.shorted.com.au/shorts.v1alpha1.EnrichmentService/ListEnrichmentJobs' \
  -A 'my-app/1.0' \
  -H "Authorization: Bearer $SHORTED_API_TOKEN" \
  -H 'Content-Type: application/json' \
  -H 'Connect-Protocol-Version: 1' \
  -d '{}'
```

#### `POST /shorts.v1alpha1.EnrichmentService/ListPendingEnrichments`

List pending enrichments awaiting review. Admin only.

Who may call it: an administrator (`admin` role).

Request body fields:

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `limit` | integer (int32) | no | Default: 100 (proto int32) |
| `offset` | integer (int32) | no | Default: 0 (proto int32) |

```bash
curl -X POST 'https://api.shorted.com.au/shorts.v1alpha1.EnrichmentService/ListPendingEnrichments' \
  -A 'my-app/1.0' \
  -H "Authorization: Bearer $SHORTED_API_TOKEN" \
  -H 'Content-Type: application/json' \
  -H 'Connect-Protocol-Version: 1' \
  -d '{}'
```

#### `POST /shorts.v1alpha1.EnrichmentService/ReviewEnrichment`

Approve or reject a pending enrichment. Admin only.

Who may call it: an administrator (`admin` role).

Request body fields:

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `approve` | boolean | no | true to approve, false to reject (proto bool) |
| `enrichmentId` | string | no | ID from EnrichStockResponse (proto string) |
| `reviewNotes` | string | no | Optional notes about the review (proto string) |
| `stockCode` | string | no | (proto string) |

```bash
curl -X POST 'https://api.shorted.com.au/shorts.v1alpha1.EnrichmentService/ReviewEnrichment' \
  -A 'my-app/1.0' \
  -H "Authorization: Bearer $SHORTED_API_TOKEN" \
  -H 'Content-Type: application/json' \
  -H 'Connect-Protocol-Version: 1' \
  -d '{}'
```

#### `POST /shorts.v1alpha1.EnrichmentService/SyncKeyMetrics`

Trigger key metrics sync for specific stocks. Admin only.

Who may call it: an administrator (`admin` role).

Request body fields:

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `force` | boolean | no | Force sync even if recently updated (default: false) (proto bool) |
| `stockCodes` | array of string | no | Stock codes to sync (e.g., ["CVN", "CBA"]). Empty = sync all. (proto string) |

```bash
curl -X POST 'https://api.shorted.com.au/shorts.v1alpha1.EnrichmentService/SyncKeyMetrics' \
  -A 'my-app/1.0' \
  -H "Authorization: Bearer $SHORTED_API_TOKEN" \
  -H 'Content-Type: application/json' \
  -H 'Connect-Protocol-Version: 1' \
  -d '{}'
```

### shorts.v1alpha1.MarketService

#### `POST /shorts.v1alpha1.MarketService/GetSyncStatus`

Get sync status for admin dashboard

Who may call it: an administrator (`admin` role).

Request body fields:

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `limit` | integer (int32) | no | Number of past runs to return (default: 10) (proto int32) |

```bash
curl -X POST 'https://api.shorted.com.au/shorts.v1alpha1.MarketService/GetSyncStatus' \
  -A 'my-app/1.0' \
  -H "Authorization: Bearer $SHORTED_API_TOKEN" \
  -H 'Content-Type: application/json' \
  -H 'Connect-Protocol-Version: 1' \
  -d '{}'
```

### shorts.v1alpha1.NewsService

#### `POST /shorts.v1alpha1.NewsService/DeleteEditorialTake`

Admin: hard delete a take.

Who may call it: any signed-in account.

Request body fields:

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `slug` | string | no | (proto string) |

```bash
curl -X POST 'https://api.shorted.com.au/shorts.v1alpha1.NewsService/DeleteEditorialTake' \
  -A 'my-app/1.0' \
  -H "Authorization: Bearer $SHORTED_API_TOKEN" \
  -H 'Content-Type: application/json' \
  -H 'Connect-Protocol-Version: 1' \
  -d '{}'
```

#### `POST /shorts.v1alpha1.NewsService/ListEditorialTakesAdmin`

Admin: list all takes including drafts (admin-gated).

Who may call it: any signed-in account.

Request body fields:

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `limit` | integer (int32) | no | (proto int32) |
| `offset` | integer (int32) | no | (proto int32) |
| `statusFilter` | enum (TAKE_STATUS_UNSPECIFIED \\| TAKE_STATUS_DRAFT \\| TAKE_STATUS_PUBLISHED \\| TAKE_STATUS_TWEETED) | no | optional (proto shorts.v1alpha1.TakeStatus) |

```bash
curl -X POST 'https://api.shorted.com.au/shorts.v1alpha1.NewsService/ListEditorialTakesAdmin' \
  -A 'my-app/1.0' \
  -H "Authorization: Bearer $SHORTED_API_TOKEN" \
  -H 'Content-Type: application/json' \
  -H 'Connect-Protocol-Version: 1' \
  -d '{}'
```

#### `POST /shorts.v1alpha1.NewsService/ListTweetPublishQueue`

Admin: list takes in the tweet publish queue (published_at IS NOT NULL,
 tweet_published_at IS NULL). Used by the bot worker.

Who may call it: any signed-in account.

Request body fields:

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `limit` | integer (int32) | no | (proto int32) |

```bash
curl -X POST 'https://api.shorted.com.au/shorts.v1alpha1.NewsService/ListTweetPublishQueue' \
  -A 'my-app/1.0' \
  -H "Authorization: Bearer $SHORTED_API_TOKEN" \
  -H 'Content-Type: application/json' \
  -H 'Connect-Protocol-Version: 1' \
  -d '{}'
```

#### `POST /shorts.v1alpha1.NewsService/MarkTakeTweetPublished`

Admin: mark a take as tweet-published (called by the bot worker).

Who may call it: any signed-in account.

Request body fields:

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `slug` | string | no | (proto string) |

```bash
curl -X POST 'https://api.shorted.com.au/shorts.v1alpha1.NewsService/MarkTakeTweetPublished' \
  -A 'my-app/1.0' \
  -H "Authorization: Bearer $SHORTED_API_TOKEN" \
  -H 'Content-Type: application/json' \
  -H 'Connect-Protocol-Version: 1' \
  -d '{}'
```

#### `POST /shorts.v1alpha1.NewsService/PublishEditorialTake`

Admin: publish a draft take (sets published_at = NOW()).

Who may call it: any signed-in account.

Request body fields:

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `slug` | string | no | (proto string) |

```bash
curl -X POST 'https://api.shorted.com.au/shorts.v1alpha1.NewsService/PublishEditorialTake' \
  -A 'my-app/1.0' \
  -H "Authorization: Bearer $SHORTED_API_TOKEN" \
  -H 'Content-Type: application/json' \
  -H 'Connect-Protocol-Version: 1' \
  -d '{}'
```

#### `POST /shorts.v1alpha1.NewsService/UpdateEditorialTake`

Admin: partial update of a take's editable fields.

Who may call it: any signed-in account.

Request body fields:

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `bodyMd` | string | no | Each optional field is applied only if non-empty. (proto string) |
| `headline` | string | no | (proto string) |
| `heroImageUrl` | string | no | (proto string) |
| `sentiment` | string | no | (proto string) |
| `slug` | string | no | (proto string) |

```bash
curl -X POST 'https://api.shorted.com.au/shorts.v1alpha1.NewsService/UpdateEditorialTake' \
  -A 'my-app/1.0' \
  -H "Authorization: Bearer $SHORTED_API_TOKEN" \
  -H 'Content-Type: application/json' \
  -H 'Connect-Protocol-Version: 1' \
  -d '{}'
```

### shorts.v1alpha1.StrategyService

#### `POST /shorts.v1alpha1.StrategyService/CompareStrategies`

Two or three canonical strategies over their common window: windows, rebased weekly curves,
 daily-return correlations and the rule differences. Signed-in callers only. Variant references
 are refused until variant comparison ships.

Who may call it: any signed-in account.

Request body fields:

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `refs` | array of string | no | Two or three canonical strategy ids. "variant:<id>" is refused. (proto string) |

```bash
curl -X POST 'https://api.shorted.com.au/shorts.v1alpha1.StrategyService/CompareStrategies' \
  -A 'my-app/1.0' \
  -H "Authorization: Bearer $SHORTED_API_TOKEN" \
  -H 'Content-Type: application/json' \
  -H 'Connect-Protocol-Version: 1' \
  -d '{}'
```

#### `POST /shorts.v1alpha1.StrategyService/GetViewerStrategyPicks`

The same ranked picks as GetStrategyPicks, at the caller's full depth. It
 needs a signed-in caller (a bearer token, or the web's session) and is never
 clamped: the viewer field reports access "free" or "premium" and clamped
 false.

Who may call it: any signed-in account.

Request body fields:

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `limit` | integer (int32) | no | Default 20, max 100. Under the public depth limit every HTTP caller, API tokens included, gets at most that many rows of the default ranking; a larger limit is clamped to it. GetViewerStrategyPicks is not clamped. (proto int32) |
| `offset` | integer (int32) | no | Rows to skip. Under the public depth limit an offset other than 0 is refused with PermissionDenied (the X-Entitlement-Detail names full_signal_list and GetViewerStrategyPicks); use GetViewerStrategyPicks for the rows beyond the public depth. (proto int32) |
| `requireFundamentals` | boolean | no | Only stocks with a fundamentals row. (proto bool) |
| `sortBy` | string | no | Optional ordering: "score" (default), "revenue_yoy", "eps_yoy", "roe", "net_margin", "fcf_margin", "pe" (ascending) or "market_cap". Unknown values sort last; growth above +500% or below -95% sorts after every measured value. rank keeps the strategy's own ranking whatever the order. (proto string) |
| `status` | string | no | Optional filter: "triggered" \| "setup" \| "unknown" \| "watch". (proto string) |
| `strategyId` | string | no | Required, e.g. "zanger-breakout". (proto string) |

```bash
curl -X POST 'https://api.shorted.com.au/shorts.v1alpha1.StrategyService/GetViewerStrategyPicks' \
  -A 'my-app/1.0' \
  -H "Authorization: Bearer $SHORTED_API_TOKEN" \
  -H 'Content-Type: application/json' \
  -H 'Connect-Protocol-Version: 1' \
  -d '{}'
```

#### `POST /shorts.v1alpha1.StrategyService/ListBacktestTrades`

The trades of one canonical run, keyset-paged and filterable by stock and exit reason. Signed-in
 callers only. A variant, gate-refused or unknown run is NotFound.

Who may call it: any signed-in account.

Request body fields:

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `exitReason` | string | no | Optional: one exit reason. (proto string) |
| `pageSize` | integer (int32) | no | 1 to 200; 0 is the default of 50. (proto int32) |
| `pageToken` | string | no | The next_page_token of the previous page. (proto string) |
| `runId` | integer,string (int64) | no | Required: a canonical run. (proto int64) |
| `stockCode` | string | no | Optional: one stock's trades. (proto string) |

```bash
curl -X POST 'https://api.shorted.com.au/shorts.v1alpha1.StrategyService/ListBacktestTrades' \
  -A 'my-app/1.0' \
  -H "Authorization: Bearer $SHORTED_API_TOKEN" \
  -H 'Content-Type: application/json' \
  -H 'Connect-Protocol-Version: 1' \
  -d '{}'
```

#### `POST /shorts.v1alpha1.StrategyService/ListSavedStrategies`

The caller's saved strategies, most recent first, each with today's
 status counts.

Who may call it: any signed-in account.

Request body: an empty JSON object, `{}`.

```bash
curl -X POST 'https://api.shorted.com.au/shorts.v1alpha1.StrategyService/ListSavedStrategies' \
  -A 'my-app/1.0' \
  -H "Authorization: Bearer $SHORTED_API_TOKEN" \
  -H 'Content-Type: application/json' \
  -H 'Connect-Protocol-Version: 1' \
  -d '{}'
```

#### `POST /shorts.v1alpha1.StrategyService/ListStrategySignalEvents`

The status changes of one strategy's canonical rules version, newest first:
 a stock entering or leaving a status, with the rule results that day.

Who may call it: any signed-in account.

Request body fields:

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `pageSize` | integer (int32) | no | 1 to 200; 0 is the default of 50. (proto int32) |
| `pageToken` | string | no | The next_page_token of the previous page. (proto string) |
| `since` | string | no | Optional YYYY-MM-DD, inclusive. (proto string) |
| `stockCode` | string | no | Optional: one stock's events only. (proto string) |
| `strategyId` | string | no | Required: a canonical strategy id. (proto string) |
| `versionHash` | string | no | Empty for the live version; else a live or superseded canonical rules hash. (proto string) |

```bash
curl -X POST 'https://api.shorted.com.au/shorts.v1alpha1.StrategyService/ListStrategySignalEvents' \
  -A 'my-app/1.0' \
  -H "Authorization: Bearer $SHORTED_API_TOKEN" \
  -H 'Content-Type: application/json' \
  -H 'Connect-Protocol-Version: 1' \
  -d '{}'
```

#### `POST /shorts.v1alpha1.StrategyService/SaveStrategy`

Save a strategy to the signed-in caller's list. Saving a strategy that is
 already saved succeeds and keeps its first save time. The list holds at
 most 20; a save past that is refused with PermissionDenied and the
 X-Entitlement-Detail metadata (capability cap_reached, with the limit), and
 a repeat save at the cap still succeeds.

Who may call it: any signed-in account.

Request body fields:

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `strategyRef` | string | no | A canonical strategy id, or "variant:<id>" for a variant the caller owns. (proto string) |

```bash
curl -X POST 'https://api.shorted.com.au/shorts.v1alpha1.StrategyService/SaveStrategy' \
  -A 'my-app/1.0' \
  -H "Authorization: Bearer $SHORTED_API_TOKEN" \
  -H 'Content-Type: application/json' \
  -H 'Connect-Protocol-Version: 1' \
  -d '{}'
```

#### `POST /shorts.v1alpha1.StrategyService/UnsaveStrategy`

Remove a strategy from the caller's list. Removing one that is not saved
 succeeds.

Who may call it: any signed-in account.

Request body fields:

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `strategyRef` | string | no | The reference SaveStrategy was given. (proto string) |

```bash
curl -X POST 'https://api.shorted.com.au/shorts.v1alpha1.StrategyService/UnsaveStrategy' \
  -A 'my-app/1.0' \
  -H "Authorization: Bearer $SHORTED_API_TOKEN" \
  -H 'Content-Type: application/json' \
  -H 'Connect-Protocol-Version: 1' \
  -d '{}'
```
