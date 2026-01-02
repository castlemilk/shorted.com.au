---
name: data-sync
description: Manage data population and synchronization for ASIC short data and stock prices. Use when populating the database, syncing data, or troubleshooting data issues.
allowed-tools: Read, Write, Bash(make:*), Bash(python*), Bash(psql:*), Grep, Glob
---

# Data Synchronization

This skill guides you through data population and synchronization workflows for the Shorted project.

## Quick Reference

```bash
# Full data population (downloads ASIC files + processes)
make populate-data

# Quick population (uses existing CSV files)
make populate-data-quick

# Daily sync (ASIC shorts + stock prices)
make daily-sync-local

# Sync Algolia search index
make algolia-sync
```

## Data Sources

| Data Type | Source | Frequency | Location |
|-----------|--------|-----------|----------|
| Short positions | ASIC CSV files | Daily | `services/data/shorts/` |
| Stock prices | Yahoo Finance / Alpha Vantage | Daily | Database `stock_prices` table |
| Company metadata | GPT-4 enrichment | On-demand | Database `company-metadata` table |

## ASIC Short Data Population

### Full Population (First Time)

Downloads ~3,500 CSV files from ASIC and populates the database:

```bash
make populate-data
```

This takes 30-60 minutes and:
1. Downloads all historical ASIC CSV files
2. Parses and validates the data
3. Inserts into the `shorts` table

### Quick Population (Existing Files)

If CSV files already exist in `services/data/shorts/`:

```bash
make populate-data-quick
```

### Force Re-download

```bash
cd services && make populate-data-force
```

## Stock Price Data

### Historical Backfill

```bash
# Test with 10 stocks, 1 year
cd services && make history.stock-data.backfill-test

# Standard backfill (all stocks, 2 years)
cd services && make history.stock-data.backfill

# Full backfill (all stocks, 5 years)
cd services && make history.stock-data.backfill-full
```

### Repair Data Gaps

```bash
# Check for gaps
make repair-gaps-dry-run

# Repair specific stocks
make repair-gaps STOCKS=CBA,BHP

# Repair all stocks with insufficient data
make repair-gaps-all
```

### Check Status

```bash
cd services && make history.stock-data.status
```

## Daily Sync Pipeline

The daily sync updates both short positions and stock prices:

```bash
# Run locally
make daily-sync-local

# Deploy to Cloud Run (scheduled job)
make daily-sync-deploy

# Execute Cloud Run job manually
make daily-sync-execute

# View logs
make daily-sync-logs
```

### Daily Sync Configuration

The sync is configured in `services/daily-sync/` and runs:

1. **ASIC Sync**: Downloads latest short position CSV
2. **Stock Price Sync**: Updates prices for all tracked stocks
3. **Algolia Sync**: Updates search index (optional)

## Algolia Search Index

### Sync Search Index

```bash
# Sync with local database
make algolia-sync

# Sync with production database
make algolia-sync-prod
```

### Test Search

```bash
make algolia-search Q=BHP
```

## Company Metadata Enrichment

Enrich company data using GPT-4:

```bash
# Enrich 10 companies (for testing)
make enrich-metadata LIMIT=10

# Enrich specific stocks
make enrich-metadata-stocks STOCKS="CBA BHP WBC"

# Enrich all (expensive!)
make enrich-metadata-all
```

## Full Data Pipeline

Run the complete pipeline:

```bash
# Local: enrich + sync Algolia
make pipeline-local

# Production: full pipeline
make pipeline-prod

# Daily: ASIC sync + Algolia
make pipeline-daily
```

## Database Verification

### Check Short Data

```sql
-- Total records
SELECT COUNT(*) FROM shorts;

-- Unique stocks
SELECT COUNT(DISTINCT "PRODUCT_CODE") FROM shorts;

-- Date range
SELECT MIN("DATE")::date, MAX("DATE")::date FROM shorts;

-- Top 10 by record count
SELECT "PRODUCT_CODE", COUNT(*) 
FROM shorts 
GROUP BY "PRODUCT_CODE" 
ORDER BY COUNT(*) DESC 
LIMIT 10;
```

### Check Stock Prices

```sql
-- Total records
SELECT COUNT(*) FROM stock_prices;

-- Date range
SELECT MIN(date), MAX(date) FROM stock_prices;

-- Stocks with most data
SELECT stock_code, COUNT(*) as records
FROM stock_prices
GROUP BY stock_code
ORDER BY records DESC
LIMIT 10;
```

### Check Company Metadata

```sql
-- Companies with enriched data
SELECT COUNT(*) FROM "company-metadata" 
WHERE description IS NOT NULL;

-- Companies missing logos
SELECT stock_code, name 
FROM "company-metadata" 
WHERE logo_url IS NULL 
LIMIT 20;
```

## Troubleshooting

### Data Not Loading

1. Check database connection:
   ```bash
   make dev-db
   docker ps  # Verify container is running
   ```

2. Verify CSV files exist:
   ```bash
   ls -la services/data/shorts/ | head -20
   ```

3. Check for errors in logs:
   ```bash
   # If using daily-sync
   make daily-sync-logs
   ```

### Stale Data

```bash
# Force re-download
cd services && make populate-data-force

# Or delete and re-populate
psql postgresql://admin:password@localhost:5438/shorts \
  -c "TRUNCATE shorts RESTART IDENTITY;"
make populate-data
```

### Missing Stock Prices

```bash
# Check which stocks are missing
cd services && make history.stock-data.status

# Backfill specific stocks
make repair-gaps STOCKS=CBA,BHP,CSL
```

### Performance Issues

```bash
# Diagnose slow queries
make db-diagnose

# Apply performance indexes
make db-optimize

# Update statistics
psql postgresql://admin:password@localhost:5438/shorts \
  -c "ANALYZE shorts; ANALYZE \"company-metadata\";"
```

## Environment Variables

Required for data sync operations:

```bash
# Database (auto-set for local dev)
DATABASE_URL=postgresql://admin:password@localhost:5438/shorts

# For stock price APIs
ALPHA_VANTAGE_API_KEY=your_key_here

# For Algolia sync
ALGOLIA_APP_ID=1BWAPWSTDD
ALGOLIA_ADMIN_KEY=your_admin_key

# For GPT-4 enrichment
OPENAI_API_KEY=sk-...
```

