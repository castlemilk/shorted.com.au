# Quick Start: Multi-Provider Stock Data Ingestion

## 🚀 Get Started in 3 Steps!

### Prerequisites

1. **Get a free Alpha Vantage API key** (30 seconds)

   - Visit: https://www.alphavantage.co/support/#api-key
   - Enter your email
   - Get instant API key (no credit card required)

2. **Set the API key as an environment variable**
   ```bash
   export ALPHA_VANTAGE_API_KEY='your_api_key_here'
   ```

The service provides:

- ✅ Alpha Vantage as primary provider (better data quality)
- ✅ Automatic fallback to Yahoo Finance
- ✅ No code changes needed!

## Local Development

### 1. Set Your API Key

**Option A: Using .env file (Recommended)**

```bash
cd services/stock-price-ingestion

# Copy the example file
cp env.example .env

# Edit .env and add your API key
# ALPHA_VANTAGE_API_KEY=your_api_key_here
```

**Option B: Using environment variable**

```bash
# Get your free key from: https://www.alphavantage.co/support/#api-key
export ALPHA_VANTAGE_API_KEY='your_api_key_here'
```

### 2. Start the Database

```bash
cd /path/to/shorted
make dev-db
```

### 3. Run Historical Data Backfill

```bash
cd services
make history.stock-data.backfill
```

That's it! The service will:

1. Try to fetch from Alpha Vantage first (better data quality)
2. Automatically fall back to Yahoo Finance if needed
3. Populate your local database with historical price data

## What You'll See

### Successful Alpha Vantage Fetch

```
✅ Primary provider initialized: Alpha Vantage
✅ Fallback provider initialized: Yahoo Finance
🔄 Trying primary provider (Alpha Vantage) for CBA...
✅ Primary provider success for CBA: 2500 records
```

### Automatic Fallback to Yahoo Finance

```
🔄 Trying primary provider (Alpha Vantage) for BOE...
⚠️ Primary provider rate limit exceeded for BOE
🔄 Falling back to Yahoo Finance for BOE...
✅ Fallback provider success for BOE: 2500 records
```

## Check Your Data

After the backfill completes, verify the data:

```bash
# Check how many stocks now have price data
psql "postgresql://admin:password@localhost:5438/shorts" -c "
SELECT COUNT(DISTINCT stock_code) as stocks_with_data
FROM stock_prices;"

# Check specific stock
psql "postgresql://admin:password@localhost:5438/shorts" -c "
SELECT stock_code, MIN(date) as earliest, MAX(date) as latest, COUNT(*) as records
FROM stock_prices
WHERE stock_code = 'BOE'
GROUP BY stock_code;"
```

## Advanced Usage

### Use Only Alpha Vantage

```python
from main import StockDataIngestion

ingestion = StockDataIngestion(
    db_url="your_db_url",
    primary_provider="alpha_vantage",
    fallback_provider="none"  # Disable fallback
)
```

### Use Only Yahoo Finance

```python
ingestion = StockDataIngestion(
    db_url="your_db_url",
    primary_provider="yahoo_finance",
    fallback_provider="none"
)
```

### Custom API Key

```bash
export ALPHA_VANTAGE_API_KEY="your_custom_key"
cd services
make history.stock-data.backfill
```

## Provider Comparison

| Feature          | Alpha Vantage             | Yahoo Finance   |
| ---------------- | ------------------------- | --------------- |
| **Rate Limit**   | 5/min, 500/day            | More permissive |
| **Data Quality** | High (exchange-licensed)  | Good            |
| **API Key**      | Required (pre-configured) | Not required    |
| **Coverage**     | Global markets            | Broad coverage  |
| **Reliability**  | Very high                 | High            |
| **Cost**         | Free tier available       | Free            |

## Troubleshooting

### "Primary provider not configured"

This means the Alpha Vantage API key is not set. Get your free key and set it:

```bash
# Get free key from: https://www.alphavantage.co/support/#api-key
export ALPHA_VANTAGE_API_KEY='your_key_here'
```

### "Both providers failed"

Check your internet connection and that the stock symbol is valid:

```bash
# Test with a known good symbol
python -c "
import asyncio
from main import StockDataIngestion
from datetime import date, timedelta

async def test():
    ing = StockDataIngestion('postgresql://admin:password@localhost:5438/shorts')
    await ing.init_db()
    df = await ing.fetch_stock_data_with_fallback('CBA', date(2024, 1, 1), date.today())
    print(f'Got {len(df)} records')
    await ing.close_db()

asyncio.run(test())
"
```

### Rate Limits

- **Alpha Vantage Free Tier**: 5 requests/minute, 500/day
- **Solution**: The automatic fallback to Yahoo Finance kicks in
- **Optimization**: Run backfills during off-peak hours

## Production Deployment

The service is ready for production with Cloud Run:

```bash
# Store your API key in Secret Manager
gcloud secrets create ALPHA_VANTAGE_API_KEY \
  --data-file=<(echo "your_api_key_here") \
  --project=shorted-dev-aba5688f

# Deploy service
cd services/stock-price-ingestion
make deploy
```

The automated Cloud Scheduler jobs will handle daily updates using both providers with automatic fallback!
