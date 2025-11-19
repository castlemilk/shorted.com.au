# Intelligent Daily Sync System 🔄

## Overview

The daily sync system intelligently updates both shorts data and stock prices by **detecting the last ingested date** for each dataset and only fetching **missing data from that point forward**. This prevents gaps, reduces API calls, and ensures efficient daily updates.

## Key Features

### 1️⃣ **Intelligent Date Detection**
- ✅ Queries database for last ingested date per stock
- ✅ Only fetches data from that date → today
- ✅ Skips stocks already up-to-date
- ✅ Prevents gaps and duplicates

### 2️⃣ **Dual-Provider Strategy**
- 🥇 **Primary**: Alpha Vantage (reliable, stable)
- 🥈 **Fallback**: Yahoo Finance (when Alpha fails)
- ✅ Automatic failover if provider is down
- ✅ Handles ASX symbol formats correctly

### 3️⃣ **Automated Scheduling**
- ⏰ Runs daily at **2 AM AEST** via Cloud Scheduler
- ☁️  Deployed as Google Cloud Run Job
- 🔄 Automatic retries on failure (max 2)
- ⏱️  1-hour timeout

## How It Works

### Shorts Data Sync

```
┌─────────────────────────────────────────────────┐
│ 1. Query: SELECT MAX("DATE") FROM shorts        │
│    → Last date: 2025-11-07                       │
├─────────────────────────────────────────────────┤
│ 2. Fetch ASIC files from 2025-11-08 → today     │
├─────────────────────────────────────────────────┤
│ 3. Insert/Update records (upsert)               │
│    → Handles duplicates gracefully               │
└─────────────────────────────────────────────────┘
```

### Stock Price Sync

```
For each stock:
┌─────────────────────────────────────────────────┐
│ 1. Query: SELECT MAX(date) WHERE stock='CBA'    │
│    → Last date: 2025-11-10                       │
├─────────────────────────────────────────────────┤
│ 2. Calculate: days_to_fetch = today - 2025-11-10│
│    → Need 3 days of data                         │
├─────────────────────────────────────────────────┤
│ 3. Try Alpha Vantage (symbol='CBA', days=3)     │
│    │                                              │
│    ├─ Success → Insert & rate limit sleep        │
│    │                                              │
│    └─ Failure → Try Yahoo Finance fallback       │
│        (symbol='CBA.AX', days=3)                 │
└─────────────────────────────────────────────────┘
```

## Configuration

### Environment Variables

```bash
# Required
DATABASE_URL="postgresql://user:pass@host:port/database"

# Recommended (enables dual-provider)
ALPHA_VANTAGE_API_KEY="your-api-key"

# Optional (defaults shown)
SYNC_DAYS_STOCK_PRICES=5     # Default lookback if no data
SYNC_DAYS_SHORTS=7            # Default lookback if no data
```

### Rate Limits

- **Alpha Vantage**: 5 calls/min → 12 sec delay
- **Yahoo Finance**: ~10 calls/sec → 0.3 sec delay

## Example Output

```
============================================================
📊 UPDATING SHORTS DATA
============================================================
   Last ingested shorts date: 2025-11-07
📥 Fetching ASIC shorts files from 2025-11-08 onwards...
📊 Found 3 shorts data files to process
[1/3] Processing RR20251108-001-SSDailyAggShortPos.csv
  ✅ Inserted/Updated 2,847 records
[2/3] Processing RR20251111-001-SSDailyAggShortPos.csv
  ✅ Inserted/Updated 2,851 records
[3/3] Processing RR20251112-001-SSDailyAggShortPos.csv
  ✅ Inserted/Updated 2,849 records

✅ Shorts update complete: 8,547 total records updated

============================================================
💰 UPDATING STOCK PRICES
============================================================
🔑 Alpha Vantage API key found - using as primary source
📊 Yahoo Finance enabled as fallback
📋 Found 247 stocks with existing price data
🔄 Updating 247 stocks (from last ingested date to today)

[  1/247] CBA: ✅ 3 records (Alpha Vantage, from 2025-11-10)
[  2/247] BHP: ✓ Already up to date (last: 2025-11-13)
[  3/247] WBC: ✅ 5 records (Yahoo Finance, from 2025-11-08)
[  4/247] ANZ: ⚠️  No data from any source (last: 2025-11-07)
...

✅ Stock prices update complete:
   Alpha Vantage: 189
   Yahoo Finance: 52
   Already up-to-date: 3
   Failed: 3
   Total records inserted: 1,247
```

## Daily Schedule

| Time | Task | Description |
|------|------|-------------|
| 2:00 AM AEST | Sync Triggered | Cloud Scheduler starts job |
| 2:00 AM | Shorts Data | Fetch last 7 days from ASIC |
| 2:01 AM | Stock Prices | Update 247 stocks (~45 min) |
| 2:45 AM | Complete | Job finishes, logs available |

## Local Testing

```bash
# Test with intelligent sync
cd /Users/benebsworth/projects/shorted
export DATABASE_URL="postgresql://admin:password@localhost:5438/shorts"
export ALPHA_VANTAGE_API_KEY="your-key"
make daily-sync-local

# Check what will be synced (dry-run style)
cd services/daily-sync
python3 -c "
import asyncio
from comprehensive_daily_sync import get_last_shorts_date, get_last_ingested_date
import asyncpg

async def check():
    conn = await asyncpg.connect('$DATABASE_URL')
    last_shorts = await get_last_shorts_date(conn)
    print(f'Shorts: will sync from {last_shorts} onwards')
    
    stocks = await conn.fetch('SELECT DISTINCT stock_code FROM stock_prices LIMIT 5')
    for row in stocks:
        last_date = await get_last_ingested_date(conn, row['stock_code'])
        print(f'{row[\"stock_code\"]}: will sync from {last_date} onwards')
    await conn.close()

asyncio.run(check())
"
```

## Deployment

```bash
# Deploy to Cloud Run with scheduling
cd /Users/benebsworth/projects/shorted
export DATABASE_URL="postgresql://..."
export ALPHA_VANTAGE_API_KEY="..."
make daily-sync-deploy

# Manual execution (for testing)
make daily-sync-execute

# View logs
make daily-sync-logs

# Check status
make daily-sync-status
```

## Benefits

### Before (Blind Sync)
- ❌ Always fetches last N days (wasteful)
- ❌ Re-fetches existing data
- ❌ Potential gaps if job skipped
- ❌ No skip for up-to-date stocks

### After (Intelligent Sync)
- ✅ Only fetches missing data
- ✅ Efficient API usage
- ✅ Fills gaps automatically
- ✅ Skips current stocks
- ✅ Clear logging of what's synced

## Monitoring

### Success Indicators
- ✅ "Already up-to-date" count > 0 (after first run)
- ✅ Total records matches expected gaps
- ✅ No "Failed" stocks (or very few)

### Warning Signs
- ⚠️  All stocks "No data from any source"
- ⚠️  "Failed" count > 10%
- ⚠️  Job timeout (>1 hour)

### Logs
```bash
# View recent job logs
gcloud logging read \
  "resource.type=cloud_run_job AND resource.labels.job_name=comprehensive-daily-sync" \
  --limit 100 \
  --project shorted-dev-aba5688f

# View scheduler execution
gcloud scheduler jobs describe comprehensive-daily-sync-trigger \
  --location asia-northeast1 \
  --project shorted-dev-aba5688f
```

## Database Schema Requirements

### Shorts Table
```sql
-- Must have DATE column with index
CREATE INDEX IF NOT EXISTS idx_shorts_date ON shorts("DATE");
```

### Stock Prices Table
```sql
-- Must have composite unique constraint
ALTER TABLE stock_prices 
  ADD CONSTRAINT stock_prices_unique 
  UNIQUE (stock_code, date);

-- Recommended indexes
CREATE INDEX IF NOT EXISTS idx_stock_prices_date 
  ON stock_prices(date);
CREATE INDEX IF NOT EXISTS idx_stock_prices_stock_code 
  ON stock_prices(stock_code);
```

## Troubleshooting

### Problem: "No data from any source"
- **Cause**: Both Alpha Vantage and Yahoo Finance down
- **Fix**: Check API status, verify API key, wait and retry

### Problem: ".AX.AX" in errors
- **Cause**: Stock codes in DB already have .AX suffix
- **Fix**: Already fixed in v1.1+ (handles both formats)

### Problem: "Already up to date" for all stocks
- **Cause**: Scheduler running multiple times, or data already current
- **Fix**: Expected behavior! Job is smart enough to skip

### Problem: Job timeout
- **Cause**: Too many stocks or slow API responses
- **Fix**: Increase timeout in deploy.sh or reduce stock count

## Next Steps

1. ✅ **Deployed**: Job scheduled for 2 AM AEST daily
2. ⏳ **Wait**: First automated run tonight
3. 📊 **Monitor**: Check logs tomorrow morning
4. 🎯 **Optimize**: Adjust rate limits if needed

---

**Version**: 1.1 (Intelligent Sync)  
**Last Updated**: November 13, 2025  
**Deployment**: Google Cloud Run (asia-northeast1)  
**Schedule**: Daily at 2:00 AM AEST

