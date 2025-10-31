# Populate Historical Price Database

## Quick Start

```bash
cd services/market-data
export DATABASE_URL="postgresql://postgres.xivfykscsdagwsreyqgf:661wMKAq9zdZpDk2@aws-0-ap-southeast-2.pooler.supabase.com:5432/postgres"
make populate-all-stocks
```

This will:
- Load 10 years of price data for ALL 2,291 ASX stocks
- Take 30-60 minutes
- Insert ~2.8M price records into `stock_prices` table

## What Happens After

Once the database is populated, the **Historical Price Data** chart on `/shorts/[stockCode]` pages will work automatically:

### Before (Current State)
```
/shorts/RMX page:
├── Short Position Trends ✅ Working (has shorts table data)
└── Historical Price Data ❌ Empty (no stock_prices table data)
```

### After Population
```
/shorts/RMX page:
├── Short Position Trends ✅ Working
└── Historical Price Data ✅ Working (10 years of price charts!)
```

## Architecture Flow

```
User visits /shorts/RMX
    ↓
<MarketChart stockCode="RMX">
    ↓
useMarketData("RMX", "5y")
    ↓
getHistoricalData("RMX", "5y")
    ↓
fetch(MARKET_DATA_API_URL + "/GetHistoricalPrices")
    ↓
Market Data Service (Go - Port 8090)
    ↓
SELECT * FROM stock_prices WHERE stock_code = 'RMX' AND date >= ...
    ↓
Returns price data → Chart renders ✅
```

## Current Status

| Component | Status | Notes |
|-----------|--------|-------|
| MarketChart component | ✅ Working | Renders charts from data |
| useMarketData hook | ✅ Working | Fetches data from API |
| getHistoricalData | ✅ Working | Calls market-data service |
| Market Data Service | ✅ Deployed | Go service on port 8090 |
| NEXT_PUBLIC_MARKET_DATA_API_URL | ✅ Set | CI/CD configures it |
| stock_prices table | ❌ **EMPTY** | **NEEDS POPULATION** |

## Verification

### 1. Check if data exists
```sql
SELECT 
  COUNT(*) as total_records,
  COUNT(DISTINCT stock_code) as unique_stocks,
  MIN(date) as earliest,
  MAX(date) as latest
FROM stock_prices;
```

Expected after population:
- `total_records`: ~2,800,000
- `unique_stocks`: ~2,291
- `earliest`: ~2015-10-31
- `latest`: ~2025-10-31

### 2. Check specific stock
```sql
SELECT COUNT(*), MIN(date), MAX(date)
FROM stock_prices
WHERE stock_code = 'RMX';
```

Expected: ~2,500 records (10 years of daily data)

### 3. Test API directly
```bash
curl -X POST https://market-data-service-pr-XX.run.app/marketdata.v1.MarketDataService/GetHistoricalPrices \
  -H "Content-Type: application/json" \
  -d '{"stockCode":"RMX","period":"1y"}' | jq '.prices | length'
```

Expected: ~250 records (1 year of daily data)

## Monitoring Progress

The population script outputs progress:

```
🚀 POPULATE HISTORICAL PRICE DATA FOR ALL ASX STOCKS
======================================================================
📊 Loaded 2291 ASX stocks from ASX_Listed_Companies_07-04-2024_11-03-45_AEST.csv
🎯 Target: 2291 ASX stocks

[   1/2291] RMX
  📈 Fetching 10 years of RMX data...
  ✅ Fetched 2543 records (10 years)
  💾 Inserted 2,543 records into database

[   2/2291] CBA
  📈 Fetching 10 years of CBA data...
  ✅ Fetched 2587 records (10 years)
  💾 Inserted 2,587 records into database

...

📊 Progress: 50/2291 (2.2%)
⏱️  Rate: 1.2 stocks/sec | ETA: 31.2 min

...

======================================================================
📊 POPULATION COMPLETE
======================================================================
⏱️  Duration: 1847.3 seconds (30.8 minutes)
✅ Successful: 2100
⏭️  Skipped: 120
❌ Failed: 71
➕ Total records inserted: 2,834,567
======================================================================
```

## Troubleshooting

### "No market data available for RMX"

This means:
1. Either the `stock_prices` table is empty
2. Or the market-data service can't connect to the database

**Fix**: Run the population script above

### "Market data service not available"

This means the frontend can't reach the market-data service.

**Check**:
```bash
# Get the service URL from CI/CD output
echo $NEXT_PUBLIC_MARKET_DATA_API_URL

# Test health endpoint
curl https://market-data-service-pr-XX.run.app/health
```

**Fix**: Ensure the market-data service is deployed (CI/CD does this automatically)

### Population taking too long

The script is rate-limited to avoid hitting Yahoo Finance API limits:
- 0.5 second delay between stocks
- ~2 stocks/second
- 2,291 stocks = ~20 minutes minimum

If you want faster (risky):
```python
# In daily_historical_sync.py, change:
RATE_LIMIT_DELAY = 0.3  # Change to 0.1 for faster (may hit rate limits)
```

## After Population

### Set up daily sync
Once initial population is complete, deploy the daily sync job:

```bash
cd services/market-data
export DATABASE_URL="..."
make deploy-daily-sync
```

This will:
- Run daily at 2 AM AEST
- Update the last 5 days of data
- Keep all stocks current with minimal load

### Test the charts
Visit any stock page:
- https://preview.shorted.com.au/shorts/RMX
- https://preview.shorted.com.au/shorts/CBA
- https://preview.shorted.com.au/shorts/BHP

Both charts should now work! 🎉

## Files Reference

```
services/market-data/
├── populate_all_asx_from_csv.py  ← Run this to populate
├── daily_historical_sync.py       ← Deploy this for daily updates
├── main.go                        ← Market data service (already deployed)
└── Dockerfile                     ← Container (fixed and working)

web/src/
├── app/shorts/[stockCode]/page.tsx     ← Stock detail page
├── @/components/ui/market-chart.tsx    ← Price chart component
├── @/hooks/use-market-data.ts          ← Data fetching hook
└── @/lib/stock-data-service.ts         ← API client
```

---

**Next Step**: Run the population script! 🚀

