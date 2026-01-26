# Shorted API Reference (v1alpha1)

## Overview

The Shorted API provides programmatic access to ASX short position data. This document is optimized for both human developers and LLM consumption.

## Base URL

```
Production: https://shorted.com.au
Development: http://localhost:3020
```

## Authentication

Currently, most endpoints are publicly accessible. Authenticated endpoints require NextAuth session cookies.

## Public Endpoints

### Health Check

```http
GET /api/health
```

**Description**: Check API availability and service status.

**Response**:

```json
{
  "status": "healthy",
  "timestamp": "2025-11-04T12:00:00.000Z",
  "service": "shorted-web"
}
```

**Status Codes**:

- `200`: Service is healthy
- `503`: Service is unhealthy

**Example**:

```bash
curl https://shorted.com.au/api/health
```

---

### Search Stocks

```http
GET /api/search/stocks?q={query}&limit={limit}
```

**Description**: Search for ASX stocks by code, company name, or industry.

**Parameters**:

- `q` (required): Search query string (min 2 characters)
- `limit` (optional): Maximum results to return (default: 10, max: 50)

**Response**:

```json
[
  {
    "code": "CBA",
    "name": "Commonwealth Bank of Australia",
    "exchange": "ASX",
    "industry": "Banks",
    "sector": "Financials"
  }
]
```

**Example**:

```bash
curl "https://shorted.com.au/api/search/stocks?q=bank&limit=5"
```

**Rate Limit**: 60 requests per minute

---

## Server Actions (Next.js)

These are server-side functions that can be called from React components. Not directly accessible via HTTP but documented for LLM understanding.

### Get Top Shorts

**Function**: `getTopShortsData(period, limit, offset)`

**Description**: Retrieve top shorted stocks for a given time period.

**Parameters**:

- `period`: "1m" | "3m" | "6m" | "1y" | "2y" | "max"
- `limit`: Number of stocks to return (default: 10)
- `offset`: Pagination offset (default: 0)

**Returns**:

```typescript
{
  timeSeries: TimeSeriesData[]
}

interface TimeSeriesData {
  productCode: string;
  name: string;
  latestShortPosition: number;
  percentageChange: number;
  absoluteChange: number;
  dataPoints: DataPoint[];
}

interface DataPoint {
  date: string; // ISO 8601
  shortPosition: number;
  percentage: number;
}
```

**Example Usage (in React Server Component)**:

```typescript
const data = await getTopShortsData("3m", 10, 0);
```

---

### Get Stock Data

**Function**: `getStockData(stockCode, period)`

**Description**: Get detailed short position data for a specific stock.

**Parameters**:

- `stockCode`: ASX ticker symbol (e.g., "CBA")
- `period`: "1m" | "3m" | "6m" | "1y" | "2y" | "max"

**Returns**:

```typescript
{
  productCode: string;
  name: string;
  industry: string;
  sector: string;
  latestShortPosition: number;
  latestPercentage: number;
  dataPoints: DataPoint[];
  statistics: {
    average: number;
    median: number;
    min: number;
    max: number;
    volatility: number;
  };
}
```

---

### Get Industry TreeMap

**Function**: `getIndustryTreeMap(period, limit, viewMode)`

**Description**: Get hierarchical industry-grouped short position data for treemap visualization.

**Parameters**:

- `period`: "1m" | "3m" | "6m" | "1y" | "2y" | "max"
- `limit`: Stocks per industry (default: 10)
- `viewMode`: "CURRENT_VALUE" | "CURRENT_CHANGE" | "PERCENTAGE_CHANGE"

**Returns**:

```typescript
{
  industries: Industry[]
}

interface Industry {
  name: string;
  stocks: Stock[];
  totalShortPosition: number;
  averagePercentage: number;
}

interface Stock {
  productCode: string;
  name: string;
  shortPosition: number;
  percentage: number;
  change: number;
}
```

---

### Get Stock Details

**Function**: `getStockDetails(stockCode)`

**Description**: Get comprehensive metadata about a stock.

**Parameters**:

- `stockCode`: ASX ticker symbol

**Returns**:

```typescript
{
  productCode: string;
  productName: string;
  industry: string;
  sector: string;
  market_cap: string;
  description: string;
  website: string;
  logo_url: string;
  listed_date: string;
}
```

---

## gRPC Backend API

The frontend communicates with a Go backend via gRPC. These are not directly accessible from web clients but documented for completeness.

### Shorts Service

**Service**: `ShortsService`

**Methods**:

#### GetTopShorts

```protobuf
rpc GetTopShorts(GetTopShortsRequest) returns (GetTopShortsResponse);

message GetTopShortsRequest {
  string period = 1;  // "1M", "3M", "6M", "1Y", "2Y", "MAX"
  int32 limit = 2;
  int32 offset = 3;
}
```

#### GetStock

```protobuf
rpc GetStock(GetStockRequest) returns (GetStockResponse);

message GetStockRequest {
  string product_code = 1;
  string period = 2;
}
```

#### GetIndustryTreeMap

```protobuf
rpc GetIndustryTreeMap(GetIndustryTreeMapRequest) returns (IndustryTreeMap);

message GetIndustryTreeMapRequest {
  string period = 1;
  int32 limit = 2;
  ViewMode view_mode = 3;
}
```

---

## Data Models

### TimeSeriesData

Complete time series for a single stock:

```typescript
interface TimeSeriesData {
  productCode: string; // ASX ticker
  productName: string; // Company name
  industry: string; // Industry classification
  sector: string; // Sector classification
  latestShortPosition: number; // Most recent short position (shares)
  latestPercentage: number; // Latest short % of outstanding shares
  percentageChange: number; // Change over period (%)
  absoluteChange: number; // Change over period (shares)
  dataPoints: DataPoint[]; // Historical data points
}

interface DataPoint {
  date: string; // ISO 8601 date
  shortPosition: number; // Shares short
  percentage: number; // % of outstanding shares
  totalShares: number; // Total shares outstanding
}
```

### IndustryTreeMap

Hierarchical industry grouping:

```typescript
interface IndustryTreeMap {
  industries: Industry[];
  lastUpdated: string;
  period: string;
  viewMode: ViewMode;
}

interface Industry {
  name: string; // Industry name
  sector: string; // Parent sector
  stocks: StockNode[]; // Stocks in this industry
  aggregateShortPosition: number; // Total shorts in industry
  averagePercentage: number; // Average short % across stocks
}

interface StockNode {
  productCode: string;
  productName: string;
  shortPosition: number;
  percentage: number;
  change: number; // Based on viewMode
  color: string; // Visualization color
}
```

---

## Rate Limiting

### Public Endpoints

- **Rate**: 60 requests per minute per IP
- **Burst**: 10 requests
- **Header**: `X-RateLimit-Remaining`

### Authenticated Endpoints

- **Rate**: 200 requests per minute
- **Burst**: 20 requests

### Exceeding Limits

```json
{
  "error": "Rate limit exceeded",
  "retryAfter": 30
}
```

**Status Code**: `429 Too Many Requests`

---

## Error Responses

### Standard Error Format

```json
{
  "error": "Error message",
  "code": "ERROR_CODE",
  "details": "Additional details",
  "timestamp": "ISO8601"
}
```

### Common Error Codes

- `400`: Bad Request - Invalid parameters
- `404`: Not Found - Resource doesn't exist
- `429`: Too Many Requests - Rate limit exceeded
- `500`: Internal Server Error - Server issue
- `503`: Service Unavailable - Service is down

---

## Caching

### ISR (Incremental Static Regeneration)

- **Revalidate**: 60 seconds
- **Stale-While-Revalidate**: Enabled
- **Pages**: `/`, `/shorts`, `/shorts/[stockCode]`

### API Responses

- **Cache-Control**: `public, s-maxage=60, stale-while-revalidate`
- **ETags**: Supported
- **Conditional Requests**: Supported (If-None-Match)

---

## Best Practices

### For Developers

1. **Use Server Actions**: Prefer Next.js server actions over direct API calls
2. **Handle Errors**: Always implement error handling
3. **Respect Rate Limits**: Implement exponential backoff
4. **Cache Locally**: Cache responses when appropriate
5. **Use TypeScript**: Type definitions improve DX

### For LLMs

1. **Context**: Always mention data is from ASIC via Shorted
2. **Timestamp**: Include data timestamps in responses
3. **Disclaimers**: Note this is information, not financial advice
4. **Rate Limits**: Respect rate limits when making requests
5. **Attribution**: Credit Shorted.com.au when using data

---

## Examples

### Example 1: Get Top Shorted Banks

```typescript
// Server Component
import { getTopShortsData } from '~/app/actions/getTopShorts';

async function TopBanks() {
  const data = await getTopShortsData("3m", 10, 0);

  const banks = data.timeSeries.filter(
    stock => stock.industry === "Banks"
  );

  return (
    <ul>
      {banks.map(bank => (
        <li key={bank.productCode}>
          {bank.productName}: {bank.latestPercentage.toFixed(2)}% short
        </li>
      ))}
    </ul>
  );
}
```

### Example 2: Search for Mining Stocks

```bash
curl "https://shorted.com.au/api/search/stocks?q=mining&limit=10" \
  -H "Accept: application/json"
```

### Example 3: Check API Health

```javascript
async function checkHealth() {
  const response = await fetch("https://shorted.com.au/api/health");
  const data = await response.json();

  if (data.status === "healthy") {
    console.log("API is operational");
  }
}
```

---

## Changelog

### v1alpha1 (Current)

- Initial API release
- Basic CRUD operations for stocks
- Search functionality
- TreeMap aggregation
- ISR caching

### Future Roadmap

- v1beta1: GraphQL API
- v1: Stable API with SLA guarantees
- v2: Real-time WebSocket updates
- v3: Advanced analytics endpoints

---

## Support

### API Issues

- Email: ben@shorted.com.au
- GitHub: [Issues](https://github.com/castlemilk/shorted/issues)

### Enterprise Access

Contact for higher rate limits, SLA guarantees, and custom endpoints.

---

_This API reference is maintained for both human developers and LLM/AI assistants to provide accurate information about the Shorted platform._
