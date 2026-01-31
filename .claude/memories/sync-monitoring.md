# Sync Job Monitoring Memory

Quick reference for monitoring production sync jobs in the Shorted.com.au platform.

## GCP Configuration

- **Project ID**: rosy-clover-477102-t5
- **Region**: australia-southeast2
- **Scheduler Region**: australia-southeast1
- **Account**: ben@shorted.com.au

## Quick Health Check Commands

```bash
# Switch account
gcloud config set account ben@shorted.com.au

# List Cloud Run jobs
gcloud run jobs list --project=rosy-clover-477102-t5 --region=australia-southeast2

# Check shorts-data-sync executions
gcloud run jobs executions list --job=shorts-data-sync --project=rosy-clover-477102-t5 --region=australia-southeast2 --limit=5

# Check asx-discovery executions
gcloud run jobs executions list --job=asx-discovery --project=rosy-clover-477102-t5 --region=australia-southeast2 --limit=5

# List schedulers
gcloud scheduler jobs list --project=rosy-clover-477102-t5 --location=australia-southeast1

# List Cloud Run services
gcloud run services list --project=rosy-clover-477102-t5 --region=australia-southeast2
```

## Sync Jobs Overview

### Cloud Run Jobs (Batch)
| Job | Schedule | Purpose |
|-----|----------|---------|
| shorts-data-sync | Daily 10:00 UTC | ASIC short positions + stock prices + key metrics |
| asx-discovery | Sunday 12:00 UTC | Scrape ASX for new stock listings |

### Cloud Run Services (HTTP)
| Service | Schedule | Purpose |
|---------|----------|---------|
| stock-price-ingestion | Mon-Fri 8:00 UTC | Stock price updates |
| market-data-sync | Mon-Fri 10:00 UTC | Market data sync + gap filling |
| enrichment-processor | On-demand | Company metadata enrichment |

## Viewing Logs

```bash
# shorts-data-sync logs
gcloud logging read 'resource.type="cloud_run_job" AND resource.labels.job_name="shorts-data-sync"' \
  --project=rosy-clover-477102-t5 --limit=30 --format=json | jq -r '.[] | "\(.timestamp) \(.textPayload // "")"'

# Service logs with errors
gcloud logging read 'resource.type="cloud_run_revision" AND resource.labels.service_name="shorts" AND severity>=WARNING' \
  --project=rosy-clover-477102-t5 --limit=15 --format=json | jq -r '.[] | "\(.timestamp) \(.textPayload // .jsonPayload.message // "")"'
```

## Manual Triggers

```bash
# Trigger shorts-data-sync
gcloud run jobs execute shorts-data-sync --project=rosy-clover-477102-t5 --region=australia-southeast2

# Trigger asx-discovery
gcloud run jobs execute asx-discovery --project=rosy-clover-477102-t5 --region=australia-southeast2
```

## Admin Dashboard

- **URL**: https://shorted.com.au/admin (requires authentication)
- **Source files**:
  - `web/src/app/admin/page.tsx` - Dashboard UI
  - `web/src/app/actions/getSyncStatus.ts` - API client
  - `web/src/app/admin/sync-utils.ts` - Health detection logic

## Known Behaviors

### Key Metrics Timeout (Expected)
The key metrics phase processes ~500 stocks per hour due to Yahoo Finance rate limiting. If the job times out during this phase:
- Core data (shorts + prices) is already synced before timeout
- Key metrics will continue on next run
- Exit code 0 with "reached maximum timeout" is normal
- NOT a critical failure

### Execution Status Icons
- ✔ (green) = Successful completion
- X (red) = Failed or timed out (check exit code - 0 means timeout, not crash)

## Troubleshooting

### Check Execution Details
```bash
gcloud run jobs executions describe EXECUTION_NAME \
  --project=rosy-clover-477102-t5 --region=australia-southeast2
```

### Common Issues
- `DatatypeMismatchError` - Schema mismatch, check migrations
- `Terminating task because it has reached the maximum timeout` - Expected for key metrics phase
- `Connection refused` - Database connectivity issue

### Database Queries
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
