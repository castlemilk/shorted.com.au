# Historical Data Backfill Tool

A local command-line tool to backfill historical stock price data for ASX stocks.

## Purpose

This tool is designed to be run **locally** (not in production) to populate historical data once. After the initial backfill, the production `market-data-sync` service handles incremental daily updates.

## Usage

### Basic Usage

```bash
cd services/market-data-sync
go run ./cmd/historical-backfill \
  -years=10 \
  -limit=0 \
  -priority-only=false \
  -skip-existing=true
```

### Options

- `-years`: Number of years of historical data to fetch (default: 10)
- `-limit`: Limit number of stocks to process (0 = all, useful for testing)
- `-priority-only`: Only sync priority (top shorted) stocks
- `-force`: Force re-fetch even if data exists (ignores database state)
- `-symbol`: Process only this specific stock symbol (e.g., DMP). If provided, ignores other filters.

### Examples

**Backfill all stocks with 10 years of data:**
```bash
export DATABASE_URL="postgresql://user:pass@host:port/db"
export GCS_BUCKET_NAME="shorted-short-selling-data"
export GOOGLE_APPLICATION_CREDENTIALS="path/to/creds.json"

go run ./cmd/historical-backfill -years=10
```

**Test with 10 stocks, 2 years:**
```bash
go run ./cmd/historical-backfill -years=2 -limit=10
```

**Backfill only priority stocks:**
```bash
go run ./cmd/historical-backfill -years=10 -priority-only=true
```

**Force re-fetch even if data exists:**
```bash
go run ./cmd/historical-backfill -years=10 -force
```

**Process a specific stock (e.g., to fix data quality issues):**
```bash
go run ./cmd/historical-backfill -symbol=DMP -years=10
```

## Environment Variables

- `DATABASE_URL`: PostgreSQL connection string (required)
- `GCS_BUCKET_NAME`: GCS bucket name (default: "shorted-data")
- `GOOGLE_APPLICATION_CREDENTIALS`: Path to GCP service account JSON (optional, for GCS)
- `LOCAL_ASX_CSV`: Path to local CSV file instead of GCS (optional, recommended for local runs)
- `ALPHA_VANTAGE_API_KEY`: Alpha Vantage API key (optional, for fallback)

### Using Local CSV File

For local runs, it's recommended to use a local CSV file instead of GCS:

```bash
export LOCAL_ASX_CSV="../../analysis/data/ASX_Listed_Companies_07-04-2024_11-03-45_AEST.csv"
```

Or from the services directory:
```bash
export LOCAL_ASX_CSV="../analysis/data/ASX_Listed_Companies_07-04-2024_11-03-45_AEST.csv"
```

**Fallback:** If GCS/local CSV fails, the tool will automatically fall back to fetching stock codes from the database (stocks that already have price data).

## Rate Limiting

The tool respects rate limits:
- **Yahoo Finance**: 4 seconds between requests
- **Alpha Vantage**: 12 seconds between requests

For 1858 stocks with 10 years of data:
- **Estimated time**: ~2-3 hours
- **Rate**: ~15 stocks/minute

## Output

The tool provides progress updates:
- Every stock: Shows fetch status and records inserted
- Every 10 stocks: Summary progress
- Final summary: Total stocks, successful, failed, records

## When to Use

1. **Initial Setup**: Populate database with historical data for the first time
2. **Gap Filling**: Fill gaps in historical data for specific stocks
3. **Recovery**: Re-fetch data if there were issues with previous syncs
4. **Testing**: Test data providers with a small subset of stocks

## After Backfill

Once historical data is populated, the production `market-data-sync` service will:
- Sync only new data (incremental updates)
- Run daily via Cloud Scheduler
- Handle rate limiting automatically
- Update checkpoint tracking

## Troubleshooting

**No data for stock:**
- Check if stock exists on Yahoo Finance
- Verify stock code format (should be ASX code, e.g., "BHP" not "BHP.AX")
- Check date range - some stocks may not have 10 years of data

**Rate limit errors:**
- The tool automatically waits between requests
- If you see errors, increase delays in provider code

**Database connection errors:**
- Verify DATABASE_URL is correct
- Check network connectivity
- Ensure database allows connections from your IP
