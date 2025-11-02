# Stock Data Sync Investigation & Fix Summary

**Date:** November 1, 2025  
**Issue:** RMX has no historical data, search Enter key not working

## Issues Found

### 1. Missing Historical Data for RMX (and ~194 other stocks)

**Root Cause:**

- Database has 2,000 companies in `company-metadata` table
- Only 1,806 stocks have historical price data in `stock_prices` table
- **194 stocks are missing data**, including RMX
- The historical data sync job was only syncing a hardcoded list of top ASX stocks

**Analysis:**

```sql
-- RMX exists in company metadata
SELECT * FROM "company-metadata" WHERE stock_code = 'RMX';
-- Result: RMX | RED MOUNTAIN MINING LIMITED | Materials

-- But had no price data
SELECT COUNT(*) FROM stock_prices WHERE stock_code = 'RMX';
-- Result: 0 (before fix)
```

**Solution Implemented:**

- Manually synced RMX data (506 data points from 2023-11-02 to 2025-10-31)
- Created `backfill_missing_stocks.py` script to sync all missing stocks
- Added Makefile commands for easy data management

### 2. Search Enter Key Not Working

**Root Cause:**

- When user types "RMX" and hits Enter, the search dropdown was interfering
- The form submission wasn't properly closing the dropdown

**Solution Implemented:**

- Added explicit keyboard handler for Enter key on search input
- Ensures dropdown closes and stock data loads when Enter is pressed
- Updated `web/src/app/stocks/page.tsx`

### 3. Stock Price Ingestion Service Not Deployed/Accessible

**Finding:**

- No Cloud Run service or job appears to be actively running
- User lacks GCP permissions to check deployment status directly
- No scheduler jobs found for automatic daily syncs

**Recommendation:**

- Deploy the stock price ingestion service to Cloud Run
- Set up Cloud Scheduler for daily syncs
- Configure proper monitoring and alerting

## Files Changed

### Frontend Fix

- `web/src/app/stocks/page.tsx` - Fixed Enter key handling in search

### Backend Scripts Created

1. `services/stock-price-ingestion/backfill_missing_stocks.py`
   - Backfills historical data for all stocks missing data
   - Interactive script with confirmation prompt
2. `services/stock-price-ingestion/check_deployment_status.sh`

   - Checks Cloud Run deployment status
   - Provides useful monitoring commands

3. `services/stock-price-ingestion/Makefile` - Added commands:
   - `make db-check-coverage` - Check data coverage stats
   - `make db-list-missing` - List stocks missing data
   - `make backfill-missing` - Backfill all missing stocks
   - `make check-deployment` - Check deployment status
   - `make sync-single STOCK=RMX` - Sync single stock

## How to Use

### Check Data Coverage

```bash
cd services/stock-price-ingestion
export DATABASE_URL="postgresql://..."

# Check overall coverage
make db-check-coverage

# List missing stocks
make db-list-missing
```

**Expected Output:**

```
 total_stocks | stocks_with_data | stocks_missing_data
--------------+------------------+--------------------
         2000 |             1806 |                 194
```

### Sync Missing Stocks

#### Option 1: Sync a Single Stock

```bash
cd services/stock-price-ingestion
export DATABASE_URL="postgresql://..."

make sync-single STOCK=RMX
```

#### Option 2: Backfill All Missing Stocks

```bash
cd services/stock-price-ingestion
export DATABASE_URL="postgresql://..."

make backfill-missing
# Will prompt for confirmation before syncing all 194 missing stocks
```

### Check Deployment Status

```bash
cd services/stock-price-ingestion
make check-deployment
```

This will show:

- Cloud Run services status
- Cloud Scheduler jobs
- Useful monitoring commands
- Database check commands

## Monitoring Commands

### Check Recent Ingestion Logs

```bash
export DATABASE_URL="postgresql://..."
PGGSSENCMODE=disable psql "$DATABASE_URL" -c \
  "SELECT * FROM stock_data_ingestion_log ORDER BY started_at DESC LIMIT 5;"
```

### Check Latest Data Per Stock

```bash
PGGSSENCMODE=disable psql "$DATABASE_URL" -c \
  "SELECT stock_code, MAX(date) as latest_date
   FROM stock_prices
   GROUP BY stock_code
   ORDER BY latest_date DESC
   LIMIT 20;"
```

### Count Data Points Per Stock

```bash
PGGSSENCMODE=disable psql "$DATABASE_URL" -c \
  "SELECT stock_code, COUNT(*) as data_points,
          MIN(date) as earliest_date,
          MAX(date) as latest_date
   FROM stock_prices
   WHERE stock_code IN ('CBA', 'RMX')
   GROUP BY stock_code;"
```

## Next Steps

### Immediate

- [x] Fixed RMX historical data (506 data points loaded)
- [x] Fixed search Enter key behavior
- [x] Created backfill scripts and Makefile commands

### Short-term

- [ ] Run `make backfill-missing` to populate remaining 194 stocks
- [ ] Verify Cloud Run service deployment
- [ ] Set up Cloud Scheduler for daily syncs

### Long-term

- [ ] Deploy stock price ingestion service to Cloud Run
- [ ] Configure Cloud Scheduler for:
  - Daily sync (weekdays at 6 PM AEST after market close)
  - Weekly backfill (Sundays at 8 PM AEST)
- [ ] Set up monitoring alerts for:
  - Failed syncs
  - Stale data (>2 days old)
  - Missing stocks
- [ ] Add data quality checks to ingestion pipeline

## Testing

### Test RMX Data

```bash
# Verify RMX now has data
PGGSSENCMODE=disable psql "$DATABASE_URL" -c \
  "SELECT stock_code, COUNT(*) as data_points,
          MIN(date) as earliest_date,
          MAX(date) as latest_date
   FROM stock_prices
   WHERE stock_code = 'RMX'
   GROUP BY stock_code;"
```

**Expected Result:**

```
 stock_code | data_points | earliest_date | latest_date
------------+-------------+---------------+-------------
 RMX        |         506 | 2023-11-02    | 2025-10-31
```

### Test Search Functionality

1. Navigate to `/stocks` page
2. Type "RMX" in search box
3. Press Enter
4. **Expected:** Stock details for RMX should load with historical chart

## Technical Notes

### Yahoo Finance API

- Free tier is used for historical data
- Rate limiting: ~2,000 requests/hour
- Add .AX suffix for ASX stocks (e.g., RMX.AX)

### Database Schema

```sql
-- Stock prices table
CREATE TABLE stock_prices (
    id SERIAL PRIMARY KEY,
    stock_code VARCHAR(10) NOT NULL,
    date DATE NOT NULL,
    open DECIMAL(10,2),
    high DECIMAL(10,2),
    low DECIMAL(10,2),
    close DECIMAL(10,2),
    volume BIGINT,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(stock_code, date)
);
```

### Connection Issues

If you get GSSAPI errors with psql, use:

```bash
PGGSSENCMODE=disable psql "postgresql://..."
```

Or set in connection pool:

```python
pool = await asyncpg.create_pool(
    DATABASE_URL,
    server_settings={'gssencmode': 'disable'}
)
```

## Support

For issues or questions:

1. Check deployment status: `make check-deployment`
2. Check database coverage: `make db-check-coverage`
3. Review logs: `make logs` (requires GCP permissions)
4. Contact: ben@shorted.com.au
