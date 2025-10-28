# Market Data API Fix

## Issue

The historical data APIs were returning 404 errors or empty responses because the market data service was not running.

## Root Cause

The market data service (Go service on port 8090) was not being started as part of the development workflow. Only the shorts service (port 9091) and frontend (port 3020) were being started.

## Solution

### 1. Added Market Data Service to Makefiles

**services/Makefile:**

- Added `clean.market-data` target to clean up existing processes on port 8090
- Added `run.market-data` target to start the market data service

**Root Makefile:**

- Added `dev-market-data` target to start the market data service
- Updated `dev-stop-services` to stop the market data service on port 8090
- Updated help text to document the new commands

**package.json:**

- Updated `dev` script to start all three services (shorts, market-data, frontend)
- Added `dev:market-data` script with proper DATABASE_URL configuration

### 2. Service Configuration

The market data service requires:

- **Port**: 8090
- **Database URL**: `postgres://admin:password@localhost:5438/shorts`
- **Endpoints**:
  - Health check: `GET http://localhost:8090/health`
  - Historical prices: `POST http://localhost:8090/marketdata.v1.MarketDataService/GetHistoricalPrices`
  - Multiple stock prices: `POST http://localhost:8090/marketdata.v1.MarketDataService/GetMultipleStockPrices`

### 3. Starting Services

#### Option 1: Start all services together (recommended)

```bash
make dev
# or
npm run dev
```

This will start:

- Shorts service (port 9091)
- Market data service (port 8090)
- Frontend (port 3020)

#### Option 2: Start services individually

```bash
# Start database
make dev-db

# Start shorts service
make dev-backend

# Start market data service
make dev-market-data

# Start frontend
make dev-frontend
```

### 4. Testing the Fix

Test the market data API:

```bash
# Health check
curl http://localhost:8090/health

# Get historical prices for CBA (1 year)
curl -X POST http://localhost:8090/marketdata.v1.MarketDataService/GetHistoricalPrices \
  -H "Content-Type: application/json" \
  -d '{"stockCode": "CBA", "period": "1y"}'

# Get multiple stock quotes
curl -X POST http://localhost:8090/marketdata.v1.MarketDataService/GetMultipleStockPrices \
  -H "Content-Type: application/json" \
  -d '{"stockCodes": ["CBA", "ANZ", "BHP"]}'
```

### 5. Data Status

The database currently contains:

- **Total records**: 26,100
- **Date range**: 2024-08-05 to 2025-08-04
- **Stocks**: 100 stocks with ~261 records each

**Note**: The data is from August 2024 to August 2025. For recent data (after August 2025), you may need to populate more data using the stock price ingestion service.

### 6. Frontend Integration

The frontend is configured to call the market data API through:

- Direct calls: `MARKET_DATA_API_URL` environment variable (defaults to `http://localhost:8090`)
- Proxy route: `/web/src/app/api/market-data/historical/route.ts`

The frontend will automatically use the market data service if it's running and healthy.

## Verification

1. ✅ Market data service starts successfully
2. ✅ Health endpoint responds: `{"status": "healthy"}`
3. ✅ Historical prices API returns data
4. ✅ Multiple stock prices API returns data
5. ✅ Service is integrated into dev workflow
6. ✅ Makefile commands added for easy service management

## Next Steps

If you need more recent data:

1. Use the stock price ingestion service to populate recent data
2. See `services/stock-price-ingestion/` for data population scripts
3. Or use: `make populate-stock-data` to populate recent stock price data

## Services Overview

| Service               | Port | Purpose                     |
| --------------------- | ---- | --------------------------- |
| Database (PostgreSQL) | 5438 | Data storage                |
| Shorts Service        | 9091 | Short position data API     |
| Market Data Service   | 8090 | Historical stock prices API |
| Frontend              | 3020 | Next.js application         |

## Preview Deployments

### Issue in Preview

The same issue affected preview deployments. The CI configuration is **correct** and includes the market data service, but:

⚠️ **Action Required**: Existing preview deployments need to be redeployed to pick up the fixes.

### How to Fix Preview Deployment

1. **Trigger a fresh deployment:**

   ```bash
   # Push a commit to your PR
   git commit --allow-empty -m "Redeploy preview with market data service"
   git push
   ```

2. **Wait for deployment** (check PR comments for URLs)

3. **Test the market data service:**
   ```bash
   # Replace XXX with your PR number from the PR comment
   curl https://market-data-service-pr-XXX-xxx.a.run.app/health
   ```

### Important Notes

- **Cold starts**: First request takes 5-10 seconds (service scales to zero when idle)
- **Data range**: August 2024 - August 2025 (may need to populate more recent data)
- **Configuration**: Already correct in CI (lines 91-93, 130-148 in `.github/workflows/ci.yml`)

See [PREVIEW_DEPLOYMENT_TROUBLESHOOTING.md](./PREVIEW_DEPLOYMENT_TROUBLESHOOTING.md) for detailed troubleshooting.
