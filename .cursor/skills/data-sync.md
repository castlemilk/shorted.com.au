# Data Sync

Manage data population and synchronization for ASIC short data and stock prices. Use when populating the database, syncing data, or troubleshooting data issues.

## Quick Commands

```bash
# Full data population (downloads ASIC files)
make populate-data

# Quick population (existing CSV files)
make populate-data-quick

# Daily sync (ASIC shorts + stock prices)
make daily-sync-local

# Sync Algolia search index
make algolia-sync

# Stock price backfill
cd services && make history.stock-data.backfill
```

## Instructions

### ASIC Short Data

```bash
# First time (downloads ~3,500 CSV files)
make populate-data

# With existing files
make populate-data-quick

# Force re-download
cd services && make populate-data-force
```

### Stock Price Backfill

```bash
# Test (10 stocks, 1 year)
cd services && make history.stock-data.backfill-test

# Standard (all stocks, 2 years)
cd services && make history.stock-data.backfill

# Full (all stocks, 5 years)
cd services && make history.stock-data.backfill-full
```

### Repair Data Gaps

```bash
# Check for gaps
make repair-gaps-dry-run

# Repair specific stocks
make repair-gaps STOCKS=CBA,BHP

# Repair all
make repair-gaps-all
```

### Algolia Search

```bash
# Sync local
make algolia-sync

# Sync production
make algolia-sync-prod

# Test search
make algolia-search Q=BHP
```

### Company Enrichment

```bash
# Enrich 10 companies
make enrich-metadata LIMIT=10

# Specific stocks
make enrich-metadata-stocks STOCKS="CBA BHP WBC"
```

## Verify Data

```sql
-- Short data
SELECT COUNT(*) FROM shorts;
SELECT COUNT(DISTINCT "PRODUCT_CODE") FROM shorts;

-- Stock prices
SELECT COUNT(*) FROM stock_prices;
SELECT MIN(date), MAX(date) FROM stock_prices;

-- Company metadata
SELECT COUNT(*) FROM "company-metadata" WHERE description IS NOT NULL;
```

## Environment Variables

```bash
DATABASE_URL=postgresql://admin:password@localhost:5438/shorts
ALGOLIA_APP_ID=1BWAPWSTDD
ALGOLIA_ADMIN_KEY=your_key
OPENAI_API_KEY=sk-...  # For enrichment
```

