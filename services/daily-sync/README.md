# Comprehensive Daily Sync Service

Automated daily updates for **both** shorts data and stock prices.

## 🎯 What It Does

This Cloud Run Job runs daily at **2 AM AEST** and updates:

1. **📊 Shorts Data** - Last 7 days from ASIC
2. **💰 Stock Prices** - Last 5 days from Yahoo Finance (for all 107 existing stocks)

## 🚀 Quick Start

### Prerequisites

```bash
# Set required environment variables
export DATABASE_URL="postgresql://admin:password@host:port/database"
export GCP_PROJECT="shorted-dev-aba5688f"
export GCP_REGION="asia-northeast1"
```

### Deploy to Cloud Run

```bash
# Make deploy script executable
chmod +x deploy.sh

# Deploy the job
./deploy.sh
```

This will:
1. ✅ Build Docker image
2. ✅ Push to Google Container Registry
3. ✅ Create Cloud Run Job
4. ✅ Set up Cloud Scheduler (2 AM AEST daily)

## 📊 Manual Execution

### Run Locally

```bash
# Install dependencies
pip install -r requirements.txt

# Set database URL
export DATABASE_URL="postgresql://..."

# Run sync
python comprehensive_daily_sync.py
```

### Run in Cloud

```bash
# Execute the Cloud Run Job immediately
gcloud run jobs execute comprehensive-daily-sync \
    --region asia-northeast1 \
    --project shorted-dev-aba5688f

# View execution status
gcloud run jobs executions list \
    --job comprehensive-daily-sync \
    --region asia-northeast1 \
    --project shorted-dev-aba5688f
```

## 📋 View Logs

```bash
# Recent job logs
gcloud logging read \
    "resource.type=cloud_run_job AND resource.labels.job_name=comprehensive-daily-sync" \
    --limit 100 \
    --project shorted-dev-aba5688f \
    --format="table(timestamp, severity, textPayload)"

# Follow logs in real-time (during execution)
gcloud logging tail \
    "resource.type=cloud_run_job AND resource.labels.job_name=comprehensive-daily-sync" \
    --project shorted-dev-aba5688f
```

## ⏰ Schedule Management

```bash
# View scheduler details
gcloud scheduler jobs describe comprehensive-daily-sync-trigger \
    --location asia-northeast1 \
    --project shorted-dev-aba5688f

# Pause scheduler
gcloud scheduler jobs pause comprehensive-daily-sync-trigger \
    --location asia-northeast1 \
    --project shorted-dev-aba5688f

# Resume scheduler
gcloud scheduler jobs resume comprehensive-daily-sync-trigger \
    --location asia-northeast1 \
    --project shorted-dev-aba5688f

# Update schedule (e.g., change to 3 AM)
gcloud scheduler jobs update http comprehensive-daily-sync-trigger \
    --location asia-northeast1 \
    --schedule "0 3 * * *" \
    --project shorted-dev-aba5688f
```

## 🔧 Configuration

Environment variables:

| Variable | Default | Description |
|----------|---------|-------------|
| `DATABASE_URL` | *required* | PostgreSQL connection string |
| `SYNC_DAYS_STOCK_PRICES` | `5` | Days of stock price data to sync |
| `SYNC_DAYS_SHORTS` | `7` | Days of shorts data to sync |

## 📊 Expected Output

```
🚀 COMPREHENSIVE DAILY SYNC - STARTING
============================================================
⏰ Started at: 2025-11-13
📊 Shorts sync: Last 7 days
💰 Stock prices sync: Last 5 days
============================================================

============================================================
📊 UPDATING SHORTS DATA
============================================================
📥 Fetching list of ASIC shorts files (last 7 days)...
📊 Found 7 recent shorts data files
[1/7] Processing RR20251107-001-SSDailyAggShortPos.csv
  ✅ Inserted/Updated 1234 records
...

✅ Shorts update complete: 8,642 total records updated

============================================================
💰 UPDATING STOCK PRICES
============================================================
📋 Found 107 stocks with existing price data
🔄 Updating 107 stocks with last 5 days of data
[  1/107] CBA... ✅ 5 records
[  2/107] BHP... ✅ 5 records
...

✅ Stock prices update complete:
   Successful: 87
   Failed: 20
   Total records: 435

============================================================
🎉 SYNC COMPLETE
============================================================
📊 Shorts records updated: 8,642
💰 Price records updated: 435
⏱️  Duration: 127.3 seconds
============================================================
```

## 🔍 Monitoring

### Check Last Execution

```bash
# View last 5 executions
gcloud run jobs executions list \
    --job comprehensive-daily-sync \
    --region asia-northeast1 \
    --project shorted-dev-aba5688f \
    --limit 5
```

### Database Verification

```sql
-- Check latest shorts data
SELECT MAX("DATE") as latest_shorts_date FROM shorts;

-- Check latest stock prices
SELECT MAX(date) as latest_price_date FROM stock_prices;

-- Verify recent updates
SELECT 
    stock_code,
    MAX(updated_at) as last_update
FROM stock_prices
WHERE updated_at > CURRENT_TIMESTAMP - INTERVAL '1 day'
GROUP BY stock_code
ORDER BY last_update DESC
LIMIT 10;
```

## 🆘 Troubleshooting

### Job Fails

```bash
# Check error logs
gcloud logging read \
    "resource.type=cloud_run_job AND severity>=ERROR" \
    --limit 50 \
    --project shorted-dev-aba5688f

# Check job configuration
gcloud run jobs describe comprehensive-daily-sync \
    --region asia-northeast1 \
    --project shorted-dev-aba5688f
```

### Database Connection Issues

1. Verify `DATABASE_URL` is correct
2. Check database is accessible from Cloud Run
3. Verify database credentials haven't expired

### No Data Updated

- Check if ASIC website is accessible
- Verify Yahoo Finance API is working
- Check rate limiting (0.3s delay between requests)

## 🔄 Updating the Job

After making code changes:

```bash
# Redeploy
./deploy.sh

# The scheduler will automatically use the new version
```

## 📈 Cost Optimization

- Job runs for ~2-3 minutes daily
- Memory: 2GB
- CPU: 1
- Estimated cost: ~$0.10/month

To reduce costs:
- Reduce memory to 1GB if stable
- Reduce `SYNC_DAYS_*` values if less historical data needed

