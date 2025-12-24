# Verifying Preview Environment

This guide helps you verify that the historical stock data fix is working in the preview environment.

## Quick Check

### Option 1: Use the Verification Script

```bash
# Check preview frontend (if you know the URL)
./scripts/verify-preview.sh https://preview.shorted.com.au

# Or with Market Data API URL
./scripts/verify-preview.sh https://preview.shorted.com.au https://market-data-service-pr-XXX.a.run.app
```

### Option 2: Manual Browser Check

1. **Find your preview URL**:

   - Check the PR comments for the preview deployment URL
   - Or visit: `https://preview.shorted.com.au` (if using the default preview alias)

2. **Test historical data**:

   - Navigate to a stock page: `https://preview.shorted.com.au/shorts/WES`
   - Check if the "Historical Price Data" chart loads
   - Verify data points are visible on the chart

3. **Check browser console**:
   - Open DevTools (F12)
   - Look for any errors related to historical data
   - Check Network tab for `/api/market-data/historical` requests

### Option 3: Direct API Check

```bash
# Replace with your actual Market Data API URL from PR comments
MARKET_DATA_URL="https://market-data-service-pr-XXX.a.run.app"

# Check health
curl "$MARKET_DATA_URL/health"

# Check historical data
curl -X POST "$MARKET_DATA_URL/marketdata.v1.MarketDataService/GetHistoricalPrices" \
  -H "Content-Type: application/json" \
  -d '{"stockCode": "WES", "period": "1m"}'
```

## What to Look For

### ✅ Success Indicators

- Historical price chart renders on stock pages
- Chart shows data points (not empty)
- No console errors about missing data
- API returns `prices` array with data

### ❌ Failure Indicators

- Chart shows "No data available"
- Console errors about database connection
- API returns empty `prices` array
- 500 errors from market data service

## Troubleshooting

### If Historical Data is Missing

1. **Check Market Data Service Logs**:

   ```bash
   gcloud run logs read --service market-data-service-pr-XXX \
     --region australia-southeast2 \
     --limit 50
   ```

2. **Verify Database Connection**:

   - Check if `DATABASE_URL` is set in Cloud Run service
   - Verify database is accessible from Cloud Run

3. **Check Service Health**:

   ```bash
   curl https://market-data-service-pr-XXX.a.run.app/health
   ```

4. **Verify Fixes Are Deployed**:
   - Check that the latest code with UTC timezone fix is deployed
   - Verify nil database connection check is in place

## Expected Behavior After Fix

With the fixes we made:

1. **Nil Database Check**: Service should return proper error (not panic) if DB is nil
2. **UTC Timezone**: Dates should be calculated in UTC, matching database
3. **Better Logging**: Service logs should show query details
4. **Error Handling**: `rows.Err()` check catches scan errors

The preview should now successfully load historical stock data for stocks that have data in the database.


