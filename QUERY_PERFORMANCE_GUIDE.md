# Query Performance Troubleshooting Guide

## Issue: Slow Treemap and Top Shorts Queries

If you're experiencing slow query performance for the treemap or top shorts features, follow this guide to diagnose and fix the issue.

## Quick Fix

1. **Run the diagnostic script to identify the problem:**
   ```bash
   cd /Users/benebsworth/projects/shorted
   python3 scripts/diagnose-slow-queries.py
   ```

2. **Apply missing performance indexes:**
   ```bash
   python3 scripts/apply-performance-indexes.py
   ```

## What Indexes Were Added

The `003_add_performance_indexes.sql` migration adds the following critical indexes:

### For Treemap Queries
- `idx_shorts_date_product_percent` - Composite index for date filtering with product code and percentage
- `idx_shorts_product_date_for_windows` - Optimized for window function queries (PARTITION BY, ROW_NUMBER)
- `idx_company_metadata_stock_industry` - Optimizes joins between shorts and company-metadata tables

### For Top Shorts Queries  
- `idx_shorts_timeseries_covering` - Covering index that includes all columns needed for time series queries
- `idx_shorts_percent_date` - Partial index for percentage-based filtering

### General Performance
- `idx_shorts_date_desc_only` - Specialized index for `MAX(DATE)` queries

## Query Patterns Optimized

### 1. Treemap Queries

**Current Shorts View:**
```sql
WITH latest_short_positions AS (
    SELECT "PRODUCT_CODE", MAX("DATE") AS max_date
    FROM shorts
    WHERE "DATE" >= (SELECT MAX("DATE") FROM shorts) - INTERVAL '3 months'
    GROUP BY "PRODUCT_CODE"
),
ranked_stocks AS (
    SELECT 
        cm.industry,
        csp."PRODUCT_CODE",
        ROW_NUMBER() OVER (PARTITION BY cm.industry ORDER BY current_short_position DESC) AS rank
    FROM current_short_positions csp
    JOIN "company-metadata" cm ON csp."PRODUCT_CODE" = cm.stock_code
)
SELECT * FROM ranked_stocks WHERE rank <= 10
```

**Percentage Change View:**
```sql
WITH period_data AS (
    SELECT 
        "PRODUCT_CODE",
        ROW_NUMBER() OVER (PARTITION BY "PRODUCT_CODE" ORDER BY "DATE" DESC) AS rnk_desc,
        ROW_NUMBER() OVER (PARTITION BY "PRODUCT_CODE" ORDER BY "DATE" ASC) AS rnk_asc
    FROM shorts
    WHERE "DATE" >= (SELECT MAX("DATE") FROM shorts) - INTERVAL '3 months'
)
-- Calculate percentage change and rank by industry
```

### 2. Top Shorts Queries

```sql
WITH latest_shorts AS (
    SELECT "PRODUCT_CODE", "PRODUCT", "PERCENT_..."
    FROM shorts, (SELECT MAX("DATE") as latest_date FROM shorts) max_date
    WHERE "DATE" = max_date.latest_date
      AND "PERCENT_..." > 0
)
SELECT * FROM latest_shorts
ORDER BY "PERCENT_..." DESC
LIMIT 10
```

## Performance Metrics

After applying the indexes, you should see:

- **Treemap queries**: < 500ms (previously could be 5-10+ seconds)
- **Top shorts queries**: < 300ms (previously could be 2-5+ seconds)
- **Search queries**: < 100ms (previously could be 1-2 seconds)

## Monitoring Query Performance

### Using EXPLAIN ANALYZE

To see how PostgreSQL executes a query:

```sql
EXPLAIN ANALYZE
<your query here>
```

Look for:
- **Seq Scan** (bad) vs **Index Scan** (good)
- High **cost** numbers
- **Planning time** and **Execution time**

### Check Index Usage

```sql
SELECT 
    schemaname,
    tablename,
    indexname,
    idx_scan as index_scans,
    idx_tup_read as tuples_read,
    idx_tup_fetch as tuples_fetched
FROM pg_stat_user_indexes
WHERE tablename IN ('shorts', 'company-metadata')
ORDER BY idx_scan DESC;
```

### Table Statistics

Make sure your table statistics are up to date:

```sql
-- Check last analyze time
SELECT 
    schemaname,
    tablename,
    last_analyze,
    last_autoanalyze
FROM pg_stat_user_tables
WHERE tablename IN ('shorts', 'company-metadata');

-- If statistics are stale, run:
ANALYZE shorts;
ANALYZE "company-metadata";
```

## Common Issues

### Issue: Indexes exist but queries are still slow

**Solution**: Update table statistics
```sql
ANALYZE shorts;
ANALYZE "company-metadata";
```

### Issue: Sequential scans despite having indexes

**Possible causes:**
1. Statistics are outdated (run ANALYZE)
2. Query doesn't match index columns
3. Table is too small (PostgreSQL might choose seq scan for small tables)
4. Index bloat (consider REINDEX)

### Issue: High memory usage during queries

**Solution**: The window function queries can be memory-intensive. Check:
```sql
SHOW work_mem;  -- Should be at least 4MB, ideally 16MB+
```

## Files Created

- **Migration**: `supabase/migrations/003_add_performance_indexes.sql`
- **Apply Script**: `scripts/apply-performance-indexes.py`
- **Diagnostic Tool**: `scripts/diagnose-slow-queries.py`
- **This Guide**: `QUERY_PERFORMANCE_GUIDE.md`

## Database Connection

The scripts expect one of these environment variables:
- `DATABASE_URL` - Standard PostgreSQL connection string
- `SUPABASE_DB_URL` - Supabase-specific connection string

Example:
```bash
export DATABASE_URL="postgresql://user:password@host:5432/database"
```

## Additional Resources

- PostgreSQL Index Documentation: https://www.postgresql.org/docs/current/indexes.html
- Query Performance Tuning: https://www.postgresql.org/docs/current/performance-tips.html
- Window Functions: https://www.postgresql.org/docs/current/tutorial-window.html

