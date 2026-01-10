# Market Data Sync & ASX Discovery Verification Guide

## Overview

This guide helps verify that:
1. ✅ ASX Discovery service downloads stock list and uploads to GCS
2. ✅ Market Data Sync service reads from GCS and syncs stock prices
3. ✅ End-to-end flow works correctly

## Architecture Flow

```
ASX Discovery (Cloud Run Job)
    ↓ Downloads CSV from ASX website
    ↓ Uploads to GCS: gs://{bucket}/asx-stocks/latest.csv
    ↓
Market Data Sync (Cloud Run Service)
    ↓ Reads stock list from GCS
    ↓ Fetches prices from Yahoo Finance / Alpha Vantage
    ↓ Stores in PostgreSQL database
```

## Step 1: Check Deployment Status

### Get Service URL from Terraform Outputs

```bash
cd terraform/environments/dev
terraform output market_data_sync_service_url
```

Or check GitHub Actions workflow output for the service URL.

### Verify Service is Deployed

```bash
# Replace with actual service URL
SERVICE_URL="https://market-data-sync-XXXXX.run.app"
curl "$SERVICE_URL/healthz"
```

Expected: `{"status":"healthy"}`

## Step 2: Verify ASX Discovery Has Run

### Check GCS Bucket

```bash
# List ASX stock files in GCS
gsutil ls gs://shorted-short-selling-data/asx-stocks/

# Check latest.csv exists
gsutil ls gs://shorted-short-selling-data/asx-stocks/latest.csv

# View file info
gsutil stat gs://shorted-short-selling-data/asx-stocks/latest.csv

# Count stocks (should be ~2000+)
gsutil cat gs://shorted-short-selling-data/asx-stocks/latest.csv | wc -l
```

### Manually Trigger ASX Discovery (if needed)

```bash
# Trigger the Cloud Run Job manually
gcloud run jobs execute asx-discovery \
  --region=australia-southeast2 \
  --project=shorted-dev-aba5688f
```

## Step 3: Test Market Data Sync Service

### Run Verification Script

```bash
./verify-market-data-sync.sh [SERVICE_URL] [GCS_BUCKET]
```

### Manual Testing

#### 1. Health Check
```bash
curl https://{SERVICE_URL}/healthz
# Expected: {"status":"healthy"}
```

#### 2. Readiness Check
```bash
curl https://{SERVICE_URL}/readyz
# Expected: {"status":"ready"}
```

#### 3. Sync Single Stock
```bash
curl -X POST https://{SERVICE_URL}/api/sync/stock/BHP \
  -H "Content-Type: application/json"
```

Expected response:
```json
{
  "run_id": "550e8400-e29b-41d4-a716-446655440000",
  "symbol": "BHP",
  "status": "success",
  "records_added": 1250,
  "started_at": "2026-01-02T20:00:00Z"
}
```

#### 4. Check Sync Status
```bash
curl https://{SERVICE_URL}/api/sync/status/{run_id}
```

#### 5. Trigger Full Sync
```bash
curl -X POST https://{SERVICE_URL}/api/sync/all
```

Expected response:
```json
{
  "status": "started",
  "message": "Full sync started in background"
}
```

## Step 4: Verify End-to-End Flow

### Expected Behavior

1. **ASX Discovery** runs weekly (Sunday 12PM UTC) and uploads CSV to GCS
2. **Market Data Sync** reads from `gs://{bucket}/asx-stocks/latest.csv`
3. Service prioritizes top 100 shorted stocks
4. Fetches prices from Yahoo Finance (primary) or Alpha Vantage (fallback)
5. Stores prices in PostgreSQL `stock_prices` table

### Verify Database

```sql
-- Check if prices were synced
SELECT COUNT(*) FROM stock_prices WHERE stock_code = 'BHP';

-- Check recent syncs
SELECT stock_code, MAX(date) as latest_date, COUNT(*) as records
FROM stock_prices
GROUP BY stock_code
ORDER BY latest_date DESC
LIMIT 10;
```

## Troubleshooting

### Service Returns 404

- Check GitHub Actions workflow completed successfully
- Verify Terraform deployment succeeded
- Check service URL is correct

### GCS File Not Found

- ASX discovery job may not have run yet
- Manually trigger the job (see Step 2)
- Check job logs: `gcloud logging read "resource.type=cloud_run_job AND resource.labels.job_name=asx-discovery" --limit 50`

### Stock Sync Fails

- Check service logs: `gcloud logging read "resource.type=cloud_run_revision AND resource.labels.service_name=market-data-sync" --limit 50`
- Verify database connection
- Check API keys (Alpha Vantage) are set in Secret Manager
- Verify GCS bucket permissions

### Service Not Reading from GCS

- Check `GCS_BUCKET_NAME` environment variable is set correctly
- Verify service account has `roles/storage.objectViewer` permission
- Check logs for GCS access errors

## Cloud Scheduler Jobs

### ASX Discovery (Weekly)
- Schedule: `0 12 * * 0` (Sunday 12PM UTC)
- Job: `asx-discovery-weekly`
- Triggers: `asx-discovery` Cloud Run Job

### Market Data Sync (Daily)
- Schedule: `0 10 * * 1-5` (Mon-Fri 10AM UTC = 8PM AEST)
- Job: `market-data-sync-daily`
- Triggers: `POST /api/sync/all` endpoint

## Monitoring

### Check Service Logs
```bash
# Market Data Sync
gcloud logging read "resource.type=cloud_run_revision AND resource.labels.service_name=market-data-sync" --limit 50

# ASX Discovery
gcloud logging read "resource.type=cloud_run_job AND resource.labels.job_name=asx-discovery" --limit 50
```

### Check Scheduler Status
```bash
# List scheduler jobs
gcloud scheduler jobs list --location=australia-southeast2 --project=shorted-dev-aba5688f

# Check job status
gcloud scheduler jobs describe market-data-sync-daily --location=australia-southeast2 --project=shorted-dev-aba5688f
```
