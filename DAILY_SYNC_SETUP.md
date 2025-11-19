# 🔄 Daily Sync Setup - Complete Guide

Automated daily updates for shorts data and stock prices.

## 📋 What Was Created

### 1. **Comprehensive Daily Sync Service**
   - Location: `services/daily-sync/`
   - Updates **both** shorts and stock prices in one job
   - Runs daily at **2 AM AEST**

### 2. **What It Updates Daily**

| Data Type | Source | Days Synced | Records |
|-----------|--------|-------------|---------|
| **Shorts Positions** | ASIC | Last 7 days | ~8,000-10,000/day |
| **Stock Prices** | Alpha Vantage + Yahoo Finance* | Last 5 days | ~500-600/day |

\* Alpha Vantage as primary source, Yahoo Finance as fallback (requires free API key for best results)

## 🚀 Quick Start

### Option 1: Deploy to Cloud Run (Recommended for Production)

```bash
# Set your database URL (use production database)
export DATABASE_URL="postgresql://user:pass@host:port/database"

# OPTIONAL: Set Alpha Vantage API key for better reliability
# Get free API key: https://www.alphavantage.co/support/#api-key
export ALPHA_VANTAGE_API_KEY="your_api_key_here"

# Deploy the job (runs daily at 2 AM AEST automatically)
make daily-sync-deploy
```

That's it! The job will now run automatically every day at 2 AM AEST.

**Note:** Alpha Vantage API key is optional but recommended. Without it, the system uses Yahoo Finance only (still works, but less reliable).

### Option 2: Run Locally (for testing)

```bash
# Run manual sync now
make daily-sync-local
```

## 📊 Verify It Works

### Check the scheduler was created:
```bash
make daily-sync-status
```

### Trigger it manually (test execution):
```bash
make daily-sync-execute
```

### View logs:
```bash
make daily-sync-logs
```

## 🎯 What You Get

After deployment, your system will automatically:

✅ **Every day at 2 AM AEST:**
1. Download latest shorts data from ASIC
2. Update shorts table with last 7 days
3. Fetch latest stock prices from Yahoo Finance  
4. Update stock_prices table for all 107 stocks
5. Complete in ~2-3 minutes

✅ **Your application always has:**
- Up-to-date short position data
- Current stock prices for charts/sparklines
- No manual intervention needed

## 📈 Expected Daily Updates

### Shorts Data
- **Files processed**: 2-7 per day (ASIC publishes 1-2 files daily, we sync last 7 days for safety)
- **Records**: ~1,200 per file × 2 files = ~2,400 records/day
- **Covers**: All ~878 actively traded ASX stocks

### Stock Prices
- **Stocks updated**: 107 stocks with existing data
- **Days per stock**: 5 (with overlap for reliability)
- **Records**: ~500-600 price records/day
- **Success rate**: ~80-85% (some stocks fail due to Yahoo Finance limitations)

## 🔍 Monitoring

### Daily Health Check

```sql
-- Check if data is current
SELECT 
    'Shorts' as data_type,
    MAX("DATE") as latest_date,
    CURRENT_DATE - MAX("DATE")::date as days_old
FROM shorts
UNION ALL
SELECT 
    'Stock Prices' as data_type,
    MAX(date) as latest_date,
    CURRENT_DATE - MAX(date) as days_old
FROM stock_prices;
```

**Expected output:**
- Shorts: 0-1 days old (ASIC updates at 10 AM AEST)
- Stock Prices: 0-2 days old (markets closed weekends)

### Check Recent Syncs

```bash
# View last 5 sync executions
gcloud run jobs executions list \
    --job comprehensive-daily-sync \
    --region asia-northeast1 \
    --limit 5
```

### View Logs

```bash
# Recent logs
make daily-sync-logs

# Or detailed logs with timestamps
gcloud logging read \
    "resource.type=cloud_run_job AND resource.labels.job_name=comprehensive-daily-sync" \
    --limit 200 \
    --project shorted-dev-aba5688f \
    --format="table(timestamp, severity, textPayload)"
```

## 🛠️ Management Commands

All commands are in the root `Makefile`:

| Command | Description |
|---------|-------------|
| `make daily-sync-deploy` | Deploy/update the sync job to Cloud Run |
| `make daily-sync-execute` | Run sync immediately (manual trigger) |
| `make daily-sync-status` | Check scheduler configuration |
| `make daily-sync-logs` | View recent sync logs |
| `make daily-sync-local` | Run sync locally for testing |

## ⚙️ Configuration

### Environment Variables

Set in Cloud Run Job (automatically configured by deploy script):

| Variable | Default | Description |
|----------|---------|-------------|
| `DATABASE_URL` | *required* | PostgreSQL connection string |
| `ALPHA_VANTAGE_API_KEY` | *optional* | Alpha Vantage API key for better reliability |
| `SYNC_DAYS_SHORTS` | `7` | How many days of shorts data to sync |
| `SYNC_DAYS_STOCK_PRICES` | `5` | How many days of stock prices to sync |

**Getting Alpha Vantage API Key (Recommended):**
- Visit: https://www.alphavantage.co/support/#api-key
- Free tier: 500 requests/day (sufficient for daily sync)

### Modify Schedule

To change from 2 AM to a different time:

```bash
# Update schedule to 3 AM AEST
gcloud scheduler jobs update http comprehensive-daily-sync-trigger \
    --location asia-northeast1 \
    --schedule "0 3 * * *" \
    --project shorted-dev-aba5688f
```

Common schedules:
- `0 2 * * *` - 2 AM daily
- `0 */6 * * *` - Every 6 hours
- `0 8 * * 1-5` - 8 AM weekdays only

## 🔧 Troubleshooting

### Sync Failed

**Check logs:**
```bash
make daily-sync-logs
```

**Common issues:**
1. **Database connection failed**
   - Verify DATABASE_URL is correct
   - Check database is accessible from Cloud Run
   - Verify credentials haven't expired

2. **ASIC website unavailable**
   - Check https://download.asic.gov.au/short-selling/
   - Retry later (site sometimes has maintenance)

3. **Yahoo Finance rate limiting**
   - Reduce `SYNC_DAYS_STOCK_PRICES` to 3
   - Script has built-in rate limiting (0.3s delay)

### No New Data

**Shorts data:**
- ASIC publishes at ~10 AM AEST
- If sync runs at 2 AM, it may get previous day's data
- This is fine - next day's sync will catch up

**Stock prices:**
- Markets closed on weekends
- Public holidays affect data availability
- Yahoo Finance sometimes has delays

### Update Failed Stocks

If certain stocks consistently fail, you can:

1. **Check which stocks failed:**
```sql
SELECT stock_code, MAX(date) as last_update
FROM stock_prices
GROUP BY stock_code
HAVING MAX(date) < CURRENT_DATE - INTERVAL '5 days'
ORDER BY last_update;
```

2. **Manually update specific stocks:**
```python
# Run the populate script for specific stocks
cd services/market-data
python3 populate_specific_stocks.py --stocks CBA,BHP,WBC
```

## 💰 Cost Estimate

**Cloud Run Job Pricing:**
- Runs: 2-3 minutes daily
- Memory: 2GB
- CPU: 1 vCPU
- Executions: 30/month

**Estimated monthly cost: ~$0.10 - $0.30**

Costs are minimal because:
- Job only runs when needed (not idle)
- Completes quickly (2-3 mins)
- No persistent resources

## 📦 Files Created

```
services/daily-sync/
├── comprehensive_daily_sync.py  # Main sync script
├── Dockerfile                   # Container definition
├── requirements.txt            # Python dependencies
├── deploy.sh                   # Deployment script
└── README.md                   # Detailed documentation

Makefile (updated)              # Added daily-sync-* commands
DAILY_SYNC_SETUP.md (this file) # Setup guide
```

## ✅ Success Indicators

Your daily sync is working correctly if:

1. **Scheduler shows as ENABLED:**
   ```bash
   make daily-sync-status
   ```

2. **Recent executions succeeded:**
   ```bash
   gcloud run jobs executions list --job comprehensive-daily-sync --limit 5
   ```

3. **Database has current data:**
   - Shorts: Updated within last 2 days
   - Stock prices: Updated within last 3 days (accounting for weekends)

4. **Application shows current data:**
   - Top shorts list shows recent percentages
   - Stock price charts display up to current week
   - Sparklines show recent trends

## 🎉 You're All Set!

Your daily sync system is now configured and will run automatically. The application will always have fresh data without any manual intervention.

**Next steps:**
1. Run a test execution to verify: `make daily-sync-execute`
2. Check logs to confirm success: `make daily-sync-logs`
3. Verify data is updated in your database
4. Relax - it's automated now! 😎

