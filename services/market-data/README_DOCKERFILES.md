# Market Data Service Dockerfiles

This directory contains two different services with different purposes:

## Dockerfile (Go Connect RPC Service) ✅ ACTIVE

**Purpose:** Serves market data API for frontend queries  
**Language:** Go  
**Framework:** Connect RPC  
**Endpoints:**

- `/health` - Health check
- `/marketdata.v1.MarketDataService/GetHistoricalPrices` - Historical stock prices
- `/marketdata.v1.MarketDataService/GetMultipleStockPrices` - Multiple stock quotes
- `/marketdata.v1.MarketDataService/GetStockCorrelations` - Stock correlations

**Used by:**

- Frontend application (web/)
- Preview deployments
- Production API

**Build:**

```bash
cd services
docker build -f market-data/Dockerfile -t market-data-api .
```

**Run:**

```bash
docker run -p 8090:8090 \
  -e DATABASE_URL="your-database-url" \
  market-data-api
```

## Dockerfile.python-ingestion (Python FastAPI Service) 📊 DATA INGESTION

**Purpose:** Populates historical stock price data from external APIs  
**Language:** Python  
**Framework:** FastAPI  
**Endpoints:**

- `/health` - Health check
- `/sync` - Sync recent market data (last 5 days)
- `/historical` - Populate historical data (years back)
- `/stocks` - List available ASX stocks
- `/stocks/{symbol}` - Get stock information
- `/stocks/{symbol}/data` - Get historical data for a stock
- `/stats` - Service statistics

**Used by:**

- Manual data population tasks
- Scheduled data sync jobs (Cloud Scheduler)
- Database backfill operations

**Build:**

```bash
cd services/market-data
docker build -f Dockerfile.python-ingestion -t market-data-ingestion .
```

**Run:**

```bash
docker run -p 8090:8090 \
  -e DATABASE_URL="your-database-url" \
  -e ALPHA_VANTAGE_API_KEY="your-api-key" \
  market-data-ingestion
```

## Which One To Use?

### Use **Dockerfile** (Go) when:

- ✅ Building the API service for preview/production
- ✅ Serving data to the frontend
- ✅ You need fast, efficient API responses
- ✅ You want low resource usage

### Use **Dockerfile.python-ingestion** when:

- ✅ Populating historical stock data
- ✅ Running data sync jobs
- ✅ Backfilling missing data
- ✅ Testing data ingestion from Alpha Vantage/Yahoo Finance

## Architecture

```
┌─────────────────────────────────────────────────────┐
│                    Frontend (Next.js)                │
│                                                      │
│  Calls: /marketdata.v1.MarketDataService/*          │
└──────────────────────┬───────────────────────────────┘
                       │
                       ↓
┌──────────────────────────────────────────────────────┐
│         Go Market Data Service (Dockerfile)          │
│                                                      │
│  • Fast API responses                                │
│  • Connect RPC endpoints                             │
│  • Reads from database                               │
└──────────────────────┬───────────────────────────────┘
                       │
                       ↓
┌──────────────────────────────────────────────────────┐
│              PostgreSQL Database                     │
│                                                      │
│  • stock_prices table                                │
│  • Historical price data                             │
└──────────────────────┬───────────────────────────────┘
                       ↑
                       │
┌──────────────────────────────────────────────────────┐
│  Python Ingestion Service (Dockerfile.python)        │
│                                                      │
│  • Fetches from Alpha Vantage API                    │
│  • Fetches from Yahoo Finance                        │
│  • Writes to database                                │
│  • Scheduled sync jobs                               │
└──────────────────────────────────────────────────────┘
```

## CI/CD

The GitHub Actions workflow (`.github/workflows/ci.yml`) builds and deploys the **Go service** (Dockerfile) for preview and production environments:

```yaml
# Build and push Market Data Service (Go Connect RPC service)
docker build -f market-data/Dockerfile -t ... .
```

## Migration Notes

**October 28, 2025:**

- Fixed preview deployment 404 errors
- Deployed Python service was incompatible with frontend
- Updated Dockerfile from Python to Go
- Fixed CI build context from `market-data/` to `.`
- Preserved Python service as `Dockerfile.python-ingestion`

See [DOCKERFILE_FIX.md](../../DOCKERFILE_FIX.md) for details.
