# Historical Market Data Syncer Status

## 🔍 Current Status

### ❌ **NOT DEPLOYED**: `daily-historical-sync` Job

The dedicated historical market data syncer (`services/market-data/daily_historical_sync.py`) is **not currently deployed** as a Cloud Run job.

**Expected Job Name**: `daily-historical-sync`  
**Expected Region**: `asia-northeast1`  
**Status**: ❌ Not found in Cloud Run Jobs

---

## 📊 What We Have Instead

### ✅ **DEPLOYED**: `comprehensive-daily-sync` Job

There IS a deployed daily sync job called `comprehensive-daily-sync` that handles:

1. **Shorts data** (last 7 days from ASIC)
2. **Stock prices** (last 5 days for stocks that already have data)

**Location**: `services/daily-sync/comprehensive_daily_sync.py`  
**Job Name**: `comprehensive-daily-sync`  
**Schedule**: Daily at 2 AM AEST

### ⚠️ **Key Difference**

| Feature             | `comprehensive-daily-sync`           | `daily-historical-sync`          |
| ------------------- | ------------------------------------ | -------------------------------- |
| **Stocks Synced**   | Only stocks with existing price data | ALL ASX stocks from company list |
| **Stock Discovery** | Queries `stock_prices` table         | Reads ASX company list CSV       |
| **Purpose**         | Incremental updates                  | Full coverage + incremental      |
| **Deployment**      | ✅ Deployed                          | ❌ Not deployed                  |

---

## 🎯 What This Means

The `comprehensive-daily-sync` job **does sync stock prices**, but it only updates stocks that already have data in the database. It won't discover and add new stocks.

The `daily-historical-sync` job would:

- ✅ Load ALL ASX stocks from the official company list
- ✅ Sync the last 5 days for ALL stocks (not just existing ones)
- ✅ Discover new stocks automatically

---

## 🔧 To Deploy the Historical Syncer

If you want the dedicated historical market data syncer deployed:

```bash
cd services/market-data
export DATABASE_URL="your-database-url"
make deploy-daily-sync
# OR
./deploy-daily-sync.sh
```

This will:

1. Build Docker image from `Dockerfile.daily-sync`
2. Deploy as Cloud Run Job: `daily-historical-sync`
3. Set up Cloud Scheduler (daily at 2 AM AEST)

---

## 📋 Check Current Sync Status

### Check if `comprehensive-daily-sync` is working:

```bash
# Check scheduler status
make daily-sync-status

# View recent logs (requires permissions)
make daily-sync-logs

# Execute manually to test
make daily-sync-execute
```

### Check database for recent updates:

```sql
-- Check when stock prices were last updated
SELECT
    stock_code,
    MAX(date) as last_price_date,
    MAX(updated_at) as last_updated
FROM stock_prices
GROUP BY stock_code
ORDER BY last_updated DESC
LIMIT 20;

-- Check how many stocks have recent data (last 7 days)
SELECT COUNT(DISTINCT stock_code) as stocks_with_recent_data
FROM stock_prices
WHERE date >= CURRENT_DATE - INTERVAL '7 days';
```

---

## 🚨 Permission Issues

I encountered permission errors when trying to check:

- Cloud Run Jobs list
- Cloud Scheduler jobs
- Cloud Logging

**To check yourself**, you'll need:

- `run.jobs.list` permission
- `cloudscheduler.jobs.list` permission
- `logging.logEntries.list` permission

Or check via the GCP Console:

- Cloud Run Jobs: https://console.cloud.google.com/run/jobs
- Cloud Scheduler: https://console.cloud.google.com/cloudscheduler
- Cloud Logging: https://console.cloud.google.com/logs

---

## 💡 Recommendation

1. **Check if `comprehensive-daily-sync` is working**:

   - Verify it's running daily
   - Check logs for stock price updates
   - Confirm it's updating existing stocks

2. **If you need ALL ASX stocks covered**:

   - Deploy `daily-historical-sync` job
   - It will discover and sync all stocks from the ASX company list
   - Can run alongside `comprehensive-daily-sync` (they won't conflict)

3. **Monitor both**:
   - `comprehensive-daily-sync`: Updates existing stocks + shorts
   - `daily-historical-sync`: Discovers and syncs ALL stocks

---

## 📝 Files

- **Historical Syncer**: `services/market-data/daily_historical_sync.py`
- **Deployment Script**: `services/market-data/deploy-daily-sync.sh`
- **Dockerfile**: `services/market-data/Dockerfile.daily-sync`
- **Comprehensive Syncer**: `services/daily-sync/comprehensive_daily_sync.py`
