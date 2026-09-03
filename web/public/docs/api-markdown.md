# Shorted Public API

Programmatic access to Australian market and public-interest data:
ASIC short positions for ASX-listed securities, Australian house prices
and suburb metrics, ABS/RBA economic series, and the federal register of
members' and senators' interests.

Every endpoint is a Connect-RPC method. Call it with an HTTP POST, a JSON
body, and the `Connect-Protocol-Version: 1` header.

Send an identifying `User-Agent`. The edge rejects the default `curl/...`
agent with a 403 (`permission_denied`), so an example without one fails on
first run — which is why every sample here sets it.

```bash
curl -X POST https://api.shorted.com.au/shorts.v1alpha1.StockService/GetStock \
  -A 'my-app/1.0' \
  -H 'Content-Type: application/json' \
  -H 'Connect-Protocol-Version: 1' \
  -d '{"productCode":"BHP"}'
```

Authentication is optional for public endpoints; a bearer token raises
your rate limits. See https://shorted.com.au/docs/api for tiers.

Version `1.0.0`.

Licence: [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/).

This file is the JS-free twin of the HTML API reference at
https://shorted.com.au/docs/api. The machine-readable source is
https://shorted.com.au/openapi.json — this document is generated from it.

## Base URL

```
https://api.shorted.com.au
```

Most endpoints are Connect-RPC methods on the API host above. A few endpoints
live on the web app instead; those state their own base URL below.

## Rate limits

Every tier has two independent budgets: **API** (programmatic, via an API
token) and **browser** (the web app, via Firebase auth). They are different
numbers — a paid *browser* session is unlimited, a paid *API* key is not.

| Tier | API per minute | API per month | Browser per minute | Browser per month |
| --- | --- | --- | --- | --- |
| anonymous | 30 | 500 | 60 | 5,000 |
| free | 60 | 1,000 | 120 | 10,000 |
| pro / premium (paid) | 120 | 10,000 | unlimited | unlimited |
| enterprise | 300 | 50,000 | unlimited | unlimited |

Per-minute limits are enforced in process, per API instance; monthly quotas
are accounted centrally. An unlimited window emits no `X-RateLimit-*` headers
for that window at all (a limit of `0` would read as "zero requests allowed").

Successful responses carry `X-RateLimit-Limit` / `-Remaining` / `-Reset` and
the `X-RateLimit-Monthly-*` equivalents. A 429 from the API carries
`X-RateLimit-Detail`: compact JSON naming which limit fired (`kind`), the
ceiling, consumption, `reset_at`, `retry_after_seconds`, `tier`, `access`
(`api` or `browser`) and an absolute `upgrade_url`. A 429 from the CDN edge
has no `X-RateLimit-Detail` — branch on its presence to tell the two apart.

## Endpoints

### Other

#### `GET /api/search/stocks`

Search ASX stocks by code or name

Case-insensitive substring match over a curated in-process list of
~70 well-known ASX securities (not the full ASX register, and not the
short-position corpus). Returns at most 10 results. For programmatic
search over the full corpus use the Connect-RPC SearchService.

Base URL: `https://shorted.com.au` (not the API host).

| Parameter | In | Required | Type | Description |
| --- | --- | --- | --- | --- |
| `q` | query | yes | string | Ticker or partial company name, e.g. `BHP` or `Commonwealth`. An empty or missing value returns an empty result list. |

```bash
curl -A 'my-app/1.0' 'https://shorted.com.au/api/search/stocks?q=VALUE'
```

#### `GET /feed.xml`

RSS feed of editorial articles and short-selling reports

Base URL: `https://shorted.com.au` (not the API host).

```bash
curl -A 'my-app/1.0' 'https://shorted.com.au/feed.xml'
```

#### `GET /v1/latest`

The newest published panel date, as a cheap conditional GET

Answers "has a new ASIC report landed?" in one small request.

The alternative was polling `GetAvailableDates` and diffing. That is the
wrong shape for the question: the data updates about once a business day
at an hour you cannot predict, and the anonymous quota is 500 requests a
month — so hourly polling spends more than the entire free quota to
detect roughly 22 events, almost all of it on "nothing has changed".

Send back the `ETag` as `If-None-Match` and an unchanged answer costs a
`304` with no body. The ETag is derived from the content, so it changes
exactly when the answer changes and never merely because time passed.

`available_from` is the date the newest observation actually became
public — ASIC publishes T+4 — which is usually what a daily engine is
really waiting for.

```bash
curl -A 'my-app/1.0' -H 'If-None-Match: "<previous etag>"' \
  https://api.shorted.com.au/v1/latest
```

```bash
curl -A 'my-app/1.0' 'https://api.shorted.com.au/v1/latest'
```

#### `GET /v1/panel`

Export the whole short-position panel for a date range

The complete ASIC short-position panel — every security on every
trading date in the window — as CSV or NDJSON, in ONE request.

Building a research panel from `GetMarketByDate` costs one request per
trading date: about 2,500 for a decade, against an anonymous quota of
500 a month. This endpoint replaces that, and is cheaper for us to
serve than the pattern it replaces. It is metered at 50 requests
against your quota rather than one, because it does considerably more
than one request's work.

Rows are streamed and ordered by `(date, product_code)`, so a repeated
export of the same window is byte-identical and can be diffed or
resumed. `reported_short_positions` is a raw SHARE COUNT and
`total_product_in_issue` is the denominator behind `percent_shorted` —
shares on issue moves with placements and buybacks, so the percent can
change with no change in short positioning at all.

Because the response streams, the HTTP status is committed before the
first row. A failure part-way through therefore cannot be a 5xx: the
body ends with a line beginning `#ERROR`. Check for it before trusting
a file to be complete.

```bash
curl -A 'my-app/1.0' \
  'https://api.shorted.com.au/v1/panel?from=2015-01-01&to=2025-12-31' \
  -o panel.csv
```

| Parameter | In | Required | Type | Description |
| --- | --- | --- | --- | --- |
| `from` | query | yes | string (date) | First trading date to include, YYYY-MM-DD. |
| `to` | query | yes | string (date) | Last trading date to include, YYYY-MM-DD. |
| `format` | query | no | enum (csv \\| ndjson) | Output encoding. |
| `codes` | query | no | string | Comma-separated ASX codes to restrict the export to. Omit for every security. Case-insensitive. |
| `as_of` | query | no | string (date) | Point-in-time filter, YYYY-MM-DD. Returns only observations that had been PUBLISHED by this date. ASIC publishes T+4, so an export for a historical window otherwise contains up to four days of data nobody could have had on the dates it is dated — lookahead a backtest cannot detect from the outside. Every row also carries available_from, so the lag can be checked rather than assumed. This covers publication LAG only. ASIC can also revise a position after the fact; the store updates in place, so a historical query returns the as-revised value and no field here identifies it as revised. |
| `ordinary_only` | query | no | boolean | Restrict the panel to ordinary share lines, excluding ETFs, bonds, hybrids, secondary lines and micro-instruments. Off by default, so the export stays a faithful record of what ASIC reported. Short interest is a percent of shares on issue, and that quantity is not comparable across instrument types — a warrant or ETF unit produces a number that looks like an ordinary share's short percentage without being one. Every row carries security_type (ordinary / etf / debt / other) so the decision can also be made client-side. |
| `include_zero` | query | no | boolean | Include securities whose reported short position was zero on a date. Off by default, which suits a "most shorted" view; turn it on when building a research universe, since excluding the zero-interest names biases anything that sorts on short interest. |

```bash
curl -A 'my-app/1.0' 'https://api.shorted.com.au/v1/panel?from=VALUE&to=VALUE'
```

### shorts.v1alpha1.EconomyService

#### `POST /shorts.v1alpha1.EconomyService/GetEconomicSeries`

Fetch observations for up to 50 series by series_key.

Request body fields:

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `maxObservations` | integer (int32) | no | default 600, clamped to 1..600 (proto int32) |
| `seriesKeys` | array of string | no | max 50 (proto string) |
| `startPeriod` | string (RFC 3339 timestamp) | no | optional (proto google.protobuf.Timestamp) |

```bash
curl -X POST 'https://api.shorted.com.au/shorts.v1alpha1.EconomyService/GetEconomicSeries' \
  -A 'my-app/1.0' \
  -H 'Content-Type: application/json' \
  -H 'Connect-Protocol-Version: 1' \
  -d '{}'
```

#### `POST /shorts.v1alpha1.EconomyService/GetStateCompanyAggregates`

Exposure-weighted market cap and short interest aggregates by state.

Request body: an empty JSON object, `{}`.

```bash
curl -X POST 'https://api.shorted.com.au/shorts.v1alpha1.EconomyService/GetStateCompanyAggregates' \
  -A 'my-app/1.0' \
  -H 'Content-Type: application/json' \
  -H 'Connect-Protocol-Version: 1' \
  -d '{}'
```

#### `POST /shorts.v1alpha1.EconomyService/ListEconomicSeries`

List economic series catalog entries (Australian economy snapshot layer).

Request body fields:

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `limit` | integer (int32) | no | default 200, max 500 (proto int32) |
| `metric` | string | no | (proto string) |
| `product` | string | no | (proto string) |
| `regionCode` | string | no | (proto string) |
| `regionType` | string | no | (proto string) |
| `topic` | string | no | optional filters; empty = all (proto string) |

```bash
curl -X POST 'https://api.shorted.com.au/shorts.v1alpha1.EconomyService/ListEconomicSeries' \
  -A 'my-app/1.0' \
  -H 'Content-Type: application/json' \
  -H 'Connect-Protocol-Version: 1' \
  -d '{}'
```

#### `POST /shorts.v1alpha1.EconomyService/ListSeriesCorrelations`

Rank precomputed economic-series correlations for a base market series.

Request body fields:

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `baseSeriesKey` | string | no | required (proto string) |
| `limit` | integer (int32) | no | default 100, max 250 (proto int32) |
| `minAbsR` | number (double) | no | (proto double) |
| `windowMonths` | integer (int32) | no | default 24 (proto int32) |

```bash
curl -X POST 'https://api.shorted.com.au/shorts.v1alpha1.EconomyService/ListSeriesCorrelations' \
  -A 'my-app/1.0' \
  -H 'Content-Type: application/json' \
  -H 'Connect-Protocol-Version: 1' \
  -d '{}'
```

#### `POST /shorts.v1alpha1.EconomyService/ListStateCompanies`

List ASX-listed companies with operations-weighted exposure to a state.

Request body fields:

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `limit` | integer (int32) | no | default 10, max 50 (proto int32) |
| `state` | string | no | nsw\|vic\|qld\|sa\|wa\|tas\|nt\|act (lowercase) (proto string) |

```bash
curl -X POST 'https://api.shorted.com.au/shorts.v1alpha1.EconomyService/ListStateCompanies' \
  -A 'my-app/1.0' \
  -H 'Content-Type: application/json' \
  -H 'Connect-Protocol-Version: 1' \
  -d '{}'
```

### shorts.v1alpha1.HousingService

#### `POST /shorts.v1alpha1.HousingService/FilterSuburbs`

Return a compact index-aligned mask for ANDed metric predicates.

Request body fields:

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `predicates` | array of object (shorts.v1alpha1.SuburbMetricPredicate) | no | ANDed; at least one required (proto shorts.v1alpha1.SuburbMetricPredicate) |
| `stateCode` | string | no | required (proto string) |

```bash
curl -X POST 'https://api.shorted.com.au/shorts.v1alpha1.HousingService/FilterSuburbs' \
  -A 'my-app/1.0' \
  -H 'Content-Type: application/json' \
  -H 'Connect-Protocol-Version: 1' \
  -d '{}'
```

#### `POST /shorts.v1alpha1.HousingService/GetDropIndexSeries`

Daily discounting index series (national/state/suburb) for the price-drops chart.

Request body fields:

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `from` | string | no | 'YYYY-MM-DD', inclusive; clamped to 2026-08-13 (proto string) |
| `grain` | string | no | 'national' \| 'state' \| 'suburb' (proto string) |
| `grainKey` | string | no | 'AU' \| state code \| sal_code (proto string) |
| `to` | string | no | 'YYYY-MM-DD', inclusive; defaults to today (proto string) |

```bash
curl -X POST 'https://api.shorted.com.au/shorts.v1alpha1.HousingService/GetDropIndexSeries' \
  -A 'my-app/1.0' \
  -H 'Content-Type: application/json' \
  -H 'Connect-Protocol-Version: 1' \
  -d '{}'
```

#### `POST /shorts.v1alpha1.HousingService/GetHousePriceSeries`

A single house-price time series for a region and measure.

Request body fields:

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `dwellingType` | string | no | optional; default 'all' (proto string) |
| `measure` | string | no | 'mean_price' \| 'median_price' \| 'price_index' \| 'debt_to_income' (proto string) |
| `regionCode` | string | no | 'AUS' \| 'NSW' \| '1GSYD' (proto string) |

```bash
curl -X POST 'https://api.shorted.com.au/shorts.v1alpha1.HousingService/GetHousePriceSeries' \
  -A 'my-app/1.0' \
  -H 'Content-Type: application/json' \
  -H 'Connect-Protocol-Version: 1' \
  -d '{}'
```

#### `POST /shorts.v1alpha1.HousingService/GetHousingOverview`

Latest house-price headline metrics by region (national/state/capital city).

Request body fields:

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `regionType` | string | no | Filter to one region_type ('national'\|'state'\|'gccsa'); empty = all key regions. (proto string) |

```bash
curl -X POST 'https://api.shorted.com.au/shorts.v1alpha1.HousingService/GetHousingOverview' \
  -A 'my-app/1.0' \
  -H 'Content-Type: application/json' \
  -H 'Connect-Protocol-Version: 1' \
  -d '{}'
```

#### `POST /shorts.v1alpha1.HousingService/GetPriceDropsOverview`

State-level price-drop + listing-price rollup, plus a national summary row.

Request body: an empty JSON object, `{}`.

```bash
curl -X POST 'https://api.shorted.com.au/shorts.v1alpha1.HousingService/GetPriceDropsOverview' \
  -A 'my-app/1.0' \
  -H 'Content-Type: application/json' \
  -H 'Connect-Protocol-Version: 1' \
  -d '{}'
```

#### `POST /shorts.v1alpha1.HousingService/GetPropertyHistory`

Full price timeline for a single physical address, across all its listings.

Request body fields:

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `addressKey` | string | no | (proto string) |

```bash
curl -X POST 'https://api.shorted.com.au/shorts.v1alpha1.HousingService/GetPropertyHistory' \
  -A 'my-app/1.0' \
  -H 'Content-Type: application/json' \
  -H 'Connect-Protocol-Version: 1' \
  -d '{}'
```

#### `POST /shorts.v1alpha1.HousingService/GetSuburbIndex`

Stable sal_code-ordered index used by all columnar suburb responses.

Request body fields:

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `stateCode` | string | no | 'NSW' \| 'VIC' \| ... (required) (proto string) |

```bash
curl -X POST 'https://api.shorted.com.au/shorts.v1alpha1.HousingService/GetSuburbIndex' \
  -A 'my-app/1.0' \
  -H 'Content-Type: application/json' \
  -H 'Connect-Protocol-Version: 1' \
  -d '{}'
```

#### `POST /shorts.v1alpha1.HousingService/GetSuburbMetricColumns`

Fetch only the map metric columns currently needed by the client.

Request body fields:

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `metricKeys` | array of string | no | exact keys from the closed server registry (proto string) |
| `stateCode` | string | no | required (proto string) |

```bash
curl -X POST 'https://api.shorted.com.au/shorts.v1alpha1.HousingService/GetSuburbMetricColumns' \
  -A 'my-app/1.0' \
  -H 'Content-Type: application/json' \
  -H 'Connect-Protocol-Version: 1' \
  -d '{}'
```

#### `POST /shorts.v1alpha1.HousingService/GetSuburbProfile`

Full per-suburb profile: identity, demographics, headline price, comparison baselines.

Request body fields:

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `salCode` | string | no | required (proto string) |

```bash
curl -X POST 'https://api.shorted.com.au/shorts.v1alpha1.HousingService/GetSuburbProfile' \
  -A 'my-app/1.0' \
  -H 'Content-Type: application/json' \
  -H 'Connect-Protocol-Version: 1' \
  -d '{}'
```

#### `POST /shorts.v1alpha1.HousingService/ListAddressPriceDrops`

Individual physical addresses ranked by their asking-price drop over a window.

Request body fields:

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `limit` | integer (int32) | no | optional; default 50 (proto int32) |
| `sort` | string | no | 'pct' (default) \| 'abs' (biggest $ cut) \| 'recent' (proto string) |
| `stateCode` | string | no | optional filter, e.g. 'VIC' (empty = all states) (proto string) |
| `windowDays` | integer (int32) | no | optional; default 90 (proto int32) |

```bash
curl -X POST 'https://api.shorted.com.au/shorts.v1alpha1.HousingService/ListAddressPriceDrops' \
  -A 'my-app/1.0' \
  -H 'Content-Type: application/json' \
  -H 'Connect-Protocol-Version: 1' \
  -d '{}'
```

#### `POST /shorts.v1alpha1.HousingService/ListAgencyPriceStats`

Agencies ranked by recent asking-price cuts across their listings.

Request body fields:

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `limit` | integer (int32) | no | optional; default 20, cap 100 (proto int32) |
| `sort` | string | no | 'drops' (default) \| 'listings' \| 'avg_cut' \| 'value' (proto string) |
| `stateCode` | string | no | optional filter, e.g. 'NSW'; '' = national (proto string) |

```bash
curl -X POST 'https://api.shorted.com.au/shorts.v1alpha1.HousingService/ListAgencyPriceStats' \
  -A 'my-app/1.0' \
  -H 'Content-Type: application/json' \
  -H 'Connect-Protocol-Version: 1' \
  -d '{}'
```

#### `POST /shorts.v1alpha1.HousingService/ListHousingRegions`

List house-price regions (suburbs/LGAs/etc) for the suburb explorer.

Request body fields:

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `limit` | integer (int32) | no | optional; default 2000 (proto int32) |
| `query` | string | no | optional case-insensitive name substring (proto string) |
| `regionType` | string | no | optional filter, e.g. 'suburb' \| 'gccsa' \| 'state' (proto string) |
| `stateCode` | string | no | optional filter, e.g. 'SA' \| 'VIC' (proto string) |

```bash
curl -X POST 'https://api.shorted.com.au/shorts.v1alpha1.HousingService/ListHousingRegions' \
  -A 'my-app/1.0' \
  -H 'Content-Type: application/json' \
  -H 'Connect-Protocol-Version: 1' \
  -d '{}'
```

#### `POST /shorts.v1alpha1.HousingService/ListStateSuburbs`

List all suburbs in a state with latest median price + key demographics.

Request body fields:

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `limit` | integer (int32) | no | optional; default 5000 (proto int32) |
| `query` | string | no | optional case-insensitive name substring (proto string) |
| `stateCode` | string | no | 'NSW' \| 'VIC' \| ... (required) (proto string) |

```bash
curl -X POST 'https://api.shorted.com.au/shorts.v1alpha1.HousingService/ListStateSuburbs' \
  -A 'my-app/1.0' \
  -H 'Content-Type: application/json' \
  -H 'Connect-Protocol-Version: 1' \
  -d '{}'
```

#### `POST /shorts.v1alpha1.HousingService/ListSuburbDropListings`

Individual recently-reduced listings for a suburb, deep-linking to the portal.

Request body fields:

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `limit` | integer (int32) | no | optional; default 30 (proto int32) |
| `regionCode` | string | no | (proto string) |
| `salCode` | string | no | one of sal_code or region_code is required (proto string) |
| `windowDays` | integer (int32) | no | optional; default 30 (proto int32) |

```bash
curl -X POST 'https://api.shorted.com.au/shorts.v1alpha1.HousingService/ListSuburbDropListings' \
  -A 'my-app/1.0' \
  -H 'Content-Type: application/json' \
  -H 'Connect-Protocol-Version: 1' \
  -d '{}'
```

#### `POST /shorts.v1alpha1.HousingService/ListSuburbPriceDrops`

Suburbs ranked by recent for-sale asking-price drops.

Request body fields:

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `limit` | integer (int32) | no | optional; default 50 (proto int32) |
| `sort` | string | no | optional: 'count' (default) \| 'avg' \| 'max' (proto string) |
| `stateCode` | string | no | optional filter, e.g. 'NSW'; '' = national (proto string) |
| `windowDays` | integer (int32) | no | reserved; the aggregate uses a fixed rolling window (proto int32) |

```bash
curl -X POST 'https://api.shorted.com.au/shorts.v1alpha1.HousingService/ListSuburbPriceDrops' \
  -A 'my-app/1.0' \
  -H 'Content-Type: application/json' \
  -H 'Connect-Protocol-Version: 1' \
  -d '{}'
```

### shorts.v1alpha1.IndustryIntelligenceService

#### `POST /shorts.v1alpha1.IndustryIntelligenceService/GetIndustryIntelligence`

Get imported, cited industry intelligence facts for an industry.

Request body fields:

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `industry` | string | no | optional exact industry filter (proto string) |
| `recordLimit` | integer (int32) | no | default 50, maximum 200 (proto int32) |
| `stockCode` | string | no | optional exact stock filter (per-stock evidence dossier) (proto string) |

```bash
curl -X POST 'https://api.shorted.com.au/shorts.v1alpha1.IndustryIntelligenceService/GetIndustryIntelligence' \
  -A 'my-app/1.0' \
  -H 'Content-Type: application/json' \
  -H 'Connect-Protocol-Version: 1' \
  -d '{}'
```

### shorts.v1alpha1.MarketService

#### `POST /shorts.v1alpha1.MarketService/GetAvailableDates`

Get available trading dates for market snapshots

Request body fields:

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `before` | string | no | Return dates before this date (YYYY-MM-DD) (proto string) |
| `limit` | integer (int32) | no | How many dates to return (default 90) (proto int32) |

```bash
curl -X POST 'https://api.shorted.com.au/shorts.v1alpha1.MarketService/GetAvailableDates' \
  -A 'my-app/1.0' \
  -H 'Content-Type: application/json' \
  -H 'Connect-Protocol-Version: 1' \
  -d '{}'
```

#### `POST /shorts.v1alpha1.MarketService/GetBattlegroundStocks`

Get squeeze-radar and battleground (price up + shorts building) ranked stocks

Request body fields:

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `limit` | integer (int32) | no | (proto int32) |
| `offset` | integer (int32) | no | (proto int32) |
| `view` | enum (BATTLEGROUND_VIEW_UNSPECIFIED \\| BATTLEGROUND_VIEW_SQUEEZE \\| BATTLEGROUND_VIEW_DIVERGENCE) | no | (proto shorts.v1alpha1.BattlegroundView) |

```bash
curl -X POST 'https://api.shorted.com.au/shorts.v1alpha1.MarketService/GetBattlegroundStocks' \
  -A 'my-app/1.0' \
  -H 'Content-Type: application/json' \
  -H 'Connect-Protocol-Version: 1' \
  -d '{}'
```

#### `POST /shorts.v1alpha1.MarketService/GetIndexSeries`

Benchmark index levels — the series a strategy's return is measured against.

Request body fields:

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `from` | string | no | Explicit range, YYYY-MM-DD. (proto string) |
| `indexCode` | string | no | e.g. "XJO", "XJT". Case-insensitive. (proto string) |
| `maxPoints` | integer (int32) | no | Cap on returned points, 0 for no cap. Thinning keeps the first and last session; `downsampled` reports whether it happened. (proto int32) |
| `period` | string | no | Lookback window: 1D, 1W, 1M, 3M, 6M, 1Y, 2Y, 5Y, 10Y or MAX. Ignored when `from` is set. Defaults to 1Y. (proto string) |
| `to` | string | no | (proto string) |

```bash
curl -X POST 'https://api.shorted.com.au/shorts.v1alpha1.MarketService/GetIndexSeries' \
  -A 'my-app/1.0' \
  -H 'Content-Type: application/json' \
  -H 'Connect-Protocol-Version: 1' \
  -d '{}'
```

#### `POST /shorts.v1alpha1.MarketService/GetIndustryTreeMap`

Get Industry TreeMap for short positions.

Request body fields:

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `limit` | integer (int32) | no | number of stocks to return for each parent (proto int32) |
| `period` | string | no | time over which to look at the max value (proto string) |
| `viewMode` | enum (CURRENT_CHANGE \\| PERCENTAGE_CHANGE) | no | (proto shorts.v1alpha1.ViewMode) |

```bash
curl -X POST 'https://api.shorted.com.au/shorts.v1alpha1.MarketService/GetIndustryTreeMap' \
  -A 'my-app/1.0' \
  -H 'Content-Type: application/json' \
  -H 'Connect-Protocol-Version: 1' \
  -d '{}'
```

#### `POST /shorts.v1alpha1.MarketService/GetMarketByDate`

Get all short positions for a specific trading date

Request body fields:

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `date` | string | no | YYYY-MM-DD format (proto string) |
| `includeZeroShortPositions` | boolean | no | Include securities whose reported short position was zero on this date. This response is a POINT-IN-TIME universe: it reads the append-only ASIC report at `date` and joins metadata outward, so a security that has since delisted is present here at the dates it was actually reported. That makes a survivorship-free universe buildable — but only if the universe is complete, and by default a name with no short interest that day is filtered out. Excluding exactly the names with no short interest biases any study that sorts on short interest, which is most of them. (proto bool) |
| `limit` | integer (int32) | no | Max stocks to return (default 50) (proto int32) |
| `offset` | integer (int32) | no | Pagination offset (proto int32) |
| `ordinaryOnly` | boolean | no | Restrict the universe to ordinary share lines, excluding ETFs, bonds, hybrids, secondary lines and micro-instruments. This response deliberately returns everything ASIC reported, which is what makes it a faithful point-in-time universe. But list_top_shorts and the screener already state that non-equity instruments are excluded, and they filter — so the two surfaces answered "what is the ASX universe" differently and only one said so. A caller could discover the difference only by noticing a warrant at 132% short. Every row now carries security_type; this filters on it server-side. (proto bool) |

```bash
curl -X POST 'https://api.shorted.com.au/shorts.v1alpha1.MarketService/GetMarketByDate' \
  -A 'my-app/1.0' \
  -H 'Content-Type: application/json' \
  -H 'Connect-Protocol-Version: 1' \
  -d '{}'
```

#### `POST /shorts.v1alpha1.MarketService/GetShortCampaignScoreboard`

Get the short-seller scoreboard: historic short campaigns and whether shorts won

Request body fields:

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `industry` | string | no | optional exact industry filter (proto string) |
| `limit` | integer (int32) | no | (proto int32) |
| `offset` | integer (int32) | no | (proto int32) |

```bash
curl -X POST 'https://api.shorted.com.au/shorts.v1alpha1.MarketService/GetShortCampaignScoreboard' \
  -A 'my-app/1.0' \
  -H 'Content-Type: application/json' \
  -H 'Connect-Protocol-Version: 1' \
  -d '{}'
```

#### `POST /shorts.v1alpha1.MarketService/GetTopShorts`

Shows top 10 short positions on the ASX over different periods of time.

Request body fields:

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `limit` | integer (int32) | no | (proto int32) |
| `offset` | integer (int32) | no | (proto int32) |
| `period` | string | no | (proto string) |
| `productCodes` | array of string | no | Optional explicit set of product codes to return time series for, INSTEAD of the top-`limit` ranking. Lets callers that already know which stocks they need (e.g. industry-crowding constituents) fetch just those series rather than every top-N stock's points. Ignored when empty. When set with summary_only=false, `limit`/`offset` are not applied to the code set. (proto string) |
| `summaryOnly` | boolean | no | When true, returns only product code, name, and latest short position without time series points. Much faster and smaller response. (proto bool) |

```bash
curl -X POST 'https://api.shorted.com.au/shorts.v1alpha1.MarketService/GetTopShorts' \
  -A 'my-app/1.0' \
  -H 'Content-Type: application/json' \
  -H 'Connect-Protocol-Version: 1' \
  -d '{}'
```

#### `POST /shorts.v1alpha1.MarketService/ListIndices`

List the benchmark indices available, and whether each reinvests dividends.

Request body: an empty JSON object, `{}`.

```bash
curl -X POST 'https://api.shorted.com.au/shorts.v1alpha1.MarketService/ListIndices' \
  -A 'my-app/1.0' \
  -H 'Content-Type: application/json' \
  -H 'Connect-Protocol-Version: 1' \
  -d '{}'
```

### shorts.v1alpha1.NewsService

#### `POST /shorts.v1alpha1.NewsService/GetEditorialTake`

Get a single published editorial take by slug.

Request body fields:

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `slug` | string | no | (proto string) |

```bash
curl -X POST 'https://api.shorted.com.au/shorts.v1alpha1.NewsService/GetEditorialTake' \
  -A 'my-app/1.0' \
  -H 'Content-Type: application/json' \
  -H 'Connect-Protocol-Version: 1' \
  -d '{}'
```

#### `POST /shorts.v1alpha1.NewsService/GetMarketNews`

Get market-wide news across all stocks

Request body fields:

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `limit` | integer (int32) | no | Max articles to return (default 50) (proto int32) |
| `priceSensitiveOnly` | boolean | no | Only return price-sensitive news (proto bool) |
| `source` | string | no | Optional filter by source (proto string) |

```bash
curl -X POST 'https://api.shorted.com.au/shorts.v1alpha1.NewsService/GetMarketNews' \
  -A 'my-app/1.0' \
  -H 'Content-Type: application/json' \
  -H 'Connect-Protocol-Version: 1' \
  -d '{}'
```

#### `POST /shorts.v1alpha1.NewsService/GetRelatedNews`

Get news semantically related to a stock (or to a specific article)

Request body fields:

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `articleId` | string | no | Optional anchor article id; if empty, uses the stock's latest article (proto string) |
| `limit` | integer (int32) | no | Max related articles to return (default 6) (proto int32) |
| `stockCode` | string | no | ASX stock code (e.g., "BHP") (proto string) |

```bash
curl -X POST 'https://api.shorted.com.au/shorts.v1alpha1.NewsService/GetRelatedNews' \
  -A 'my-app/1.0' \
  -H 'Content-Type: application/json' \
  -H 'Connect-Protocol-Version: 1' \
  -d '{}'
```

#### `POST /shorts.v1alpha1.NewsService/GetStockNews`

Get recent news articles for a specific stock

Request body fields:

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `limit` | integer (int32) | no | Max articles to return (default 20) (proto int32) |
| `sentiment` | string | no | Optional filter by sentiment (proto string) |
| `source` | string | no | Optional filter by source (proto string) |
| `stockCode` | string | no | ASX stock code (e.g., "BHP") (proto string) |

```bash
curl -X POST 'https://api.shorted.com.au/shorts.v1alpha1.NewsService/GetStockNews' \
  -A 'my-app/1.0' \
  -H 'Content-Type: application/json' \
  -H 'Connect-Protocol-Version: 1' \
  -d '{}'
```

#### `POST /shorts.v1alpha1.NewsService/ListEditorialTakes`

List recent published editorial takes (paginated).

Request body fields:

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `limit` | integer (int32) | no | default 20 (proto int32) |
| `offset` | integer (int32) | no | (proto int32) |
| `stockCode` | string | no | optional filter (proto string) |

```bash
curl -X POST 'https://api.shorted.com.au/shorts.v1alpha1.NewsService/ListEditorialTakes' \
  -A 'my-app/1.0' \
  -H 'Content-Type: application/json' \
  -H 'Connect-Protocol-Version: 1' \
  -d '{}'
```

### shorts.v1alpha1.PoliticiansService

#### `POST /shorts.v1alpha1.PoliticiansService/ComparePoliticians`

Neutral, symmetric comparison of two politician register summaries.

Request body fields:

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `slugA` | string | no | (proto string) |
| `slugB` | string | no | (proto string) |

```bash
curl -X POST 'https://api.shorted.com.au/shorts.v1alpha1.PoliticiansService/ComparePoliticians' \
  -A 'my-app/1.0' \
  -H 'Content-Type: application/json' \
  -H 'Connect-Protocol-Version: 1' \
  -d '{}'
```

#### `POST /shorts.v1alpha1.PoliticiansService/GetDonationsOverview`

Party-group funding rollups for one financial year, plus the corpus
 counts and disclosure notes a funding surface must render.

Request body fields:

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `financialYear` | string | no | Verbatim FY label ('2024-25'). Empty selects the latest year held. (proto string) |
| `limit` | integer (int32) | no | Party groups returned, ordered by total_receipts_cents desc. Default 25, max 100. (proto int32) |

```bash
curl -X POST 'https://api.shorted.com.au/shorts.v1alpha1.PoliticiansService/GetDonationsOverview' \
  -A 'my-app/1.0' \
  -H 'Content-Type: application/json' \
  -H 'Connect-Protocol-Version: 1' \
  -d '{}'
```

#### `POST /shorts.v1alpha1.PoliticiansService/GetParliamentOverview`

Parliament-wide counts and the as-at date. Cheap; drives the hub tiles.

Request body: an empty JSON object, `{}`.

```bash
curl -X POST 'https://api.shorted.com.au/shorts.v1alpha1.PoliticiansService/GetParliamentOverview' \
  -A 'my-app/1.0' \
  -H 'Content-Type: application/json' \
  -H 'Connect-Protocol-Version: 1' \
  -d '{}'
```

#### `POST /shorts.v1alpha1.PoliticiansService/GetPolitician`

One politician's profile: declared interests, property, and terms served.

Request body fields:

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `slug` | string | no | (proto string) |

```bash
curl -X POST 'https://api.shorted.com.au/shorts.v1alpha1.PoliticiansService/GetPolitician' \
  -A 'my-app/1.0' \
  -H 'Content-Type: application/json' \
  -H 'Connect-Protocol-Version: 1' \
  -d '{}'
```

#### `POST /shorts.v1alpha1.PoliticiansService/GetPoliticianAnalytics`

Aggregate shape of the register: which parties declare interests in which
 industries, and where members are from.

COUNTS OF PEOPLE AND DECLARATIONS ONLY. There is no weight, size, exposure
 or value here and none may be added — the registers do not record any, so
 any such figure would be invented. A cell says "N members of this party
 declared an interest in a company in this industry", and nothing more.

Request body fields:

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `currentOnly` | boolean | no | Restrict to interests declared as current, rather than every interest ever declared across parliaments 44-48. (proto bool) |
| `topIndustries` | integer (int32) | no | Cap the industry axis to the N most-declared, so the heatmap stays readable. The remainder is NOT silently dropped — the response reports what was cut. (proto int32) |

```bash
curl -X POST 'https://api.shorted.com.au/shorts.v1alpha1.PoliticiansService/GetPoliticianAnalytics' \
  -A 'my-app/1.0' \
  -H 'Content-Type: application/json' \
  -H 'Connect-Protocol-Version: 1' \
  -d '{}'
```

#### `POST /shorts.v1alpha1.PoliticiansService/GetPoliticianExplorerProfile`

Count-based analytics for one politician's explorer profile.

Request body fields:

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `slug` | string | no | (proto string) |
| `topIndustries` | integer (int32) | no | (proto int32) |

```bash
curl -X POST 'https://api.shorted.com.au/shorts.v1alpha1.PoliticiansService/GetPoliticianExplorerProfile' \
  -A 'my-app/1.0' \
  -H 'Content-Type: application/json' \
  -H 'Connect-Protocol-Version: 1' \
  -d '{}'
```

#### `POST /shorts.v1alpha1.PoliticiansService/GetPoliticianFunding`

The funding returns that NAME one member. Never party money.

Request body fields:

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `slug` | string | no | (proto string) |

```bash
curl -X POST 'https://api.shorted.com.au/shorts.v1alpha1.PoliticiansService/GetPoliticianFunding' \
  -A 'my-app/1.0' \
  -H 'Content-Type: application/json' \
  -H 'Connect-Protocol-Version: 1' \
  -d '{}'
```

#### `POST /shorts.v1alpha1.PoliticiansService/GetRegisterActivity`

Aggregate lodgement activity over a window: weekly event counts, the
 members with the most dated events, companies first declared in the window,
 and companies whose declarer count moved.

COUNTS AND DATES ONLY. "Most active" is a count ordering, and is the
 strongest characterisation permitted beside a named member — nothing here
 may become "unusual", "spike", "watch" or a flag of any kind.

Request body fields:

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `chamber` | string | no | 'house' \| 'senate' (proto string) |
| `itemNo` | integer (int32) | no | register form item 1-14; 0 = all (proto int32) |
| `kind` | enum (REGISTER_CHANGE_KIND_UNSPECIFIED \\| REGISTER_CHANGE_KIND_ADDED \\| REGISTER_CHANGE_KIND_REMOVED) | no | UNSPECIFIED = both (proto shorts.v1alpha1.RegisterChangeKind) |
| `partyAb` | string | no | AEC abbreviation (proto string) |
| `politicianSlug` | string | no | The SAME filter set ListRegisterChanges takes, and for one reason: the weekly strip is drawn above a FILTERED feed, so parliament-wide numbers rendered there read as the filtered member's own. All optional and all ADDITIVE — an unfiltered request is byte-identical to the old behaviour. They narrow the WEEKLY BUCKETS, filtered_event_count and filtered_member_count only. The three rails (active_members, newly_declared_companies, declarer_count_changes) are NOT narrowed by the filters: they answer corpus-wide questions inside the window, and a "most active members" rail filtered to one member would be a tautology. canonical slug; consumers never derive one (proto string) |
| `windowDays` | integer (int32) | no | 30 \| 90 \| 180 \| 365. Anything else is clamped to the next value up (0 and negatives default to 90), so a cache key can never describe a window other than the one that produced it. (proto int32) |

```bash
curl -X POST 'https://api.shorted.com.au/shorts.v1alpha1.PoliticiansService/GetRegisterActivity' \
  -A 'my-app/1.0' \
  -H 'Content-Type: application/json' \
  -H 'Connect-Protocol-Version: 1' \
  -d '{}'
```

#### `POST /shorts.v1alpha1.PoliticiansService/GetRegisterExplorer`

Aggregate register counts for the explorer hub.

Request body: an empty JSON object, `{}`.

```bash
curl -X POST 'https://api.shorted.com.au/shorts.v1alpha1.PoliticiansService/GetRegisterExplorer' \
  -A 'my-app/1.0' \
  -H 'Content-Type: application/json' \
  -H 'Connect-Protocol-Version: 1' \
  -d '{}'
```

#### `POST /shorts.v1alpha1.PoliticiansService/ListDistinctiveHoldings`

One member's currently-declared listed companies, each with how many
 members in total currently declare it. A count of one is the plain fact
 "no other member currently declares this"; it is not a label.

Request body fields:

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `slug` | string | no | (proto string) |

```bash
curl -X POST 'https://api.shorted.com.au/shorts.v1alpha1.PoliticiansService/ListDistinctiveHoldings' \
  -A 'my-app/1.0' \
  -H 'Content-Type: application/json' \
  -H 'Connect-Protocol-Version: 1' \
  -d '{}'
```

#### `POST /shorts.v1alpha1.PoliticiansService/ListPartyFunding`

One party group's funding across every financial year it lodged in.

Request body fields:

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `financialYear` | string | no | the focus year for the donor lists; empty = latest held (proto string) |
| `limit` | integer (int32) | no | donors per list; default 25, max 200 (proto int32) |
| `partyGroup` | string | no | required; the source's own rollup key (proto string) |

```bash
curl -X POST 'https://api.shorted.com.au/shorts.v1alpha1.PoliticiansService/ListPartyFunding' \
  -A 'my-app/1.0' \
  -H 'Content-Type: application/json' \
  -H 'Connect-Protocol-Version: 1' \
  -d '{}'
```

#### `POST /shorts.v1alpha1.PoliticiansService/ListPoliticians`

Browse/filter parliamentarians.

Request body fields:

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `chamber` | string | no | optional (proto string) |
| `limit` | integer (int32) | no | default 100, max 500 (proto int32) |
| `offset` | integer (int32) | no | (proto int32) |
| `partyAb` | string | no | optional (proto string) |
| `query` | string | no | optional name substring (proto string) |
| `stateCode` | string | no | optional (proto string) |

```bash
curl -X POST 'https://api.shorted.com.au/shorts.v1alpha1.PoliticiansService/ListPoliticians' \
  -A 'my-app/1.0' \
  -H 'Content-Type: application/json' \
  -H 'Connect-Protocol-Version: 1' \
  -d '{}'
```

#### `POST /shorts.v1alpha1.PoliticiansService/ListPoliticianStocks`

Parliament's most-declared ASX-listed companies, with a party split.

Request body fields:

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `currentOnly` | boolean | no | (proto bool) |
| `limit` | integer (int32) | no | default 50, max 200 (proto int32) |

```bash
curl -X POST 'https://api.shorted.com.au/shorts.v1alpha1.PoliticiansService/ListPoliticianStocks' \
  -A 'my-app/1.0' \
  -H 'Content-Type: application/json' \
  -H 'Connect-Protocol-Version: 1' \
  -d '{}'
```

#### `POST /shorts.v1alpha1.PoliticiansService/ListPoliticianSummaries`

Filtered politician summaries for the explorer table.

Request body fields:

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `chamber` | string | no | (proto string) |
| `itemNo` | integer (int32) | no | 0 = all (proto int32) |
| `limit` | integer (int32) | no | (proto int32) |
| `offset` | integer (int32) | no | (proto int32) |
| `partyAb` | string | no | (proto string) |
| `query` | string | no | (proto string) |
| `sort` | enum (POLITICIAN_SUMMARY_SORT_DECLARED_ITEMS \\| POLITICIAN_SUMMARY_SORT_COMPANIES \\| POLITICIAN_SUMMARY_SORT_PROPERTIES \\| POLITICIAN_SUMMARY_SORT_RECENT_CHANGES \\| POLITICIAN_SUMMARY_SORT_NAME) | no | (proto shorts.v1alpha1.PoliticianSummarySort) |
| `stateCode` | string | no | (proto string) |

```bash
curl -X POST 'https://api.shorted.com.au/shorts.v1alpha1.PoliticiansService/ListPoliticianSummaries' \
  -A 'my-app/1.0' \
  -H 'Content-Type: application/json' \
  -H 'Connect-Protocol-Version: 1' \
  -d '{}'
```

#### `POST /shorts.v1alpha1.PoliticiansService/ListRegisterChanges`

Register additions and removals over time.

Request body fields:

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `chamber` | string | no | 'house' \| 'senate' (proto string) |
| `itemNo` | integer (int32) | no | register form item 1-14; 0 = all (proto int32) |
| `kind` | enum (REGISTER_CHANGE_KIND_UNSPECIFIED \\| REGISTER_CHANGE_KIND_ADDED \\| REGISTER_CHANGE_KIND_REMOVED) | no | UNSPECIFIED = both (proto shorts.v1alpha1.RegisterChangeKind) |
| `limit` | integer (int32) | no | default 100, max 500 (proto int32) |
| `offset` | integer (int32) | no | (proto int32) |
| `partyAb` | string | no | AEC abbreviation (proto string) |
| `politicianSlug` | string | no | Discovery-layer filters. All optional and all ADDITIVE — the unfiltered feed is unchanged when they are left empty. canonical slug; consumers never derive one (proto string) |
| `since` | string (RFC 3339 timestamp) | no | Interpreted at UTC DAY granularity: the handler truncates it to UTC midnight before it reaches either the cache key or the query, so two timestamps on the same day are one request and cannot be served each other's results. (proto google.protobuf.Timestamp) |
| `stockCode` | string | no | optional (proto string) |

```bash
curl -X POST 'https://api.shorted.com.au/shorts.v1alpha1.PoliticiansService/ListRegisterChanges' \
  -A 'my-app/1.0' \
  -H 'Content-Type: application/json' \
  -H 'Connect-Protocol-Version: 1' \
  -d '{}'
```

#### `POST /shorts.v1alpha1.PoliticiansService/ListShortInterestOverlap`

Declared interests in companies carrying short interest.

The short percentage describes THE COMPANY (ASIC, market-wide). It is not
 and cannot be a property of anyone's holding — the registers record no
 quantities. Consumers must label it as the company's figure.

Request body fields:

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `limit` | integer (int32) | no | default 50, max 200 (proto int32) |
| `minShortPercent` | number (double) | no | default 2.0 (proto double) |

```bash
curl -X POST 'https://api.shorted.com.au/shorts.v1alpha1.PoliticiansService/ListShortInterestOverlap' \
  -A 'my-app/1.0' \
  -H 'Content-Type: application/json' \
  -H 'Connect-Protocol-Version: 1' \
  -d '{}'
```

#### `POST /shorts.v1alpha1.PoliticiansService/ListStatePoliticianHoldings`

Parliamentarians of one state and the listed companies they declare.
 Drives the card on /economy/{state}.

Request body fields:

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `limit` | integer (int32) | no | default 20, max 100 (proto int32) |
| `stateCode` | string | no | accepts a slug or a code (proto string) |

```bash
curl -X POST 'https://api.shorted.com.au/shorts.v1alpha1.PoliticiansService/ListStatePoliticianHoldings' \
  -A 'my-app/1.0' \
  -H 'Content-Type: application/json' \
  -H 'Connect-Protocol-Version: 1' \
  -d '{}'
```

#### `POST /shorts.v1alpha1.PoliticiansService/ListStockPoliticians`

Which parliamentarians declare an interest in one ASX-listed company.
 Drives the card on /shorts/{code}.

Request body fields:

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `currentOnly` | boolean | no | default false: history included (proto bool) |
| `stockCode` | string | no | (proto string) |

```bash
curl -X POST 'https://api.shorted.com.au/shorts.v1alpha1.PoliticiansService/ListStockPoliticians' \
  -A 'my-app/1.0' \
  -H 'Content-Type: application/json' \
  -H 'Connect-Protocol-Version: 1' \
  -d '{}'
```

#### `POST /shorts.v1alpha1.PoliticiansService/ListSuburbPoliticians`

Which parliamentarians declare real estate in one ABS suburb.
 Drives the card on /housing/{state}/{suburb}.

Request body fields:

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `salCode` | string | no | (proto string) |

```bash
curl -X POST 'https://api.shorted.com.au/shorts.v1alpha1.PoliticiansService/ListSuburbPoliticians' \
  -A 'my-app/1.0' \
  -H 'Content-Type: application/json' \
  -H 'Connect-Protocol-Version: 1' \
  -d '{}'
```

#### `POST /shorts.v1alpha1.PoliticiansService/ListTopDonors`

Payers into party branches for one financial year, ordered by the total
 they were declared to have paid.

Request body fields:

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `financialYear` | string | no | empty = latest year held (proto string) |
| `limit` | integer (int32) | no | default 50, max 200 (proto int32) |
| `offset` | integer (int32) | no | (proto int32) |
| `partyGroup` | string | no | empty = every party group (proto string) |

```bash
curl -X POST 'https://api.shorted.com.au/shorts.v1alpha1.PoliticiansService/ListTopDonors' \
  -A 'my-app/1.0' \
  -H 'Content-Type: application/json' \
  -H 'Connect-Protocol-Version: 1' \
  -d '{}'
```

### shorts.v1alpha1.ReportsService

#### `POST /shorts.v1alpha1.ReportsService/GetWeeklyReport`

Get a weekly short report with narrative analysis

Request body fields:

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `weekSlug` | string | no | ISO week format: "2026-W06" (proto string) |

```bash
curl -X POST 'https://api.shorted.com.au/shorts.v1alpha1.ReportsService/GetWeeklyReport' \
  -A 'my-app/1.0' \
  -H 'Content-Type: application/json' \
  -H 'Connect-Protocol-Version: 1' \
  -d '{}'
```

#### `POST /shorts.v1alpha1.ReportsService/ListReports`

List published short selling reports (weekly, monthly, yearly)

Request body fields:

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `limit` | integer (int32) | no | Max reports to return (default 24, max 100) (proto int32) |
| `reportType` | string | no | "weekly", "monthly", "yearly", or "" / "all" for all types (proto string) |

```bash
curl -X POST 'https://api.shorted.com.au/shorts.v1alpha1.ReportsService/ListReports' \
  -A 'my-app/1.0' \
  -H 'Content-Type: application/json' \
  -H 'Connect-Protocol-Version: 1' \
  -d '{}'
```

### shorts.v1alpha1.ScreenerService

#### `POST /shorts.v1alpha1.ScreenerService/ScreenStocks`

Screen stocks using compound filters across shorts, price, fundamentals, director trades, and news

Request body fields:

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `filters` | object (shorts.v1alpha1.ScreenerFilters) | no | (proto shorts.v1alpha1.ScreenerFilters) |
| `limit` | integer (int32) | no | Max results (default 50) (proto int32) |
| `offset` | integer (int32) | no | Pagination offset (proto int32) |
| `sortDirection` | enum (SORT_DIRECTION_DESC \\| SORT_DIRECTION_ASC) | no | (proto shorts.v1alpha1.SortDirection) |
| `sortField` | enum (SCREENER_SORT_FIELD_SHORT_PCT \\| SCREENER_SORT_FIELD_SHORT_PCT_CHANGE \\| SCREENER_SORT_FIELD_MARKET_CAP \\| SCREENER_SORT_FIELD_PRICE_CHANGE_1M \\| SCREENER_SORT_FIELD_PE_RATIO \\| SCREENER_SORT_FIELD_DIVIDEND_YIELD \\| SCREENER_SORT_FIELD_NET_DIRECTOR_BUY \\| SCREENER_SORT_FIELD_NEWS_SENTIMENT \\| SCREENER_SORT_FIELD_DAYS_TO_COVER) | no | (proto shorts.v1alpha1.ScreenerSortField) |

```bash
curl -X POST 'https://api.shorted.com.au/shorts.v1alpha1.ScreenerService/ScreenStocks' \
  -A 'my-app/1.0' \
  -H 'Content-Type: application/json' \
  -H 'Connect-Protocol-Version: 1' \
  -d '{}'
```

### shorts.v1alpha1.SearchService

#### `POST /shorts.v1alpha1.SearchService/SearchStocks`

Search stocks by symbol or company name

Request body fields:

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `includeDetails` | boolean | no | Whether to include detailed stock information (proto bool) |
| `limit` | integer (int32) | no | Maximum number of results to return (default: 50) (proto int32) |
| `query` | string | no | Search query (symbol or company name) (proto string) |

```bash
curl -X POST 'https://api.shorted.com.au/shorts.v1alpha1.SearchService/SearchStocks' \
  -A 'my-app/1.0' \
  -H 'Content-Type: application/json' \
  -H 'Connect-Protocol-Version: 1' \
  -d '{}'
```

### shorts.v1alpha1.StockService

#### `POST /shorts.v1alpha1.StockService/GetCompanyTaxProfile`

Get an ASX-listed entity's annual corporate-tax profile (ATO transparency data).

Request body fields:

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `productCode` | string | no | (proto string) |

```bash
curl -X POST 'https://api.shorted.com.au/shorts.v1alpha1.StockService/GetCompanyTaxProfile' \
  -A 'my-app/1.0' \
  -H 'Content-Type: application/json' \
  -H 'Connect-Protocol-Version: 1' \
  -d '{}'
```

#### `POST /shorts.v1alpha1.StockService/GetDirectorTrades`

Get director (insider) trades for a specific stock

Request body fields:

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `limit` | integer (int32) | no | Max trades to return (default 20) (proto int32) |
| `stockCode` | string | no | ASX stock code (proto string) |

```bash
curl -X POST 'https://api.shorted.com.au/shorts.v1alpha1.StockService/GetDirectorTrades' \
  -A 'my-app/1.0' \
  -H 'Content-Type: application/json' \
  -H 'Connect-Protocol-Version: 1' \
  -d '{}'
```

#### `POST /shorts.v1alpha1.StockService/GetDividendHistory`

Get dividend history for a specific stock

Request body fields:

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `stockCode` | string | no | ASX stock code (proto string) |
| `years` | integer (int32) | no | How many years of history (default 5) (proto int32) |

```bash
curl -X POST 'https://api.shorted.com.au/shorts.v1alpha1.StockService/GetDividendHistory' \
  -A 'my-app/1.0' \
  -H 'Content-Type: application/json' \
  -H 'Connect-Protocol-Version: 1' \
  -d '{}'
```

#### `POST /shorts.v1alpha1.StockService/GetEventTimeline`

Get a chronological feed of events for a stock (announcements, director trades, news, short spikes)

Request body fields:

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `daysBack` | integer (int32) | no | number of days to look back (default 90) (proto int32) |
| `limit` | integer (int32) | no | max events to return (default 50) (proto int32) |
| `stockCode` | string | no | (proto string) |

```bash
curl -X POST 'https://api.shorted.com.au/shorts.v1alpha1.StockService/GetEventTimeline' \
  -A 'my-app/1.0' \
  -H 'Content-Type: application/json' \
  -H 'Connect-Protocol-Version: 1' \
  -d '{}'
```

#### `POST /shorts.v1alpha1.StockService/GetPeerComparison`

Get peer comparison for a stock within its industry

Request body fields:

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `limit` | integer (int32) | no | Number of peers (default 5) (proto int32) |
| `stockCode` | string | no | ASX stock code to compare (proto string) |

```bash
curl -X POST 'https://api.shorted.com.au/shorts.v1alpha1.StockService/GetPeerComparison' \
  -A 'my-app/1.0' \
  -H 'Content-Type: application/json' \
  -H 'Connect-Protocol-Version: 1' \
  -d '{}'
```

#### `POST /shorts.v1alpha1.StockService/GetStock`

Provides an overview of a specific stock based on PRODUCT_CODE.

Request body fields:

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `productCode` | string | no | (proto string) |

```bash
curl -X POST 'https://api.shorted.com.au/shorts.v1alpha1.StockService/GetStock' \
  -A 'my-app/1.0' \
  -H 'Content-Type: application/json' \
  -H 'Connect-Protocol-Version: 1' \
  -d '{}'
```

#### `POST /shorts.v1alpha1.StockService/GetStockData`

fetch time series data for a specific stock

Request body fields:

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `asOf` | string | no | Point-in-time filter, YYYY-MM-DD: return only observations that had been PUBLISHED by this date, i.e. whose available_from is on or before it. ASIC publishes T+4, so a series requested for a historical date otherwise includes up to four days of data nobody could have had. Setting as_of is what makes a walk-forward study honest without the caller applying a blunt lag by hand. Setting this IMPLIES full_resolution. The two are contradictory otherwise: a weekly bucket labelled D contains observations from after D, so a mean cannot answer a point-in-time question, and serving one silently defeats the other. A caller passing as_of has declared what they are doing, so the resolution follows from the request rather than from a second flag they must know to set. (proto string) |
| `from` | string | no | Explicit date range, YYYY-MM-DD, as an alternative to `period`. `from` alone runs to the end of the data. A caller wanting one specific window had to request MAX and discard most of what came back. (proto string) |
| `fullResolution` | boolean | no | Return every observation, unbucketed. By default the long periods (5Y, 10Y, MAX) are bucketed into weekly averages. That is the right shape for a chart and unusable for anything else: you cannot compute a per-observation change, align to a trading calendar, or measure an event window on a resampled series, and until now there was no way to ask for the raw record. The default is unchanged, so existing callers keep the series they already render. (proto bool) |
| `maxPoints` | integer (int32) | no | Cap on returned points, applied after `full_resolution`. 0 means no cap. Thinning keeps the first and last observation and spaces the rest evenly; `downsampled` reports whether it happened, so a caller never has to infer it from a suspiciously round point count. (proto int32) |
| `period` | string | no | Lookback window: 1D, 1W, 1M, 3M, 6M, 1Y, 2Y, 5Y, 10Y or MAX. Ignored when `from` is set. (proto string) |
| `productCode` | string | no | (proto string) |
| `to` | string | no | (proto string) |

```bash
curl -X POST 'https://api.shorted.com.au/shorts.v1alpha1.StockService/GetStockData' \
  -A 'my-app/1.0' \
  -H 'Content-Type: application/json' \
  -H 'Connect-Protocol-Version: 1' \
  -d '{}'
```

#### `POST /shorts.v1alpha1.StockService/GetStockDetails`

Provides a more in-depth breakdown of a particular stock's metadata.

Request body fields:

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `productCode` | string | no | (proto string) |

```bash
curl -X POST 'https://api.shorted.com.au/shorts.v1alpha1.StockService/GetStockDetails' \
  -A 'my-app/1.0' \
  -H 'Content-Type: application/json' \
  -H 'Connect-Protocol-Version: 1' \
  -d '{}'
```

#### `POST /shorts.v1alpha1.StockService/GetStockFinancialHighlights`

Get extracted financial highlights for specific stocks

Request body fields:

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `maxReportsPerStock` | integer (int32) | no | Max reports to return per stock (default 2) (proto int32) |
| `stockCodes` | array of string | no | ASX stock codes (e.g., ["DMP", "BHP"]) (proto string) |

```bash
curl -X POST 'https://api.shorted.com.au/shorts.v1alpha1.StockService/GetStockFinancialHighlights' \
  -A 'my-app/1.0' \
  -H 'Content-Type: application/json' \
  -H 'Connect-Protocol-Version: 1' \
  -d '{}'
```

#### `POST /shorts.v1alpha1.StockService/GetStockGraph`

Get a stock's people (with their other companies) and narrative-similar companies

Request body fields:

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `limit` | integer (int32) | no | max people / similar companies to return (default 12) (proto int32) |
| `stockCode` | string | no | (proto string) |

```bash
curl -X POST 'https://api.shorted.com.au/shorts.v1alpha1.StockService/GetStockGraph' \
  -A 'my-app/1.0' \
  -H 'Content-Type: application/json' \
  -H 'Connect-Protocol-Version: 1' \
  -d '{}'
```

#### `POST /shorts.v1alpha1.StockService/GetStockPrices`

Adjusted daily OHLCV for a stock, on the same codes and the same dates as
 the short-position series.

Request body fields:

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `from` | string | no | Explicit date range, YYYY-MM-DD. `from` alone runs to the end of the data. (proto string) |
| `maxPoints` | integer (int32) | no | Cap on returned points, 0 for no cap. Thinning keeps the first and last observation; `downsampled` reports whether it happened. (proto int32) |
| `period` | string | no | Lookback window: 1D, 1W, 1M, 3M, 6M, 1Y, 2Y, 5Y, 10Y or MAX. Ignored when `from` is set. Defaults to 1Y. (proto string) |
| `productCode` | string | no | NOTE when joining to short interest: this endpoint returns EVERY session by default, while GetStockData buckets the long periods (5Y, 10Y, MAX) into weekly averages. Pass full_resolution there to align the two, or the joined panel is a weekly-averaged short series against daily prices with nothing at the join site saying so. (proto string) |
| `to` | string | no | (proto string) |

```bash
curl -X POST 'https://api.shorted.com.au/shorts.v1alpha1.StockService/GetStockPrices' \
  -A 'my-app/1.0' \
  -H 'Content-Type: application/json' \
  -H 'Connect-Protocol-Version: 1' \
  -d '{}'
```

#### `POST /shorts.v1alpha1.StockService/GetStockSignals`

Get a stock's reputation/risk signals (adverse: court/sanctions/complaints; positive: awards/press)

Request body fields:

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `limit` | integer (int32) | no | max signals per polarity (default 10) (proto int32) |
| `stockCode` | string | no | (proto string) |

```bash
curl -X POST 'https://api.shorted.com.au/shorts.v1alpha1.StockService/GetStockSignals' \
  -A 'my-app/1.0' \
  -H 'Content-Type: application/json' \
  -H 'Connect-Protocol-Version: 1' \
  -d '{}'
```

#### `POST /shorts.v1alpha1.StockService/GetStockVerdict`

Get a composite bear-vs-bull verdict for a single stock

Request body fields:

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `productCode` | string | no | (proto string) |

```bash
curl -X POST 'https://api.shorted.com.au/shorts.v1alpha1.StockService/GetStockVerdict' \
  -A 'my-app/1.0' \
  -H 'Content-Type: application/json' \
  -H 'Connect-Protocol-Version: 1' \
  -d '{}'
```

## Model Context Protocol

A hosted MCP server exposes this data to MCP-capable clients over streamable
HTTP at `https://api.shorted.com.au/mcp` (protocol 2026-07-28). Point an MCP
client at that URL; no account, token or install step is required.

The live tool catalog is at `https://api.shorted.com.au/mcp/catalog.json`, and
connection instructions for Claude, ChatGPT and generic clients are at
https://shorted.com.au/docs/mcp.md

`https://shorted.com.au/api/mcp/mcp` still responds but is DEPRECATED: it is a
four-tool shim kept alive for existing client configurations.
