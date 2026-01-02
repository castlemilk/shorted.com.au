# Market Data Sync API Deployment

## Summary

The market-data-sync service has been converted to an HTTP API server with endpoints for triggering syncs and tracking results.

## Changes Made

### Code Changes
1. **API Server** (`services/market-data-sync/api/server.go`)
   - HTTP endpoints for syncing stocks and checking status
   - Health check endpoints (`/healthz`, `/readyz`)
   
2. **Main Entry Point** (`services/market-data-sync/main.go`)
   - Supports API server mode (default) and CLI mode (`-cli` flag)
   - Configurable port via `PORT` env var

3. **Terraform Configuration**
   - Updated `terraform/modules/market-discovery-sync/main.tf` to deploy as Cloud Run Service
   - Enabled module in `terraform/environments/dev/main.tf`
   - Added outputs for service URL

### API Endpoints

- `POST /api/sync/stock/{symbol}` - Sync a specific stock
- `GET /api/sync/status/{runId}` - Get sync status by run ID
- `GET /api/sync/status` - Get latest incomplete sync status
- `POST /api/sync/all` - Trigger full sync (background)
- `GET /healthz` - Health check
- `GET /readyz` - Readiness check

## Deployment Steps

### Option 1: Via CI/CD (Recommended)

1. **Commit and push changes:**
   ```bash
   git add .
   git commit -m "feat: Convert market-data-sync to HTTP API service"
   git push origin feature/user-profile-and-login
   ```

2. **CI/CD will automatically:**
   - Build Docker image
   - Push to Artifact Registry
   - Deploy via Terraform

3. **After deployment, get service URL:**
   ```bash
   gcloud run services describe market-data-sync \
     --region=australia-southeast2 \
     --format='value(status.url)'
   ```

### Option 2: Manual Deployment (if you have permissions)

1. **Build and push image:**
   ```bash
   cd services
   make build.market-data-sync
   make push.market-data-sync
   ```

2. **Deploy via Terraform:**
   ```bash
   cd terraform/environments/dev
   terraform apply \
     -var="market_data_sync_image=australia-southeast2-docker.pkg.dev/shorted-dev-aba5688f/shorted/market-data-sync:latest" \
     -var="asx_discovery_image=australia-southeast2-docker.pkg.dev/shorted-dev-aba5688f/shorted/asx-discovery:latest"
   ```

## Testing After Deployment

### 1. Health Check
```bash
curl https://market-data-sync-xxx.run.app/healthz
```

### 2. Sync a Stock
```bash
curl -X POST https://market-data-sync-xxx.run.app/api/sync/stock/BHP
```

Response:
```json
{
  "run_id": "550e8400-e29b-41d4-a716-446655440000",
  "symbol": "BHP",
  "status": "success",
  "records_added": 1250,
  "started_at": "2026-01-02T20:00:00Z"
}
```

### 3. Check Status
```bash
curl https://market-data-sync-xxx.run.app/api/sync/status/{runId}
```

### 4. Trigger Full Sync
```bash
curl -X POST https://market-data-sync-xxx.run.app/api/sync/all
```

## Configuration

The service uses these environment variables (set via Terraform):

- `DATABASE_URL` - PostgreSQL connection (from Secret Manager)
- `GCS_BUCKET_NAME` - GCS bucket for ASX stock list
- `PRIORITY_STOCK_COUNT` - Number of top shorted stocks to prioritize (default: 100)
- `ALPHA_VANTAGE_API_KEY` - Alpha Vantage API key (from Secret Manager)
- `PORT` - HTTP server port (default: 8080)

## Next Steps

1. Commit and push changes to trigger CI/CD deployment
2. Wait for deployment to complete
3. Test the API endpoints
4. Monitor sync status via the status endpoints
