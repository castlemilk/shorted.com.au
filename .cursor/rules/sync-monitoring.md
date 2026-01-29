# Sync Job Monitoring

Rules and commands for monitoring production sync jobs in the Shorted.com.au platform.

## GCP Configuration

```
Project ID: rosy-clover-477102-t5
Region: australia-southeast2
Scheduler Region: australia-southeast1
Account: ben@shorted.com.au
```

## Quick Health Check

Run these commands to check sync job status:

```bash
# 1. Switch to correct account
gcloud config set account ben@shorted.com.au

# 2. List all Cloud Run jobs
gcloud run jobs list --project=rosy-clover-477102-t5 --region=australia-southeast2

# 3. Check recent executions for shorts-data-sync
gcloud run jobs executions list --job=shorts-data-sync --project=rosy-clover-477102-t5 --region=australia-southeast2 --limit=5

# 4. Check recent executions for asx-discovery
gcloud run jobs executions list --job=asx-discovery --project=rosy-clover-477102-t5 --region=australia-southeast2 --limit=5

# 5. List all scheduled jobs
gcloud scheduler jobs list --project=rosy-clover-477102-t5 --location=australia-southeast1
```

## Admin Dashboard

The web admin dashboard provides real-time monitoring:

- **URL**: https://shorted.com.au/admin (requires authentication)
- **Features**:
  - System health status (healthy/degraded/critical)
  - Automatic issue detection (stuck jobs, failures, zero-record completions)
  - Sync history table with checkpoint progress
  - Stats cards (last sync, success rate, records updated)

**Source files**:
- `web/src/app/admin/page.tsx` - Dashboard UI
- `web/src/app/actions/getSyncStatus.ts` - API client
- `web/src/app/admin/sync-utils.ts` - Health detection logic

## Sync Jobs Overview

### Cloud Run Jobs (Batch)

| Job | Schedule | Purpose |
|-----|----------|---------|
| `shorts-data-sync` | Daily 10:00 UTC | ASIC short positions + stock prices + key metrics |
| `asx-discovery` | Sunday 12:00 UTC | Scrape ASX website for new stock listings |

### Cloud Run Services (HTTP Endpoints)

| Service | Schedule | Endpoint | Purpose |
|---------|----------|----------|---------|
| `stock-price-ingestion` | Mon-Fri 8:00 UTC | `/sync-all` | Stock price updates |
| `market-data-sync` | Mon-Fri 10:00 UTC | `/api/sync/all` | Market data sync + gap filling |
| `enrichment-processor` | On-demand | Various | Company metadata enrichment |

## Viewing Logs

```bash
# shorts-data-sync logs (last 50)
gcloud logging read 'resource.type="cloud_run_job" AND resource.labels.job_name="shorts-data-sync"' \
  --project=rosy-clover-477102-t5 --limit=50 \
  --format=json | jq -r '.[] | "\(.timestamp) [\(.severity // "INFO")] \(.textPayload // "")"'

# asx-discovery logs
gcloud logging read 'resource.type="cloud_run_job" AND resource.labels.job_name="asx-discovery"' \
  --project=rosy-clover-477102-t5 --limit=50 \
  --format=json | jq -r '.[] | "\(.timestamp) [\(.severity // "INFO")] \(.textPayload // "")"'

# stock-price-ingestion service logs
gcloud logging read 'resource.type="cloud_run_revision" AND resource.labels.service_name="stock-price-ingestion"' \
  --project=rosy-clover-477102-t5 --limit=30 \
  --format=json | jq -r '.[] | "\(.timestamp) [\(.severity // "INFO")] \(.textPayload // "")"'

# market-data-sync service logs
gcloud logging read 'resource.type="cloud_run_revision" AND resource.labels.service_name="market-data-sync"' \
  --project=rosy-clover-477102-t5 --limit=30 \
  --format=json | jq -r '.[] | "\(.timestamp) [\(.severity // "INFO")] \(.textPayload // "")"'

# Filter for errors only
gcloud logging read 'resource.type="cloud_run_job" AND resource.labels.job_name="shorts-data-sync" AND severity>=ERROR' \
  --project=rosy-clover-477102-t5 --limit=20
```

## Manual Triggers

```bash
# Trigger shorts-data-sync
gcloud run jobs execute shorts-data-sync --project=rosy-clover-477102-t5 --region=australia-southeast2

# Trigger asx-discovery
gcloud run jobs execute asx-discovery --project=rosy-clover-477102-t5 --region=australia-southeast2

# Trigger scheduler job manually
gcloud scheduler jobs run shorts-data-sync-daily --project=rosy-clover-477102-t5 --location=australia-southeast1
```

## Troubleshooting

### Job Shows X (Failed) Status

1. **Check logs for error message**:
   ```bash
   gcloud logging read 'resource.type="cloud_run_job" AND resource.labels.job_name="shorts-data-sync" AND severity>=ERROR' \
     --project=rosy-clover-477102-t5 --limit=20
   ```

2. **Common issues**:
   - `DatatypeMismatchError` - Schema mismatch, check migrations
   - `Terminating task because it has reached the maximum timeout` - Job exceeded 1hr limit
   - `Connection refused` - Database connectivity issue

3. **Check execution details**:
   ```bash
   gcloud run jobs executions describe EXECUTION_NAME \
     --project=rosy-clover-477102-t5 --region=australia-southeast2
   ```

### Scheduler Not Triggering

1. **Check scheduler status**:
   ```bash
   gcloud scheduler jobs describe shorts-data-sync-daily \
     --project=rosy-clover-477102-t5 --location=australia-southeast1
   ```

2. **Look for `status.code: -1`** - Indicates scheduler error

3. **Verify service account permissions**:
   - `shorts-data-sync-scheduler@rosy-clover-477102-t5.iam.gserviceaccount.com`
   - Needs `roles/run.invoker` on the job

### No Data Being Synced

1. **Check ASIC data availability**: https://download.asic.gov.au/short-selling/short-selling-data.json

2. **Verify database connection**:
   ```bash
   # Check DATABASE_URL secret exists
   gcloud secrets versions access latest --secret=DATABASE_URL --project=rosy-clover-477102-t5
   ```

3. **Check sync_status table** via admin dashboard or direct query

### Key Metrics Timeout

The key metrics phase processes ~500 stocks per hour due to Yahoo Finance rate limiting. If the job times out during this phase:

- **Core data (shorts + prices) is already synced** - These complete first
- **Key metrics will continue on next run** - Partial progress is expected
- **This is normal behavior** - Not a critical failure

## Key Files Reference

| File | Purpose |
|------|---------|
| `terraform/modules/short-data-sync/main.tf` | Terraform config for shorts-data-sync job |
| `terraform/modules/market-discovery-sync/main.tf` | Terraform config for ASX discovery + market sync |
| `services/daily-sync/deprecated/comprehensive_daily_sync.py` | Python sync script (shorts + prices + metrics) |
| `services/migrations/000006_add_sync_status.up.sql` | sync_status table schema |
| `services/migrations/000013_add_priority_checkpoint.up.sql` | Checkpoint columns (INTEGER) |
| `web/src/app/admin/page.tsx` | Admin dashboard UI |

## Database Tables

The `sync_status` table tracks all sync runs:

```sql
-- Check recent sync runs
SELECT run_id, status, started_at, completed_at, 
       shorts_records_updated, prices_records_updated, metrics_records_updated,
       checkpoint_stocks_processed, checkpoint_stocks_total, error_message
FROM sync_status 
ORDER BY started_at DESC 
LIMIT 10;

-- Check for stuck jobs
SELECT * FROM sync_status 
WHERE status = 'running' 
  AND started_at < NOW() - INTERVAL '70 minutes';
```
