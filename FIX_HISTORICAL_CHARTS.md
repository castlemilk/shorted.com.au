# Fix Historical Charts - Complete Guide

## 🔍 Current Issue

When visiting `/shorts/[stockCode]` pages (e.g., `/shorts/RMX`), you see:
- ✅ **Short Position Trends** chart works
- ❌ **Historical Price Data** chart shows error: `400 - invalid period format`

## 🎯 Root Causes

### 1. Empty Database ❌
The `stock_prices` table has no data yet.

### 2. Validation Already Fixed ✅
The market-data service validation **already supports** all periods:
- `1d`, `1w`, `1m`, `3m`, `6m`, `1y`, `2y`, `5y`, `10y`, `max`

The error you're seeing is likely from:
- An old deployed version, OR
- The service needs to be redeployed with the fixed Dockerfile

## ✅ Solution

### Step 1: Deploy Updated Service (CI/CD)

The next time CI/CD runs (on your next push), it will:
1. Build market-data service with fixed Dockerfile (Go 1.23)
2. Deploy to Cloud Run with correct validation
3. Set `NEXT_PUBLIC_MARKET_DATA_API_URL` env var

**This happens automatically** - no action needed!

### Step 2: Populate Database

Once the service is deployed, populate the database:

```bash
cd services/market-data
export DATABASE_URL="postgresql://postgres.xivfykscsdagwsreyqgf:661wMKAq9zdZpDk2@aws-0-ap-southeast-2.pooler.supabase.com:5432/postgres"
make populate-all-stocks
```

**Duration**: 30-60 minutes  
**Records**: ~2.8M price records for 2,291 ASX stocks

### Step 3: Deploy Daily Sync

Set up automatic daily updates:

```bash
cd services/market-data
export DATABASE_URL="..."
make deploy-daily-sync
```

**Schedule**: Daily at 2 AM AEST  
**Updates**: Last 5 days for all stocks

## 📊 Verification

### Check Service Deployment

```bash
# Get service URL from PR comment or CI logs
curl https://market-data-service-pr-XX.run.app/health

# Expected:
{"status":"healthy"}
```

### Test API with Different Periods

```bash
SERVICE_URL="https://market-data-service-pr-XX.run.app"

# Test 5y period (the default in MarketChart)
curl -X POST "$SERVICE_URL/marketdata.v1.MarketDataService/GetHistoricalPrices" \
  -H "Content-Type: application/json" \
  -d '{"stockCode":"CBA","period":"5y"}' | jq '.prices | length'

# Test 2y period
curl -X POST "$SERVICE_URL/marketdata.v1.MarketDataService/GetHistoricalPrices" \
  -H "Content-Type: application/json" \
  -d '{"stockCode":"CBA","period":"2y"}' | jq '.prices | length'

# Test 10y period
curl -X POST "$SERVICE_URL/marketdata.v1.MarketDataService/GetHistoricalPrices" \
  -H "Content-Type: application/json" \
  -d '{"stockCode":"CBA","period":"10y"}' | jq '.prices | length'
```

**Expected**: Should return data points (once database is populated)

### Check Database

```sql
-- Check total records
SELECT 
  COUNT(*) as total_records,
  COUNT(DISTINCT stock_code) as unique_stocks,
  MIN(date) as earliest,
  MAX(date) as latest
FROM stock_prices;

-- Expected after population:
-- total_records: ~2,800,000
-- unique_stocks: ~2,291
-- earliest: ~2015-10-31
-- latest: ~2025-10-31
```

### Test Frontend

Visit any stock page:
- https://preview.shorted.com.au/shorts/RMX
- https://preview.shorted.com.au/shorts/CBA
- https://preview.shorted.com.au/shorts/BHP

**Expected**:
1. Both charts render
2. Period selector works (1M, 3M, 6M, 1Y, 2Y, 5Y, 10Y, max)
3. Data points display correctly

## 🔧 Architecture

### Request Flow

```
User visits /shorts/RMX
    ↓
MarketChart component (default period: 5y)
    ↓
useMarketData("RMX", "5y")
    ↓
getHistoricalData("RMX", "5y")
    ↓
POST ${MARKET_DATA_API_URL}/GetHistoricalPrices
    Body: {"stockCode":"RMX","period":"5y"}
    ↓
Market Data Service (Go - Port 8090)
    ↓
Validation: period.toLowerCase() → "5y" ✅
    ↓
Query: SELECT * FROM stock_prices 
       WHERE stock_code = 'RMX' 
       AND date >= NOW() - INTERVAL '5 years'
    ↓
Returns: {prices: [{date, open, high, low, close, volume}, ...]}
    ↓
Frontend: Renders chart with data ✅
```

### Services

| Service | Port | Endpoint | Purpose |
|---------|------|----------|---------|
| **market-data** | 8090 | `/GetHistoricalPrices` | Price time series |
| **shorts** | 9091 | `/GetStockData` | Short position time series |

### Environment Variables

**Frontend (Next.js)**:
```env
NEXT_PUBLIC_MARKET_DATA_API_URL=https://market-data-service-pr-XX.run.app
NEXT_PUBLIC_SHORTS_API_URL=https://shorts-service-pr-XX.run.app
```

**Backend (Cloud Run)**:
```env
DATABASE_URL=postgresql://...
PORT=8090  # for market-data
PORT=9091  # for shorts
```

## 🐛 Troubleshooting

### Error: "invalid period format"

**Cause**: Old deployed version with incorrect validation

**Fix**: 
1. Push code to trigger CI/CD (already done!)
2. Wait for deployment to complete
3. Test with `curl` (see above)

### Error: "No market data available"

**Cause**: Database is empty

**Fix**: Run `make populate-all-stocks` (see Step 2 above)

### Error: "Market data service not available"

**Cause**: Service not deployed or wrong URL

**Fix**:
```bash
# Check service exists
gcloud run services list | grep market-data

# Check frontend env var
echo $NEXT_PUBLIC_MARKET_DATA_API_URL

# Verify in browser console
console.log(process.env.NEXT_PUBLIC_MARKET_DATA_API_URL)
```

### Chart shows "Loading..." forever

**Causes**:
1. API call hanging (timeout issue)
2. CORS error
3. Network error

**Fix**:
```javascript
// Check browser console for errors
// Common issues:
// - CORS: "Access-Control-Allow-Origin"
// - Timeout: "Failed to fetch" after 5s
// - 400/500: API error (check response body)
```

### Only 8 data points for "1m" period

**Cause**: Database has limited data

**Expected**: ~22 trading days for 1 month

**Fix**: Wait for full population to complete (30-60 min)

## 📁 Files Reference

### Frontend
```
web/src/app/shorts/[stockCode]/page.tsx
    ├── <Chart> → Short position trends (shorts service)
    └── <MarketChart> → Historical prices (market-data service)

web/src/@/components/ui/market-chart.tsx
    └── useMarketData hook

web/src/@/hooks/use-market-data.ts
    └── getHistoricalData from stock-data-service

web/src/@/lib/stock-data-service.ts
    └── fetch(${MARKET_DATA_API_URL}/GetHistoricalPrices)
```

### Backend
```
services/market-data/
├── main.go                        # GetHistoricalPrices implementation
├── validation.go                  # ✅ Supports 1d-10y, max
├── Dockerfile                     # ✅ Fixed: Go 1.23
├── populate_all_asx_from_csv.py   # Populate 10 years
└── daily_historical_sync.py       # Daily updates

services/shorts/
└── internal/services/shorts/
    ├── service.go                 # GetStockData implementation
    └── validation.go              # Supports 1D-1Y only (for shorts)
```

### Validation Differences

**market-data service** (for prices):
```go
validPeriods = map[string]bool{
  "1d": true, "1w": true, "1m": true,
  "3m": true, "6m": true, "1y": true,
  "2y": true, "5y": true, "10y": true,
  "max": true,
}
```

**shorts service** (for short positions):
```go
validPeriods = map[string]bool{
  "1D": true, "1W": true, "1M": true,
  "3M": true, "6M": true, "1Y": true,
}
```

> **Note**: Shorts only go back 1 year because ASIC data is limited. Prices go back 10 years from Yahoo Finance.

## 🎉 Expected Outcome

After following steps 1-3:

1. ✅ Service deployed with correct validation
2. ✅ Database populated with 10 years of price data
3. ✅ Daily sync keeps data current
4. ✅ All period selectors work (1M through max)
5. ✅ Charts render on ALL stock pages
6. ✅ Both charts (shorts + prices) display correctly

## 📊 Timeline

1. **Now**: Code committed, ready for deployment
2. **Next push**: CI/CD deploys market-data service (~5 min)
3. **Manual**: Run database population (~30-60 min)
4. **Manual**: Deploy daily sync (~2 min)
5. **Done**: Charts work! 🎉

## 🚀 Quick Commands

```bash
# Deploy is automatic on push ✅

# Populate database (manual, one-time)
cd services/market-data
export DATABASE_URL="postgresql://..."
make populate-all-stocks

# Deploy daily sync (manual, one-time)
make deploy-daily-sync

# Test locally
docker run --rm -d \
  -e DATABASE_URL="$DATABASE_URL" \
  -p 8090:8090 \
  --name market-data-test \
  market-data-service:test

curl http://localhost:8090/health
curl -X POST http://localhost:8090/marketdata.v1.MarketDataService/GetHistoricalPrices \
  -H "Content-Type: application/json" \
  -d '{"stockCode":"CBA","period":"5y"}'

docker kill market-data-test
```

---

**Status**: ✅ Ready for deployment and data population!

