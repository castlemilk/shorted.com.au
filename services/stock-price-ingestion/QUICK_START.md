# Stock Price Ingestion - Quick Start Guide

## Prerequisites

Set the DATABASE_URL environment variable:

```bash
export DATABASE_URL="postgresql://postgres.xivfykscsdagwsreyqgf:661wMKAq9zdZpDk2@aws-0-ap-southeast-2.pooler.supabase.com:5432/postgres"
```

Or add to your shell profile (~/.zshrc or ~/.bashrc):

```bash
echo 'export DATABASE_URL="postgresql://postgres.xivfykscsdagwsreyqgf:661wMKAq9zdZpDk2@aws-0-ap-southeast-2.pooler.supabase.com:5432/postgres"' >> ~/.zshrc
source ~/.zshrc
```

## Common Commands

### Check Data Coverage

```bash
cd services/stock-price-ingestion
make db-check-coverage
```

### List Missing Stocks

```bash
make db-list-missing
```

### Sync a Single Stock

```bash
make sync-single STOCK=RMX
```

### Backfill All Missing Stocks

```bash
make backfill-missing
# Will ask for confirmation before proceeding
```

### Check Deployment Status

```bash
make check-deployment
```

## Troubleshooting

### "No such file or directory" error with psql

Make sure DATABASE_URL is set:

```bash
echo $DATABASE_URL
```

### GSSAPI Connection Errors

The Makefile handles this automatically with `PGGSSENCMODE=disable`.

### Rate Limiting from Yahoo Finance

The backfill script adds 0.5s delay between stocks. If you hit rate limits, wait a few minutes and retry.

## Manual Database Queries

```bash
# Check a specific stock
PGGSSENCMODE=disable psql "$DATABASE_URL" -c "
  SELECT stock_code, COUNT(*) as data_points,
         MIN(date) as earliest, MAX(date) as latest
  FROM stock_prices
  WHERE stock_code = 'RMX'
  GROUP BY stock_code;
"

# Check recent updates
PGGSSENCMODE=disable psql "$DATABASE_URL" -c "
  SELECT stock_code, MAX(date) as latest_date
  FROM stock_prices
  GROUP BY stock_code
  ORDER BY latest_date DESC
  LIMIT 10;
"
```

## See Also

- Main documentation: `README.md`
- Investigation summary: `../../STOCK_DATA_SYNC_INVESTIGATION.md`
- Makefile help: `make help`
