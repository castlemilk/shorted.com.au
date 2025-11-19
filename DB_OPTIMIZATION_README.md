# Database Optimization Guide

## Overview

The database optimization script (`scripts/optimize-database.py`) performs a comprehensive optimization of your PostgreSQL database by:

1. **Applying Performance Indexes** - Creates critical indexes for fast queries
2. **Updating Statistics** - Runs ANALYZE to update query planner statistics
3. **Validating Optimizations** - Tests query performance to ensure improvements

## Quick Start

### Prerequisites

1. **Python 3.7+** with `asyncpg` installed:
   ```bash
   pip install asyncpg
   # or
   pip install -r scripts/requirements.txt
   ```

2. **Database Connection String**:
   ```bash
   export DATABASE_URL="postgresql://user:password@host:port/database"
   # or
   export SUPABASE_DB_URL="postgresql://user:password@host:port/database"
   ```

### Running Optimization

```bash
# Full optimization (recommended)
make db-optimize-full

# Or run directly
python3 scripts/optimize-database.py
```

## What Gets Optimized

### Indexes Created

1. **`idx_shorts_date_product_percent`** - Composite index for date filtering with product and percentage
2. **`idx_company_metadata_stock_industry`** - Optimizes joins and industry partitioning
3. **`idx_shorts_date_desc_only`** - Specialized index for MAX(DATE) queries
4. **`idx_shorts_percent_date`** - Partial index for percentage-based filtering
5. **`idx_shorts_timeseries_covering`** - Covering index for time series queries
6. **`idx_shorts_product_date_for_windows`** - Optimized for window function queries

### Statistics Updated

- `ANALYZE shorts` - Updates statistics for shorts table
- `ANALYZE "company-metadata"` - Updates statistics for company-metadata table

## Validation Tests

The script runs three validation tests:

1. **Index Verification** - Checks that all required indexes exist
2. **Query Performance** - Tests actual query execution times:
   - Top Shorts Query: Should complete in < 1 second
   - Stock Detail Query: Should complete in < 0.5 seconds
3. **Table Statistics** - Reports table and index sizes

## Expected Output

```
🚀 Starting database optimization...
📅 2025-01-15 10:30:00

🔌 Connecting to database...
✅ Connected successfully

================================================================================
⚡ STEP 1: APPLYING PERFORMANCE INDEXES
================================================================================
📝 Reading migration file: supabase/migrations/003_add_performance_indexes.sql
⚡ Creating performance indexes...
✅ Indexes created successfully

🔍 Verifying indexes...
✅ Found 6 performance indexes on 'shorts' table:
  - idx_shorts_date_product_percent (256 kB)
  - idx_shorts_percent_date (128 kB)
  ...

================================================================================
📊 STEP 2: UPDATING DATABASE STATISTICS
================================================================================
📈 Running ANALYZE on 'shorts' table...
✅ ANALYZE completed for 'shorts'
📈 Running ANALYZE on 'company-metadata' table...
✅ ANALYZE completed for 'company-metadata'

================================================================================
✅ STEP 3: VALIDATING OPTIMIZATIONS
================================================================================
🔍 Test 1: Verifying indexes exist...
✅ All required indexes exist (6/6)

🔍 Test 2: Testing query performance...
  Testing: Top Shorts Query...
  ✅ Query uses indexes (Index Scan detected)
  ✅ Query completed in 0.234s (target: <1.0s)

🎉 Database optimization completed successfully!
✅ All optimizations applied and validated
```

## Troubleshooting

### "ModuleNotFoundError: No module named 'asyncpg'"

```bash
pip install asyncpg
# or
pip install -r scripts/requirements.txt
```

### "DATABASE_URL environment variable is required"

```bash
export DATABASE_URL="postgresql://user:password@host:port/database"
```

### "Failed to connect"

- Verify your database connection string is correct
- Check that your database is accessible from your network
- For Supabase, use the direct connection string (not the pooler)

### Queries Still Slow After Optimization

1. Check if indexes are being used:
   ```bash
   make db-diagnose
   ```

2. Verify table statistics are up to date:
   ```sql
   SELECT last_analyze FROM pg_stat_user_tables WHERE tablename = 'shorts';
   ```

3. Manually run ANALYZE if needed:
   ```sql
   ANALYZE shorts;
   ANALYZE "company-metadata";
   ```

## Production Deployment

When deploying to production:

1. **Set Production DATABASE_URL**:
   ```bash
   export DATABASE_URL="postgresql://prod_user:prod_pass@prod_host:5432/prod_db"
   ```

2. **Run Optimization**:
   ```bash
   make db-optimize-full
   ```

3. **Verify Success**:
   - All validation tests should pass ✅
   - Query times should be < 1 second ✅
   - No warnings in output ✅

## Related Commands

- `make db-diagnose` - Diagnose performance issues without making changes
- `make db-optimize` - Apply indexes only (without validation)
- `make db-analyze` - Update statistics only

## Notes

- The optimization script is **idempotent** - safe to run multiple times
- Indexes are created with `IF NOT EXISTS` - won't fail if already present
- ANALYZE is safe to run on production (doesn't lock tables)
- Validation tests use EXPLAIN ANALYZE (runs actual queries)



