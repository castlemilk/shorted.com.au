# Data Sync

Manage data population and synchronization for ASIC short data and stock prices. Use when populating the database, syncing data, or troubleshooting data issues.

## Quick Commands

```bash
# Full data population (downloads ASIC files)
make populate-data

# Quick population (existing CSV files)
make populate-data-quick

# Daily sync (ASIC shorts + stock prices)
make daily-sync-local

# Sync Algolia search index
make algolia-sync

# Stock price backfill
cd services && make history.stock-data.backfill
```

## Instructions

### ASIC Short Data

```bash
# First time (downloads ~3,500 CSV files)
make populate-data

# With existing files
make populate-data-quick

# Force re-download
cd services && make populate-data-force
```

### Stock Price Backfill

```bash
# Test (10 stocks, 1 year)
cd services && make history.stock-data.backfill-test

# Standard (all stocks, 2 years)
cd services && make history.stock-data.backfill

# Full (all stocks, 5 years)
cd services && make history.stock-data.backfill-full
```

### Repair Data Gaps

```bash
# Check for gaps
make repair-gaps-dry-run

# Repair specific stocks
make repair-gaps STOCKS=CBA,BHP

# Repair all
make repair-gaps-all
```

### Algolia Search

```bash
# Sync local
make algolia-sync

# Sync production
make algolia-sync-prod

# Test search
make algolia-search Q=BHP
```

### Company Enrichment

```bash
# Enrich 10 companies
make enrich-metadata LIMIT=10

# Specific stocks
make enrich-metadata-stocks STOCKS="CBA BHP WBC"
```

## Verify Data

```sql
-- Short data
SELECT COUNT(*) FROM shorts;
SELECT COUNT(DISTINCT "PRODUCT_CODE") FROM shorts;

-- Stock prices
SELECT COUNT(*) FROM stock_prices;
SELECT MIN(date), MAX(date) FROM stock_prices;

-- Company metadata
SELECT COUNT(*) FROM "company-metadata" WHERE description IS NOT NULL;
```

## Environment Variables

```bash
DATABASE_URL=postgresql://admin:password@localhost:5438/shorts
ALGOLIA_APP_ID=1BWAPWSTDD
ALGOLIA_ADMIN_KEY=your_key
OPENAI_API_KEY=sk-...  # For enrichment
```

## Production Monitoring

### Admin Dashboard

Monitor sync jobs via the web admin dashboard:
- **URL**: https://shorted.com.au/admin
- **Features**: System health, issue detection, sync history, checkpoint progress

### Check Sync Job Status (GCloud)

```bash
# Switch to shorted account
gcloud config set account ben@shorted.com.au

# List all jobs
gcloud run jobs list --project=rosy-clover-477102-t5 --region=australia-southeast2

# Check recent executions
gcloud run jobs executions list --job=shorts-data-sync --project=rosy-clover-477102-t5 --region=australia-southeast2 --limit=5

# List schedulers
gcloud scheduler jobs list --project=rosy-clover-477102-t5 --location=australia-southeast1

# View logs
gcloud logging read 'resource.type="cloud_run_job" AND resource.labels.job_name="shorts-data-sync"' \
  --project=rosy-clover-477102-t5 --limit=50 \
  --format=json | jq -r '.[] | "\(.timestamp) [\(.severity // "INFO")] \(.textPayload // "")"'
```

### Scheduled Jobs

| Schedule | Job | Time (UTC) | Purpose |
|----------|-----|------------|---------|
| Daily | `shorts-data-sync-daily` | 10:00 | ASIC shorts + stock prices + metrics |
| Mon-Fri | `stock-price-daily-sync` | 8:00 | Stock price updates |
| Mon-Fri | `market-data-sync-daily` | 10:00 | Market data sync |
| Sunday | `asx-discovery-weekly` | 12:00 | ASX stock list scraping |

### Manual Trigger

```bash
# Trigger shorts-data-sync
gcloud run jobs execute shorts-data-sync --project=rosy-clover-477102-t5 --region=australia-southeast2

# Trigger asx-discovery
gcloud run jobs execute asx-discovery --project=rosy-clover-477102-t5 --region=australia-southeast2
```

## Troubleshooting

### Job Failed (X Status)

1. **Check error logs**:
   ```bash
   gcloud logging read 'resource.type="cloud_run_job" AND resource.labels.job_name="shorts-data-sync" AND severity>=ERROR' \
     --project=rosy-clover-477102-t5 --limit=20
   ```

2. **Common issues**:
   - `DatatypeMismatchError` - Schema mismatch between code and DB
   - `Timeout` - Job exceeded 1hr limit (key metrics phase is slow)
   - `Connection refused` - Database connectivity

### Database Schema Issues

If sync fails with type errors, check migrations:
- `services/migrations/000006_add_sync_status.up.sql` - sync_status table
- `services/migrations/000013_add_priority_checkpoint.up.sql` - INTEGER columns

### Check sync_status Table

```sql
-- Recent sync runs
SELECT run_id, status, started_at, 
       shorts_records_updated, prices_records_updated, 
       checkpoint_stocks_processed, checkpoint_stocks_total
FROM sync_status ORDER BY started_at DESC LIMIT 10;

-- Stuck jobs
SELECT * FROM sync_status 
WHERE status = 'running' AND started_at < NOW() - INTERVAL '70 minutes';
```

### Key Files

| File | Purpose |
|------|---------|
| `services/daily-sync/deprecated/comprehensive_daily_sync.py` | Main sync script |
| `terraform/modules/short-data-sync/main.tf` | Job infrastructure |
| `web/src/app/admin/page.tsx` | Admin dashboard |

For detailed monitoring commands, see `.cursor/rules/sync-monitoring.md`.

