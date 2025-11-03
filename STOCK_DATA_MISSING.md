# Stock Price Data Missing - Investigation Summary

## Issue

Users are seeing errors when viewing stocks that don't have historical price data, particularly BOE.

## Root Cause Analysis

### Database State

- **Total stocks with short data**: 3,840
- **Total stocks with price data**: 101
- **Stocks missing price data**: 3,739 (97.4%)

**BOE Status:**

- ✅ Has short position data (1,192 records)
- ❌ Has NO price data (0 records)

### Current Price Data

Only 101 stocks have price data, including:

- RMX (505 records, 2023-11-03 to 2025-10-31)
- Major stocks like WOW, NAB, WBC, RIO, etc. (261 records, 2024-08-05 to 2025-08-04)

## Solutions Implemented

### 1. Improved Error Handling ✅

Updated `/web/src/@/lib/stock-data-service.ts` to handle missing data gracefully:

**Before:**

- Threw errors loudly when data was missing
- Console errors confused users
- Failed to fetch data would break the UI

**After:**

- Returns empty arrays/maps when data is unavailable
- Uses `console.warn()` instead of `console.error()` for missing data
- Graceful degradation - UI shows "No data available" instead of breaking
- Better user experience when stock data is incomplete

### 2. Data Population Required ⚠️

To fix the missing BOE data (and 3,738 other stocks), you need to populate the database:

#### Quick Test (10 stocks, 1 year)

```bash
cd services
make history.stock-data.backfill-test
```

#### Standard Backfill (All stocks, 2 years) - Recommended

```bash
cd services
make history.stock-data.backfill
```

#### Optimized Backfill (Faster with caching)

```bash
cd services
make history.stock-data.backfill-optimized
```

#### Full Backfill (All stocks, 5 years)

```bash
cd services
make history.stock-data.backfill-full
```

#### Check Status

```bash
cd services
make history.stock-data.status
```

## What This Fixes

### User Experience

- ✅ No more loud console errors
- ✅ Graceful handling of missing data
- ✅ Better warning messages
- ✅ UI doesn't break when stock has no data

### Developer Experience

- ✅ Clear warnings in console (not errors)
- ✅ Easy to identify which stocks are missing data
- ✅ Better debugging information

## Production Automated Job Status

### ✅ **YES - The async job DOES update the production database**

**Production has automated Cloud Scheduler jobs configured:**

- **Daily Sync**: Runs weekdays at 6 PM AEST (8 AM UTC) after market close
  - Cron: `0 8 * * 1-5` (Monday-Friday)
  - Syncs yesterday's data for **all ASX stocks**
  - Automatically skips weekends
- **Weekly Backfill**: Runs Sundays at 8 PM AEST (10 AM UTC)
  - Cron: `0 10 * * 0` (Sunday)
  - Comprehensive 7-day backfill to catch any missed data

**Architecture:**

```
Cloud Scheduler → Cloud Run Service → Yahoo Finance API
                        ↓
                  Production PostgreSQL
```

**Service:**

- Name: `stock-price-ingestion`
- Region: `australia-southeast2`
- Project: `shorted-dev-aba5688f`
- Health: `/health`
- Sync endpoint: `/sync-all` (called by scheduler)

### Check Production Status

```bash
# List scheduler jobs
gcloud scheduler jobs list --location=australia-southeast1 --project=shorted-dev-aba5688f

# View recent logs
gcloud logging read 'resource.type="cloud_run_revision" AND resource.labels.service_name="stock-price-ingestion"' \
  --limit=50 --project=shorted-dev-aba5688f

# Manually trigger daily sync
gcloud scheduler jobs run stock-price-daily-sync \
  --location=australia-southeast1 --project=shorted-dev-aba5688f
```

### Why Local Database is Missing Data

Your **local database** is separate from production and needs to be backfilled manually. The Cloud Scheduler jobs only run against the production database.

## Next Steps

### 1. For Local Development

Run the backfill command to populate your local database:

```bash
make dev-db  # Ensure database is running
cd services
make history.stock-data.backfill  # Populate data (2 years, all stocks)
```

### 2. For Production

The automated jobs should be handling it. To verify:

```bash
# Check if service is deployed
gcloud run services describe stock-price-ingestion \
  --region=australia-southeast2 \
  --project=shorted-dev-aba5688f

# Redeploy if needed
cd services/stock-price-ingestion
make deploy
```

### 3. Monitor Data Completeness

Check which stocks are missing data:

```bash
# Local database
psql "postgresql://admin:password@localhost:5438/shorts" -c "
SELECT COUNT(DISTINCT \"PRODUCT_CODE\")
FROM shorts
WHERE \"PRODUCT_CODE\" NOT IN (
  SELECT DISTINCT stock_code FROM stock_prices
);"

# Production database (if you have access)
psql "$PRODUCTION_DATABASE_URL" -c "
SELECT
  COUNT(DISTINCT s.\"PRODUCT_CODE\") as total_stocks,
  COUNT(DISTINCT p.stock_code) as stocks_with_prices,
  COUNT(DISTINCT s.\"PRODUCT_CODE\") - COUNT(DISTINCT p.stock_code) as missing_prices
FROM shorts s
LEFT JOIN stock_prices p ON s.\"PRODUCT_CODE\" = p.stock_code;"
```

## Files Changed

### Frontend

- `web/src/@/lib/stock-data-service.ts` - Improved error handling for missing data
- `web/src/@/components/ui/sidebar.tsx` - Removed unnecessary "Navigation" header and "Home" link

### Backend - Pluggable Provider System

- `services/stock-price-ingestion/main.py` - Updated to use pluggable providers with automatic fallback
- `services/stock-price-ingestion/data_providers/*.py` - New pluggable provider architecture
  - `base.py` - Base provider interface
  - `factory.py` - Provider factory pattern
  - `alpha_vantage.py` - Alpha Vantage provider (primary)
  - `yahoo_finance.py` - Yahoo Finance provider (fallback)
- `services/stock-price-ingestion/service.template.yaml` - Added Alpha Vantage API key configuration

See `PLUGGABLE_PROVIDERS_IMPLEMENTED.md` for detailed documentation on the new provider system.

## Related Commands

### Start Local Development

```bash
make dev  # Starts database + frontend + backend
```

### Check Database Status

```bash
cd services
make history.stock-data.status
```

### Populate Short Position Data (if needed)

```bash
make populate-data-quick
```
