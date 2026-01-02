# Market Data Sync API

HTTP API service for syncing stock market data with prioritization and checkpoint tracking.

## Endpoints

### Health Checks

- `GET /healthz` - Health check endpoint
- `GET /readyz` - Readiness check endpoint (checks database connection)
- `GET /health` - Alias for `/healthz`

### Sync Endpoints

#### Sync Single Stock
```bash
POST /api/sync/stock/{symbol}
```

Syncs price data for a specific stock symbol.

**Example:**
```bash
curl -X POST http://localhost:8080/api/sync/stock/BHP
```

**Response:**
```json
{
  "run_id": "550e8400-e29b-41d4-a716-446655440000",
  "symbol": "BHP",
  "status": "success",
  "records_added": 1250,
  "started_at": "2026-01-02T20:00:00Z"
}
```

#### Get Sync Status
```bash
GET /api/sync/status/{runId}
```

Get status of a specific sync run.

**Example:**
```bash
curl http://localhost:8080/api/sync/status/550e8400-e29b-41d4-a716-446655440000
```

**Response:**
```json
{
  "run_id": "550e8400-e29b-41d4-a716-446655440000",
  "status": "completed",
  "stocks_total": 1,
  "stocks_processed": 1,
  "stocks_successful": 1,
  "stocks_failed": 0,
  "priority_total": 0,
  "priority_processed": 0,
  "priority_completed": false,
  "prices_records_updated": 1250,
  "algolia_records_synced": 0
}
```

#### Get Latest Status
```bash
GET /api/sync/status
```

Get status of the latest incomplete sync run (if any).

#### Trigger Full Sync
```bash
POST /api/sync/all
```

Triggers a full sync of all stocks (runs in background).

**Example:**
```bash
curl -X POST http://localhost:8080/api/sync/all
```

**Response:**
```json
{
  "status": "started",
  "message": "Full sync started in background"
}
```

## Configuration

Environment variables:

- `DATABASE_URL` - PostgreSQL connection string (required)
- `GCS_BUCKET_NAME` - GCS bucket name (default: `shorted-data`)
- `PRIORITY_STOCK_COUNT` - Number of top shorted stocks to prioritize (default: `100`)
- `ALPHA_VANTAGE_API_KEY` - Alpha Vantage API key (optional, used as fallback)
- `PORT` - HTTP server port (default: `8080`)
- `SYNC_ALGOLIA` - Enable Algolia sync (default: `false`)
- `ALGOLIA_APP_ID` - Algolia application ID
- `ALGOLIA_ADMIN_KEY` - Algolia admin API key
- `ALGOLIA_INDEX` - Algolia index name (default: `stocks`)

## Running Locally

### API Server Mode (default)
```bash
make run.market-data-sync PORT=8080 ALPHA_VANTAGE_API_KEY=your-key
```

### CLI Mode (full sync and exit)
```bash
make run.market-data-sync-cli ALPHA_VANTAGE_API_KEY=your-key
```

## Deployment

The service is deployed as a Cloud Run service via Terraform:

```hcl
module "market_discovery_sync" {
  source = "../../modules/market-discovery-sync"
  
  project_id             = var.project_id
  region                 = var.region
  environment            = "production"
  asx_discovery_image    = var.asx_discovery_image
  market_data_sync_image = var.market_data_sync_image
  bucket_name            = module.short_data_sync.bucket_name
  min_instances          = 0
  max_instances          = 10
}
```

## Usage Examples

### Sync a specific stock
```bash
# Local
curl -X POST http://localhost:8080/api/sync/stock/NAB

# Production (after deployment)
curl -X POST https://market-data-sync-xxx.run.app/api/sync/stock/NAB
```

### Check sync status
```bash
curl http://localhost:8080/api/sync/status/{runId}
```

### Trigger full sync
```bash
curl -X POST http://localhost:8080/api/sync/all
```

## Provider Fallback

The service uses a provider fallback strategy:

1. **Yahoo Finance** (primary) - Free, unlimited
2. **Alpha Vantage** (fallback) - Rate limited (5 calls/minute free tier)

If Yahoo Finance fails, Alpha Vantage is automatically tried.
