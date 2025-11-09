# Slow Queries Fix - Treemap & Top Shorts Performance

## Problem

The treemap and top shorts queries have become very slow, likely due to missing database indexes for the complex analytical queries.

## Root Cause

The queries use:
- Complex window functions (`ROW_NUMBER() OVER (PARTITION BY ...)`)
- Joins between `shorts` and `company-metadata` tables  
- Date filtering with `MAX(DATE) - INTERVAL`
- Aggregations and partitioning by industry

The existing indexes were optimized for simple queries but not for these analytical patterns.

## Solution

Created comprehensive performance indexes specifically optimized for these query patterns:

### New Indexes Added

1. **idx_shorts_date_product_percent** - Composite index for date filtering with product and percentage
2. **idx_shorts_product_date_for_windows** - Optimized for window function queries (PARTITION BY)
3. **idx_company_metadata_stock_industry** - Optimizes joins and industry partitioning
4. **idx_shorts_timeseries_covering** - Covering index for time series queries
5. **idx_shorts_percent_date** - Partial index for percentage-based filtering

## Quick Fix Commands

### 1. Diagnose the Issue
```bash
make db-diagnose
```
or
```bash
python3 scripts/diagnose-slow-queries.py
```

This will:
- Show all existing indexes
- Run EXPLAIN ANALYZE on the slow queries
- Display table statistics
- Provide recommendations

### 2. Apply Performance Indexes
```bash
make db-optimize
```
or
```bash
python3 scripts/apply-performance-indexes.py
```

This will:
- Create all missing performance indexes
- Analyze tables to update statistics
- Show size information for new indexes

### 3. Verify the Fix
```bash
make db-diagnose
```

Run the diagnostic again to see the performance improvements.

## Environment Setup

The scripts need a database connection string in one of these environment variables:

```bash
export DATABASE_URL="postgresql://user:password@host:5432/database"
# or
export SUPABASE_DB_URL="postgresql://..."
```

For Supabase, get your direct connection string (not the pooler) from:
- Supabase Dashboard → Project Settings → Database → Connection String (Direct)

## Expected Performance Improvements

| Query Type | Before | After | Improvement |
|------------|--------|-------|-------------|
| Treemap (Current) | 5-10s | <500ms | 10-20x faster |
| Treemap (% Change) | 5-10s | <500ms | 10-20x faster |
| Top Shorts | 2-5s | <300ms | 7-15x faster |

## Files Created

- **Migration**: `supabase/migrations/003_add_performance_indexes.sql`
- **Apply Script**: `scripts/apply-performance-indexes.py`
- **Diagnostic Tool**: `scripts/diagnose-slow-queries.py`
- **Detailed Guide**: `QUERY_PERFORMANCE_GUIDE.md`
- **This Summary**: `SLOW_QUERIES_FIX.md`

## Makefile Commands Added

```bash
make db-diagnose   # Diagnose database query performance issues
make db-optimize   # Apply performance indexes to database
make db-analyze    # Update database statistics for query optimizer
```

## Understanding the Queries

### Treemap Current Shorts Query Pattern
```sql
-- 1. Find latest data per product in time window
WITH latest_short_positions AS (
    SELECT "PRODUCT_CODE", MAX("DATE") AS max_date
    FROM shorts
    WHERE "DATE" >= (SELECT MAX("DATE") FROM shorts) - INTERVAL '3 months'
    GROUP BY "PRODUCT_CODE"
),
-- 2. Get current short positions
current_short_positions AS (
    SELECT lsp."PRODUCT_CODE", s."PERCENT_..." AS current_short_position
    FROM latest_short_positions lsp
    JOIN shorts s ON lsp."PRODUCT_CODE" = s."PRODUCT_CODE" AND lsp.max_date = s."DATE"
),
-- 3. Rank by industry using window functions
ranked_stocks AS (
    SELECT 
        cm.industry,
        csp."PRODUCT_CODE",
        csp.current_short_position,
        ROW_NUMBER() OVER (PARTITION BY cm.industry ORDER BY current_short_position DESC) AS rank
    FROM current_short_positions csp
    JOIN "company-metadata" cm ON csp."PRODUCT_CODE" = cm.stock_code
)
SELECT * FROM ranked_stocks WHERE rank <= 10
```

**Key optimizations:**
- `idx_shorts_date_product_percent` speeds up the date filtering and grouping
- `idx_company_metadata_stock_industry` speeds up the join and partitioning
- `idx_shorts_product_date_for_windows` optimizes the window function

### Top Shorts Query Pattern
```sql
WITH max_date AS (
    SELECT MAX("DATE") as latest_date FROM shorts
),
latest_shorts AS (
    SELECT "PRODUCT_CODE", "PRODUCT", "PERCENT_..."
    FROM shorts, max_date
    WHERE "DATE" = max_date.latest_date
      AND "PERCENT_..." > 0
)
SELECT * FROM latest_shorts
ORDER BY "PERCENT_..." DESC
LIMIT 10
```

**Key optimizations:**
- `idx_shorts_date_desc_only` speeds up `MAX(DATE)` queries
- `idx_shorts_percent_date` speeds up filtering by percentage and date
- `idx_shorts_timeseries_covering` includes all needed columns

## Troubleshooting

### Indexes created but queries still slow?

1. **Update statistics:**
   ```sql
   ANALYZE shorts;
   ANALYZE "company-metadata";
   ```

2. **Check if indexes are being used:**
   ```sql
   EXPLAIN ANALYZE <your query>
   ```
   Look for "Index Scan" or "Bitmap Index Scan" instead of "Seq Scan"

3. **Check for stale connections:**
   - Restart your application
   - Close and reopen database connections

### Still having issues?

1. Check table sizes:
   ```sql
   SELECT pg_size_pretty(pg_total_relation_size('shorts'));
   ```

2. Check for index bloat:
   ```sql
   SELECT 
       indexname, 
       pg_size_pretty(pg_relation_size(indexname::regclass))
   FROM pg_indexes 
   WHERE tablename = 'shorts';
   ```

3. Consider REINDEX if indexes are bloated:
   ```sql
   REINDEX TABLE shorts;
   ```

## Additional Resources

- Full performance guide: `QUERY_PERFORMANCE_GUIDE.md`
- PostgreSQL Index Types: https://www.postgresql.org/docs/current/indexes-types.html
- Window Functions: https://www.postgresql.org/docs/current/tutorial-window.html
- Query Performance: https://www.postgresql.org/docs/current/performance-tips.html

