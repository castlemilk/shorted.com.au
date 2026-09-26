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

# Daily ASIC shorts sync (prices are `shorted market-data sync`)
make short-data-sync-local

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

The daily sync ingests ASIC short positions. Stock prices are a SEPARATE
job (`shorted market-data sync`, the weekday `market-data-sync` scheduler):

```bash
# Run locally
make short-data-sync-local

# Dry run with a parity summary (writes nothing)
make short-data-sync-shadow

# Execute the Cloud Run job manually
make short-data-sync-execute

# View logs
make short-data-sync-logs
```

Deployment is CI-driven: `.github/workflows/terraform-deploy.yml` builds the
`shorted-jobs` image and `terraform/modules/short-data-sync` owns the job.

### Daily Sync Configuration

The sync is `shorted short-data-sync` (`services/jobs/internal/jobs/shortdatasync/`) and runs:

1. **ASIC Sync**: Downloads each newly published short position CSV (`MAX("DATE") + 1 → today`)
2. **Reconcile**: Re-checks the last 20 published dates plus a rotating 1/28 of the archive against ASIC's current files, and writes what is missing or changed
3. **MV refresh + frontend revalidation**
4. **Algolia Sync**: Updates search index (optional, off in prod)

Stock prices are not part of this job — see above.

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
   make short-data-sync-logs
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

### Short Data Wrong or Missing on Past Dates (a stock's history "stops", has holes, or disagrees with ASIC)

The live API can be current while past dates are short or stale. The forward
window (`MAX("DATE") + 1 → today`) never revisits a date once any row of it
lands, and ASIC republishes corrected files (index version `002`, `010`…)
that nothing used to re-read. Every run now ends with a reconcile pass. It
re-checks the last 20 published dates plus a rotating 1/28 of the whole
archive, so every date since 2010 is re-verified every four weeks, and writes
only the rows that are missing or changed. It never deletes: rows ASIC's
current files no longer carry are named in the run log and in a range run's
report (`extra_rows`, code as stored plus values) for a person to decide
about. To heal
everything now, run the whole archive once: preview with `-dry-run`, then run
it live. With no local credentials, run the **Shorts Data Repair** GitHub
workflow (`from = 2010-01-01`, dry run first). With `gcloud`:

```bash
gcloud run jobs execute shorts-data-sync \
  --project=rosy-clover-477102-t5 --region=australia-southeast2 \
  --args=short-data-sync,-dry-run,-reconcile-from,2010-01-01 --task-timeout=2h --wait   # then drop -dry-run
```

To measure it without DB access, compare `get_market_snapshot`'s `total_count`
(public MCP at `https://api.shorted.com.au/mcp`; it counts rows with percent > 0)
or `get_stock_history` at `full_resolution` with the file the index lists for
that date: `https://download.asic.gov.au/short-selling/RR<yyyymmdd>-<version>-SSDailyAggShortPos.csv`.
Never assume version `001`: 345 dates have been republished. Full runbook:
`services/jobs/internal/jobs/shortdatasync/README.md` §Reconcile.

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

