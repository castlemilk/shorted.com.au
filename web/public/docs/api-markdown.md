# Shorted Public API

Programmatic access to Australian market and public-interest data:
ASIC short positions for ASX-listed securities, Australian house prices
and suburb metrics, ABS/RBA economic series, and the federal register of
members' and senators' interests.

Every endpoint is a Connect-RPC method. Call it with an HTTP POST, a JSON
body, and the `Connect-Protocol-Version: 1` header:

```bash
curl -X POST https://api.shorted.com.au/shorts.v1alpha1.StockService/GetStock \
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
curl 'https://shorted.com.au/api/search/stocks?q=VALUE'
```

#### `GET /feed.xml`

RSS feed of editorial articles and short-selling reports

Base URL: `https://shorted.com.au` (not the API host).

```bash
curl 'https://shorted.com.au/feed.xml'
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
  -H 'Content-Type: application/json' \
  -H 'Connect-Protocol-Version: 1' \
  -d '{}'
```

#### `POST /shorts.v1alpha1.EconomyService/GetStateCompanyAggregates`

Exposure-weighted market cap and short interest aggregates by state.

Request body: an empty JSON object, `{}`.

```bash
curl -X POST 'https://api.shorted.com.au/shorts.v1alpha1.EconomyService/GetStateCompanyAggregates' \
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
  -H 'Content-Type: application/json' \
  -H 'Connect-Protocol-Version: 1' \
  -d '{}'
```

#### `POST /shorts.v1alpha1.HousingService/GetPriceDropsOverview`

State-level price-drop + listing-price rollup, plus a national summary row.

Request body: an empty JSON object, `{}`.

```bash
curl -X POST 'https://api.shorted.com.au/shorts.v1alpha1.HousingService/GetPriceDropsOverview' \
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
| `limit` | integer (int32) | no | Max stocks to return (default 50) (proto int32) |
| `offset` | integer (int32) | no | Pagination offset (proto int32) |

```bash
curl -X POST 'https://api.shorted.com.au/shorts.v1alpha1.MarketService/GetMarketByDate' \
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
  -H 'Content-Type: application/json' \
  -H 'Connect-Protocol-Version: 1' \
  -d '{}'
```

#### `POST /shorts.v1alpha1.PoliticiansService/GetParliamentOverview`

Parliament-wide counts and the as-at date. Cheap; drives the hub tiles.

Request body: an empty JSON object, `{}`.

```bash
curl -X POST 'https://api.shorted.com.au/shorts.v1alpha1.PoliticiansService/GetParliamentOverview' \
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
  -H 'Content-Type: application/json' \
  -H 'Connect-Protocol-Version: 1' \
  -d '{}'
```

#### `POST /shorts.v1alpha1.PoliticiansService/GetRegisterExplorer`

Aggregate register counts for the explorer hub.

Request body: an empty JSON object, `{}`.

```bash
curl -X POST 'https://api.shorted.com.au/shorts.v1alpha1.PoliticiansService/GetRegisterExplorer' \
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
  -H 'Content-Type: application/json' \
  -H 'Connect-Protocol-Version: 1' \
  -d '{}'
```

#### `POST /shorts.v1alpha1.StockService/GetStockData`

fetch time series data for a specific stock

Request body fields:

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `period` | string | no | (proto string) |
| `productCode` | string | no | (proto string) |

```bash
curl -X POST 'https://api.shorted.com.au/shorts.v1alpha1.StockService/GetStockData' \
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
  -H 'Content-Type: application/json' \
  -H 'Connect-Protocol-Version: 1' \
  -d '{}'
```

## Model Context Protocol

A hosted MCP server exposes this data to MCP-capable clients over streamable
HTTP at `https://shorted.com.au/api/mcp/mcp`. Point an MCP client at that URL;
no separate install step is required.
