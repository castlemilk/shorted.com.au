# Key Metrics Sync API Documentation

## Overview

The `SyncKeyMetrics` endpoint allows administrators to trigger on-demand synchronization of key financial metrics (market cap, P/E ratio, etc.) for specific stocks or all stocks.

## Endpoint

**RPC**: `shorts.v1alpha1.ShortedStocksService/SyncKeyMetrics`

**Authorization**: Admin role required

**Method**: POST

## Request

```protobuf
message SyncKeyMetricsRequest {
  repeated string stock_codes = 1; // Stock codes to sync (e.g., ["CVN", "CBA"]). Empty = sync all.
  bool force = 2; // Force sync even if recently updated (default: false)
}
```

### Parameters

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `stock_codes` | string[] | No | List of stock codes to sync. If empty, syncs all stocks in `company-metadata` table. |
| `force` | bool | No | If true, syncs even if `key_metrics_updated_at` is recent. Default: false. |

## Response

```protobuf
message SyncKeyMetricsResponse {
  int32 total_requested = 1;
  int32 successfully_synced = 2;
  int32 failed = 3;
  repeated StockSyncResult results = 4;
  double duration_seconds = 5;
}

message StockSyncResult {
  string stock_code = 1;
  bool success = 2;
  string error_message = 3;
  KeyMetricsData metrics = 4; // The synced metrics if successful
}

message KeyMetricsData {
  double market_cap = 1;
  double pe_ratio = 2;
  double eps = 3;
  double dividend_yield = 4;
  double beta = 5;
  double fifty_two_week_high = 6;
  double fifty_two_week_low = 7;
  double avg_volume = 8;
}
```

### Response Fields

| Field | Type | Description |
|-------|------|-------------|
| `total_requested` | int32 | Number of stocks requested to sync |
| `successfully_synced` | int32 | Number of stocks successfully synced |
| `failed` | int32 | Number of stocks that failed to sync |
| `results` | StockSyncResult[] | Detailed results for each stock |
| `duration_seconds` | double | Total time taken for the sync operation |

## Examples

### Sync Specific Stocks

```bash
curl -X POST "http://localhost:9091/shorts.v1alpha1.ShortedStocksService/SyncKeyMetrics" \
  -H "Content-Type: application/json" \
  -H "X-Internal-Secret: dev-internal-secret" \
  -H "X-User-Roles: admin" \
  -d '{
    "stockCodes": ["CVN", "CBA", "BHP"],
    "force": true
  }'
```

Response:
```json
{
  "totalRequested": 3,
  "successfullySynced": 3,
  "failed": 0,
  "results": [
    {
      "stockCode": "CVN",
      "success": true,
      "metrics": {
        "marketCap": 152072384,
        "beta": 0.88,
        "fiftyTwoWeekHigh": 0.16,
        "fiftyTwoWeekLow": 0.085,
        "avgVolume": 1535318
      }
    },
    // ... more results
  ],
  "durationSeconds": 6.234
}
```

### Sync All Stocks

```bash
curl -X POST "http://localhost:9091/shorts.v1alpha1.ShortedStocksService/SyncKeyMetrics" \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer <your-admin-token>" \
  -d '{
    "stockCodes": [],  // Empty array = sync all
    "force": false
  }'
```

### Sync Single Stock (Force Update)

```bash
curl -X POST "http://localhost:9091/shorts.v1alpha1.ShortedStocksService/SyncKeyMetrics" \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer <your-admin-token>" \
  -d '{
    "stockCodes": ["CVN"],
    "force": true
  }'
```

## Use Cases

### 1. Fix Missing Data for Specific Stock
When a stock like CVN is missing market cap data:
```bash
# Sync just CVN
curl ... -d '{"stockCodes": ["CVN"], "force": true}'
```

### 2. Update Stale Data
Force refresh of recently IPO'd stock or after major corporate event:
```bash
# Force update even if recently synced
curl ... -d '{"stockCodes": ["NEW"], "force": true}'
```

### 3. Bulk Update Top Shorted Stocks
Sync only the most actively shorted stocks:
```bash
# Get top 50 and sync them
curl ... -d '{"stockCodes": ["CBA", "BHP", ...], "force": false}'
```

### 4. Full Database Refresh
Sync all stocks (useful after Yahoo Finance API changes):
```bash
# Empty stockCodes = sync all
curl ... -d '{"stockCodes": [], "force": true}'
```

## Authentication

### Local Development
Use internal secret for testing:
```bash
-H "X-Internal-Secret: dev-internal-secret" \
-H "X-User-Roles: admin"
```

### Production
Use JWT Bearer token from authenticated admin user:
```bash
-H "Authorization: Bearer <admin-jwt-token>"
```

## Error Handling

### Common Errors

| Error | Cause | Solution |
|-------|-------|----------|
| `authentication required` | No auth headers | Add Authorization or X-Internal-Secret header |
| `forbidden: admin role required` | User is not admin | Use admin account |
| `stock not found in company-metadata` | Stock doesn't exist in DB | Add stock to company-metadata first |
| `No data available from Yahoo Finance` | Yahoo Finance has no data for this symbol | Check if stock code is correct (must be ASX stock) |
| `failed to fetch from Yahoo Finance` | Network/rate limit error | Retry with backoff |

### Example Error Response

```json
{
  "totalRequested": 1,
  "successfullySynced": 0,
  "failed": 1,
  "results": [
    {
      "stockCode": "INVALID",
      "success": false,
      "errorMessage": "No data available from Yahoo Finance"
    }
  ],
  "durationSeconds": 1.5
}
```

## Implementation Details

### Data Source
- Fetches data from **Yahoo Finance** (`yfinance` Python library)
- ASX stocks use `.AX` suffix (e.g., `CVN.AX`)

### Rate Limiting
- 100ms delay between requests
- Suitable for small batches (< 100 stocks)
- For larger batches, use the scheduled daily sync job

### Database Updates
Updates the following columns in `company-metadata`:
- `key_metrics` (JSONB) - Contains all metric data
- `key_metrics_updated_at` (TIMESTAMP) - Last update timestamp

### Metrics Stored
- Market Capitalization
- P/E Ratio (trailing)
- EPS (earnings per share)
- Dividend Yield
- Beta (volatility)
- 52-week high/low
- Average volume

## Integration with GetStockDetails

After syncing, the data is automatically merged into `financial_statements.info`:

```bash
# 1. Sync CVN
curl ... /SyncKeyMetrics -d '{"stockCodes": ["CVN"]}'

# 2. Fetch details (automatically includes synced data)
curl ... /GetStockDetails -d '{"productCode": "CVN"}'
```

Response includes:
```json
{
  "productCode": "CVN",
  "financialStatements": {
    "success": true,
    "info": {
      "marketCap": 152072384,  // From key_metrics!
      "beta": 0.88,
      "fiftyTwoWeekHigh": 0.16,
      "fiftyTwoWeekLow": 0.085,
      "volume": 1535318
    }
  }
}
```

## Testing

### Local Testing
```bash
cd services/shorts

# Test Python script directly
python3 scripts/fetch_key_metrics.py CVN

# Test API endpoint
curl -X POST "http://localhost:9091/shorts.v1alpha1.ShortedStocksService/SyncKeyMetrics" \
  -H "Content-Type: application/json" \
  -H "X-Internal-Secret: dev-internal-secret" \
  -H "X-User-Roles: admin" \
  -d '{"stockCodes": ["CVN"], "force": true}'
```

### Makefile Commands
```bash
# Run full daily sync (all stocks, all data)
make daily-sync-execute

# Check sync logs
make daily-sync-logs

# Check sync status
make daily-sync-status
```

## Monitoring

### Check What Was Synced
```sql
SELECT 
  stock_code,
  key_metrics->>'market_cap' as market_cap,
  key_metrics->>'pe_ratio' as pe_ratio,
  key_metrics_updated_at
FROM "company-metadata"
WHERE stock_code = 'CVN';
```

### Find Stocks Missing Key Metrics
```sql
SELECT stock_code, company_name
FROM "company-metadata"
WHERE key_metrics IS NULL
OR key_metrics_updated_at < NOW() - INTERVAL '30 days'
ORDER BY stock_code
LIMIT 100;
```

## Production Deployment

The SyncKeyMetrics endpoint will be available after deploying:

```bash
cd services
make build.shorts
make deploy.gcr.shorts
```

Or automatically via CI/CD when PR is merged.

## Related Files

- `proto/shortedapi/shorts/v1alpha1/shorts.proto` - API definition
- `services/shorts/internal/services/shorts/sync_key_metrics.go` - Endpoint implementation
- `services/shorts/internal/store/shorts/postgres.go` - Database operations
- `services/shorts/scripts/fetch_key_metrics.py` - Yahoo Finance data fetcher
- `services/daily-sync/comprehensive_daily_sync.py` - Scheduled daily sync job

