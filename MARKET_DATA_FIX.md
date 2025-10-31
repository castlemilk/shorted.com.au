# Market Data Service - GetHistoricalPrices Fix

## Problem

The `GetHistoricalPrices` API was hanging indefinitely when called, causing timeouts in the frontend.

## Root Causes

### 1. Incorrect Database Port

- **Issue**: Using port `5432` (direct PostgreSQL connection) which times out with Supabase pooler
- **Solution**: Changed to port `6543` (Supabase transaction pooler)

### 2. Prepared Statement Conflicts

- **Issue**: Supabase transaction pooler doesn't support prepared statements, causing "prepared statement already exists" errors
- **Solution**: Disabled prepared statements by setting `QueryExecModeSimpleProtocol`

## Changes Made

### `services/market-data/main.go`

1. **Database Connection Pool Configuration**:

```go
// Configure connection pool settings
config.MaxConns = 10
config.MinConns = 2
config.MaxConnLifetime = 30 * time.Minute
config.MaxConnIdleTime = 5 * time.Minute
config.HealthCheckPeriod = 1 * time.Minute
config.ConnConfig.ConnectTimeout = 5 * time.Second

// CRITICAL: Disable prepared statements for Supabase transaction pooler (port 6543)
// This prevents "prepared statement already exists" errors
config.ConnConfig.DefaultQueryExecMode = pgx.QueryExecModeSimpleProtocol
```

2. **Query Timeout**:

```go
// Add timeout to prevent hanging
queryCtx, cancel := context.WithTimeout(ctx, 10*time.Second)
defer cancel()

rows, err := s.db.Query(queryCtx, query, req.Msg.StockCode, startDate, endDate)
```

## Correct Database URL

**For Local Development & Deployment**:

```bash
export DATABASE_URL="postgresql://postgres.xivfykscsdagwsreyqgf:661wMKAq9zdZpDk2@aws-0-ap-southeast-2.pooler.supabase.com:6543/postgres?sslmode=require"
```

**Key Points**:

- Port: `6543` (transaction pooler, NOT `5432`)
- SSL Mode: `require`
- Host: `aws-0-ap-southeast-2.pooler.supabase.com`

## Testing

### Local Test:

```bash
cd services/market-data
export DATABASE_URL="postgresql://postgres.xivfykscsdagwsreyqgf:661wMKAq9zdZpDk2@aws-0-ap-southeast-2.pooler.supabase.com:6543/postgres?sslmode=require"
go run main.go validation.go
```

### API Test:

```bash
# Health check
curl -s http://localhost:8090/health

# Get historical prices
curl -s -X POST http://localhost:8090/marketdata.v1.MarketDataService/GetHistoricalPrices \
  -H "Content-Type: application/json" \
  -d '{"stockCode":"CBA","period":"1m"}' | python3 -m json.tool
```

## Deployment

Update Cloud Run service environment variable:

```bash
gcloud run services update market-data-service \
  --set-env-vars DATABASE_URL="postgresql://postgres.xivfykscsdagwsreyqgf:661wMKAq9zdZpDk2@aws-0-ap-southeast-2.pooler.supabase.com:6543/postgres?sslmode=require"
```

## Status

✅ **FIXED** - `GetHistoricalPrices` API now returns data successfully in ~1-2 seconds for 1 month of data (8 records for CBA).

## Next Steps

1. Update CI/CD pipeline to use correct DATABASE_URL with port 6543
2. Update all documentation referencing port 5432
3. Test all other market-data endpoints (`GetStockPrice`, `GetMultipleStockPrices`, `GetStockCorrelations`)
