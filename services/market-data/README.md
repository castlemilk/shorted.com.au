# Market Data Service

Historical stock price data management for ALL ASX stocks.

## Architecture

Two independent jobs:

### 1. Short Data Sync (Existing)
- **Purpose**: Sync short selling data from ASIC
- **Frequency**: Daily
- **Source**: ASIC daily reports
- **Target**: `shorts` table
- **Location**: `services/short-data-sync/`

### 2. Historical Price Data Sync (This Service)
- **Purpose**: Maintain historical price data for all ASX stocks
- **Frequency**: Daily at 2 AM AEST
- **Source**: Yahoo Finance API
- **Target**: `stock_prices` table

## Jobs

### Initial Population (One-Time)

Populates 10 years of historical data for ALL ~2,291 ASX stocks.

```bash
cd services/market-data
export DATABASE_URL="postgresql://..."
make populate-all-stocks
```

**Expected Duration**: 30-60 minutes
**Records**: ~2.8M price records (10 years × 2,291 stocks)

### Daily Sync (Ongoing)

Incrementally updates the last 5 days of data for all stocks.

```bash
# Run locally
make daily-sync

# Deploy to Cloud Run (scheduled daily at 2 AM)
export DATABASE_URL="postgresql://..."
export GCP_PROJECT="shorted-dev-aba5688f"
make deploy-daily-sync
```

**Expected Duration**: 5-10 minutes
**Records**: ~11,000 price records (5 days × 2,291 stocks)

## Files

```
services/market-data/
├── populate_all_asx_from_csv.py   # One-time: Load 10 years of data
├── daily_historical_sync.py        # Daily: Incremental updates (5 days)
├── deploy-daily-sync.sh            # Deploy daily sync to Cloud Run
├── Dockerfile.daily-sync           # Container for daily sync job
├── requirements.txt                # Python dependencies
└── Makefile                        # Commands
```

## Data Source

**ASX Company List**:
- Location: `analysis/data/ASX_Listed_Companies_07-04-2024_11-03-45_AEST.csv`
- Contains: 2,291 ASX stocks
- Official source: ASX.com.au company directory

**Price Data**:
- Provider: Yahoo Finance (free, no API key needed)
- Format: Stock code + `.AX` suffix (e.g., `CBA.AX`, `RMX.AX`)
- Fields: open, high, low, close, adjusted_close, volume

## Cloud Run Job

The daily sync runs as a Cloud Run Job:

```yaml
Name: daily-historical-sync
Schedule: "0 2 * * *" (2 AM AEST daily)
Memory: 2Gi
CPU: 1
Timeout: 1 hour
Retries: 2
```

### Manual Execution

```bash
gcloud run jobs execute daily-historical-sync \
  --region australia-southeast2 \
  --project shorted-dev-aba5688f
```

### View Logs

```bash
gcloud logging read \
  "resource.type=cloud_run_job AND resource.labels.job_name=daily-historical-sync" \
  --limit 50 \
  --project shorted-dev-aba5688f
```

## Database Schema

```sql
CREATE TABLE stock_prices (
    id BIGSERIAL PRIMARY KEY,
    stock_code VARCHAR(10) NOT NULL,
    date DATE NOT NULL,
    open DECIMAL(10, 2),
    high DECIMAL(10, 2),
    low DECIMAL(10, 2),
    close DECIMAL(10, 2) NOT NULL,
    adjusted_close DECIMAL(10, 2),
    volume BIGINT,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(stock_code, date)
);

CREATE INDEX idx_stock_prices_stock_code ON stock_prices(stock_code);
CREATE INDEX idx_stock_prices_date ON stock_prices(date);
CREATE INDEX idx_stock_prices_stock_date ON stock_prices(stock_code, date DESC);
```

## Configuration

Environment variables:

```bash
# Required
DATABASE_URL="postgresql://user:pass@host:port/db"

# Optional
SYNC_DAYS="5"              # Number of days to sync (default: 5)
GCP_PROJECT="..."          # For deployment
GCP_REGION="..."           # For deployment (default: australia-southeast2)
```

## Monitoring

### Success Metrics

```
✅ Success: 2,100+ stocks synced
⚠️  No data: <100 (delisted/suspended stocks)
❌ Failed: <50 (API errors, network issues)
📊 Records: ~11,000 (for 5-day sync)
```

### Alerts

Set up alerts for:
- Job failure (exit code != 0)
- Success rate < 90%
- Duration > 15 minutes
- No execution in 25 hours

## Troubleshooting

### No data for specific stock

```bash
# Check if stock exists in ASX list
grep "RMX" analysis/data/ASX_Listed_Companies_*.csv

# Check database
psql $DATABASE_URL -c "SELECT COUNT(*), MIN(date), MAX(date) FROM stock_prices WHERE stock_code = 'RMX';"

# Test Yahoo Finance directly
python3 -c "
import yfinance as yf
ticker = yf.Ticker('RMX.AX')
print(ticker.history(period='5d'))
"
```

### Rate limiting

Yahoo Finance has soft rate limits:
- ~2,000 requests/hour without issues
- Script uses 0.3s delay (10,800 req/hour theoretical)
- Batches of 50 stocks for monitoring

### Database connection issues

```bash
# Test connection
python3 -c "
import asyncpg, asyncio
asyncio.run(asyncpg.connect('$DATABASE_URL'))
print('✅ Connected')
"
```

## Local Development

```bash
# Install dependencies
make install

# Test database connection
make test

# Run initial population (test with small dataset first)
export DATABASE_URL="..."
python3 populate_all_asx_from_csv.py

# Run daily sync
python3 daily_historical_sync.py
```

## Production Deployment

```bash
# 1. One-time: Populate 10 years of data
make populate-all-stocks

# 2. Deploy daily sync job
export DATABASE_URL="..."
export GCP_PROJECT="shorted-dev-aba5688f"
make deploy-daily-sync

# 3. Verify deployment
gcloud run jobs describe daily-historical-sync \
  --region australia-southeast2 \
  --project shorted-dev-aba5688f

# 4. Check scheduler
gcloud scheduler jobs describe daily-historical-sync-trigger \
  --location australia-southeast2 \
  --project shorted-dev-aba5688f
```

## Cost Estimation

### Storage
- ~2.8M records × 100 bytes = 280 MB
- PostgreSQL storage: ~$0.17/GB/month = **$0.05/month**

### Cloud Run Job
- Daily execution: ~10 minutes
- Memory: 2Gi
- Free tier: 180,000 vCPU-seconds/month
- **Cost: Free** (well within free tier)

### Data Transfer
- Yahoo Finance API: Free
- No egress charges (same region)

**Total: ~$0.05/month**

## Testing

```bash
# Unit tests (with mocks)
make test-unit

# Integration tests (requires DATABASE_URL)
export DATABASE_URL="..."
make test-integration

# Test locally
make test-local
```

## Support

For issues or questions:
- Check logs: `gcloud logging read ...`
- Test locally: `make daily-sync`
- Verify data: Query `stock_prices` table
- Check ASX list: `analysis/data/ASX_Listed_Companies_*.csv`
