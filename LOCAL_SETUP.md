# Local Development Setup Guide

Complete guide to setting up the Shorted.com.au application for local development.

## Prerequisites

- **Docker** & Docker Compose (for PostgreSQL)
- **Node.js** 18+ (for web frontend)
- **Go** 1.21+ (for backend services)
- **Python** 3.11+ (for data population scripts)

## Quick Start (5 minutes)

Get up and running with sample data:

```bash
# 1. Clone and navigate
cd /path/to/shorted

# 2. Start PostgreSQL
docker-compose -f analysis/sql/docker-compose.yaml up -d

# 3. Load sample data
export DATABASE_URL="postgresql://postgres:postgres@localhost:5432/postgres"
psql $DATABASE_URL -f analysis/sql/init-db.sql

# 4. Start backend services
cd services
make run.shorts      # Terminal 1 (port 9091)
make run.market-data # Terminal 2 (port 8090)

# 5. Start frontend
cd web
npm install
npm run dev         # Terminal 3 (port 3020)

# 6. Visit app
open http://localhost:3020
```

You now have:

- ✅ Sample short position data (CBA, BHP, RMD, RMX)
- ✅ Last 2 days of data
- ✅ All services running

## Full Setup (30-60 minutes)

Get production-like data for comprehensive testing.

### Step 1: Start PostgreSQL

```bash
cd analysis/sql
docker-compose up -d

# Verify it's running
docker ps | grep postgres
psql postgresql://postgres:postgres@localhost:5432/postgres -c "SELECT version();"
```

### Step 2: Populate Short Position Data

Choose one option:

#### Option A: Use Existing CSVs (if available)

```bash
cd analysis

# Check environment and CSV files
make status

# If you have CSV files, install and load
make install
export DATABASE_URL="postgresql://postgres:postgres@localhost:5432/postgres"
make populate-skip-download
```

Expected: ~18M records, 10+ years of data, takes 10-15 minutes

#### Option B: Download Fresh from ASIC

```bash
cd analysis

# All-in-one: download + process + load
make install
export DATABASE_URL="postgresql://postgres:postgres@localhost:5432/postgres"
make populate
```

Or step-by-step:

```bash
cd analysis

# Download CSV files
make download

# Process and load
export DATABASE_URL="postgresql://postgres:postgres@localhost:5432/postgres"
make populate-skip-download
```

Expected: Downloads take 10-20 minutes, processing takes 10-15 minutes

### Step 3: Populate Stock Price Data

Choose one option:

#### Option A: Major Stocks Only (~50 stocks, 5-10 minutes)

```bash
cd services/market-data
pip install -r requirements.txt
export DATABASE_URL="postgresql://postgres:postgres@localhost:5432/postgres"
python3 populate_simple.py
```

Gets: CBA, BHP, CSL, WBC, ANZ, NAB, WOW, WES, RIO, TLS, etc.

#### Option B: All Stocks with Short Data (~500 stocks, 20-30 minutes)

```bash
cd services/market-data
pip install -r requirements.txt
export DATABASE_URL="postgresql://postgres:postgres@localhost:5432/postgres"
python3 populate_from_shorts_data.py
```

Gets: Every stock that has short position data

#### Option C: Complete ASX Dataset (2,291 stocks, 60-90 minutes)

```bash
cd services/market-data
export DATABASE_URL="postgresql://postgres:postgres@localhost:5432/postgres"
make populate-all-stocks
```

Gets: All ASX stocks (production-like)

### Step 4: Verify Data

```bash
export DATABASE_URL="postgresql://postgres:postgres@localhost:5432/postgres"

# Check record counts
psql $DATABASE_URL -c "
SELECT
  (SELECT COUNT(*) FROM shorts) as short_records,
  (SELECT COUNT(DISTINCT \"PRODUCT_CODE\") FROM shorts) as stocks_with_shorts,
  (SELECT COUNT(*) FROM stock_prices) as price_records,
  (SELECT COUNT(DISTINCT stock_code) FROM stock_prices) as stocks_with_prices;
"

# Check date ranges
psql $DATABASE_URL -c "
SELECT
  'shorts' as table_name,
  MIN(\"DATE\") as earliest,
  MAX(\"DATE\") as latest
FROM shorts
UNION ALL
SELECT
  'stock_prices' as table_name,
  MIN(date) as earliest,
  MAX(date) as latest
FROM stock_prices;
"

# Top stocks by record count
psql $DATABASE_URL -c "
SELECT \"PRODUCT_CODE\", COUNT(*) as records
FROM shorts
GROUP BY \"PRODUCT_CODE\"
ORDER BY records DESC
LIMIT 10;
"
```

Expected output for full setup:

```
 short_records | stocks_with_shorts | price_records | stocks_with_prices
---------------+--------------------+---------------+--------------------
      18543287 |               2587 |       2834567 |               2291
```

### Step 5: Start Backend Services

#### Terminal 1: Shorts Service

```bash
cd services
export DATABASE_URL="postgresql://postgres:postgres@localhost:5432/postgres"
make run.shorts
```

Expected output:

```
🧹 Cleaning up existing shorts service...
GOOGLE_APPLICATION_CREDENTIALS=... go run shorts/cmd/server/main.go
Starting server on :9091
```

Test it:

```bash
curl http://localhost:9091/health
```

#### Terminal 2: Market Data Service

```bash
cd services
export DATABASE_URL="postgresql://postgres:postgres@localhost:5432/postgres"
make run.market-data
```

Expected output:

```
🧹 Cleaning up existing market data service...
🚀 Starting market data service on port 8090...
Starting market data service
Database connection successful
Starting HTTP server on port 8090
```

Test it:

```bash
curl http://localhost:8090/health
```

### Step 6: Start Frontend

#### Terminal 3: Web Application

```bash
cd web

# Install dependencies (first time only)
npm install

# Create .env.local (first time only)
cat > .env.local << 'EOF'
# Database (for server-side queries)
DATABASE_URL="postgresql://postgres:postgres@localhost:5432/postgres"

# API endpoints
NEXT_PUBLIC_SHORTS_API_URL="http://localhost:9091"
NEXT_PUBLIC_MARKET_DATA_API_URL="http://localhost:8090"

# Auth (optional for local dev)
NEXTAUTH_SECRET="dev-secret-change-in-production"
NEXTAUTH_URL="http://localhost:3020"

# Skip environment validation during development
SKIP_ENV_VALIDATION=true
EOF

# Start dev server
npm run dev
```

Expected output:

```
  ▲ Next.js 14.x.x
  - Local:        http://localhost:3020
  - Network:      http://192.168.1.x:3020

 ✓ Ready in 2.3s
```

### Step 7: Test the Application

Visit these URLs to verify everything works:

```bash
# Home page
open http://localhost:3020

# Stock detail pages (should show both charts)
open http://localhost:3020/shorts/CBA
open http://localhost:3020/shorts/BHP
open http://localhost:3020/shorts/RMX

# API health checks
curl http://localhost:9091/health | jq
curl http://localhost:8090/health | jq

# Test market data API
curl -X POST http://localhost:8090/marketdata.v1.MarketDataService/GetHistoricalPrices \
  -H "Content-Type: application/json" \
  -d '{"stockCode":"CBA","period":"1y"}' | jq '.prices | length'

# Should return ~250 (1 year of trading days)
```

## Architecture Overview

```
┌─────────────────────────────────────────────────────────────────┐
│                         Frontend (Next.js)                       │
│                      http://localhost:3020                       │
└───────────────┬─────────────────────────────────┬───────────────┘
                │                                 │
                │                                 │
    ┌───────────▼──────────┐          ┌──────────▼────────────┐
    │   Shorts Service     │          │ Market Data Service   │
    │   (Go + Connect)     │          │   (Go + Connect)      │
    │   Port 9091          │          │   Port 8090           │
    └───────────┬──────────┘          └──────────┬────────────┘
                │                                 │
                └─────────────────┬───────────────┘
                                  │
                    ┌─────────────▼────────────┐
                    │    PostgreSQL (Docker)   │
                    │    Port 5432             │
                    │                          │
                    │  Tables:                 │
                    │  - shorts                │
                    │  - stock_prices          │
                    │  - company-metadata      │
                    └──────────────────────────┘
```

## Common Issues

### Port Already in Use

```bash
# Find and kill process
lsof -ti:9091 | xargs kill -9
lsof -ti:8090 | xargs kill -9
lsof -ti:3020 | xargs kill -9

# Or use make commands
cd services
make clean.shorts
make clean.market-data
```

### Database Connection Failed

```bash
# Check PostgreSQL is running
docker ps | grep postgres

# Check connection
psql postgresql://postgres:postgres@localhost:5432/postgres -c "SELECT 1"

# Restart PostgreSQL
cd analysis/sql
docker-compose restart
```

### "No data available"

This means tables are empty. Run population scripts (Step 2 & 3 above).

### Charts Not Rendering

1. Check browser console for errors
2. Verify API endpoints are running:
   ```bash
   curl http://localhost:9091/health
   curl http://localhost:8090/health
   ```
3. Check `.env.local` has correct URLs
4. Restart frontend: `Ctrl+C` and `npm run dev`

### Import Errors in Python Scripts

```bash
# Install dependencies
cd analysis
pip install -r requirements.txt

cd services/market-data
pip install -r requirements.txt
```

### Go Build Errors

```bash
# Install dependencies
cd services
go mod download
go mod tidy
```

## Development Workflow

### Running Tests

```bash
# Frontend tests
cd web
npm test

# Backend unit tests
cd services
go test ./... -v

# Backend integration tests (requires running PostgreSQL)
export DATABASE_URL="postgresql://postgres:postgres@localhost:5432/postgres"
cd services/market-data
go test -v -tags=integration
```

### Generating Protobuf Code

```bash
cd services
buf generate
```

### Database Migrations

```bash
cd services
export DATABASE_URL="postgresql://postgres:postgres@localhost:5432/postgres"

# Run migrations
make migrate-up

# Check status
make migrate-version

# Create new migration
make migrate-create NAME=add_new_feature
```

## Environment Variables Reference

### Backend Services

```bash
# Database
DATABASE_URL="postgresql://postgres:postgres@localhost:5432/postgres"

# Server ports
PORT=9091  # shorts service
PORT=8090  # market-data service

# Google Cloud (optional for local dev)
GOOGLE_APPLICATION_CREDENTIALS="path/to/service-account.json"
```

### Frontend

```bash
# Database (server-side)
DATABASE_URL="postgresql://postgres:postgres@localhost:5432/postgres"

# API endpoints
NEXT_PUBLIC_SHORTS_API_URL="http://localhost:9091"
NEXT_PUBLIC_MARKET_DATA_API_URL="http://localhost:8090"

# Auth
NEXTAUTH_SECRET="dev-secret-change-in-production"
NEXTAUTH_URL="http://localhost:3020"

# Development
SKIP_ENV_VALIDATION=true
```

## Useful Commands

```bash
# Clean everything
docker-compose -f analysis/sql/docker-compose.yaml down -v
cd services && make clean.shorts && make clean.market-data

# Fresh start
dropdb -h localhost -U postgres postgres
createdb -h localhost -U postgres postgres
psql postgresql://postgres:postgres@localhost:5432/postgres -f analysis/sql/init-db.sql

# Watch logs
docker logs -f postgres_container_name

# Database shell
psql postgresql://postgres:postgres@localhost:5432/postgres

# Check Go service logs
cd services && go run shorts/cmd/server/main.go 2>&1 | tee shorts.log
```

## Next Steps

- Read [ARCHITECTURE.md](ARCHITECTURE.md) for system design
- Read [web/CHART_UNIFICATION.md](web/CHART_UNIFICATION.md) for chart components
- Read [services/market-data/INTEGRATION_TESTING.md](services/market-data/INTEGRATION_TESTING.md) for testing

## Getting Help

- Check existing documentation in `/docs`
- Review GitHub issues
- Check CI/CD logs in `.github/workflows/`

---

Happy coding! 🚀
