# Local Database Configuration Summary

## Overview

This document explains how the local development environment is configured to use the PostgreSQL database running in Docker Compose.

## ✅ What Was Fixed

### 1. **Default DATABASE_URL in Services Makefile**

Added a default `DATABASE_URL` that automatically connects to the local PostgreSQL instance:

```makefile
# Default database URL for local development
# Note: Local docker-compose (in ../analysis/sql) uses admin/password on port 5438
DATABASE_URL ?= postgresql://admin:password@localhost:5438/shorts
```

**Location**: `/services/Makefile` (line 9-11)

### 2. **Updated Run Commands**

Both `run.shorts` and `run.market-data` targets now export the `DATABASE_URL`:

```makefile
run.shorts: clean.shorts
	@echo "🚀 Starting shorts service on port 9091..."
	@echo "   Database: $(DATABASE_URL)"
	DATABASE_URL=$(DATABASE_URL) GOOGLE_APPLICATION_CREDENTIALS=${GOOGLE_APPLICATION_CREDENTIALS} go run shorts/cmd/server/main.go

run.market-data: clean.market-data
	@echo "🚀 Starting market data service on port 8090..."
	@echo "   Database: $(DATABASE_URL)"
	DATABASE_URL=$(DATABASE_URL) cd market-data && go run main.go validation.go
```

### 3. **Simplified npm Scripts**

Removed hardcoded `DATABASE_URL` from `package.json` since it's now in the Makefile:

```json
"dev:backend": "cd services && make run.shorts",
"dev:market-data": "cd services && make run.market-data"
```

**Location**: `/package.json` (lines 10-11)

## 🗄️ Database Connection Details

### Docker Compose Configuration

- **Host**: `localhost`
- **Port**: `5438` (mapped from container's 5432)
- **Database**: `shorts`
- **Username**: `admin`
- **Password**: `password`

### Connection String

```
postgresql://admin:password@localhost:5438/shorts
```

**Config Location**: `/analysis/sql/docker-compose.yaml`

## 🚀 How to Use

### Start the Database

```bash
cd analysis/sql
docker compose up -d postgres
```

### Verify Database is Running

```bash
docker ps | grep shorted_db
psql "postgresql://admin:password@localhost:5438/shorts" -c "SELECT COUNT(*) FROM shorts;"
```

### Start Services

#### Option 1: Using Makefile (Recommended)

```bash
# From services directory
cd services
make run.shorts        # Starts shorts service on :9091
make run.market-data   # Starts market-data service on :8090
```

#### Option 2: Using npm (All services)

```bash
# From root directory
npm run dev
# This starts: shorts service, market-data service, and frontend
```

#### Option 3: Using Root Makefile

```bash
# From root directory
make run  # or: make dev
```

### Override DATABASE_URL (if needed)

```bash
# Export for current shell session
export DATABASE_URL='postgresql://user:pass@host:port/database'

# Or inline for single command
DATABASE_URL='postgresql://...' make run.shorts
```

## 🧪 Verify Services

### Check Service Health

```bash
# Shorts service
curl http://localhost:9091/health

# Market data service
curl http://localhost:8090/health
```

### Test API Endpoints

```bash
# Get top shorts (MAX period to see historical data)
curl -X POST http://localhost:9091/shorts.v1alpha1.ShortedStocksService/GetTopShorts \
  -H "Content-Type: application/json" \
  -d '{"period": "MAX", "limit": 5}' | jq '.timeSeries[0]'

# Get market data
curl -X POST http://localhost:8090/marketdata.v1.MarketDataService/GetHistoricalPrices \
  -H "Content-Type: application/json" \
  -d '{"symbol": "WBC", "from_date": "2024-01-01", "to_date": "2024-12-31"}' | jq '.'
```

## 📊 Current Data Status

### Short Position Data

- **Records**: ~1.9 million
- **Date Range**: June 2010 - May 2024
- **Note**: When testing with recent periods (1D, 1W, 1M), you may get empty results since the data is historical

### Stock Price Data

- Populated via `market-data` service
- Check `/services/market-data/README.md` for population instructions

## 🔧 Troubleshooting

### Service won't start or can't connect to database

1. **Check database is running**:

   ```bash
   docker ps | grep shorted_db
   ```

2. **Check DATABASE_URL**:

   ```bash
   echo $DATABASE_URL
   ```

3. **Test direct connection**:

   ```bash
   psql "postgresql://admin:password@localhost:5438/shorts" -c "SELECT 1;"
   ```

4. **Check service logs** for database connection errors

### Empty API responses

- Remember the short position data only goes up to May 2024
- Use `"period": "MAX"` or `"period": "1Y"` with dates from 2024 or earlier
- Check data exists: `psql "postgresql://admin:password@localhost:5438/shorts" -c "SELECT MAX(\"DATE\") FROM shorts;"`

## 📁 Related Documentation

- **Data Population**: `/LOCAL_SETUP.md`
- **Short Data**: `/analysis/README.md`
- **Market Data**: `/services/market-data/README.md`
- **Analysis Makefile**: `/analysis/Makefile`
- **Services Makefile**: `/services/Makefile`

## 🎯 Key Benefits

1. **No manual environment variables**: The `DATABASE_URL` is automatically set for local development
2. **Consistent across commands**: `make run.shorts`, `make run.market-data`, and `npm run dev` all use the same configuration
3. **Easy to override**: Can still set `DATABASE_URL` environment variable when needed
4. **Clear feedback**: Services print the database URL when starting

---

**Last Updated**: November 1, 2025
**Services Status**: ✅ Both shorts and market-data services working with local database
