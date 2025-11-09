# Database Index Performance Analysis

## Summary

✅ **stock_prices table**: Indexes are optimal and well-used  
⚠️ **shorts table**: Has 5 unused indexes wasting 337 MB

## Stock Prices Table Analysis

### Current Status: ✅ EXCELLENT

**Table Size:** 175 MB data, 213 MB indexes (1,037,065 rows)

**Indexes:**

| Index Name | Size | Times Used | Status | Purpose |
|------------|------|------------|--------|---------|
| `stock_prices_stock_code_date_key` | 68 MB | 1,096,250 | ✅ PRIMARY | Unique constraint, most queries |
| `idx_stock_prices_stock_code` | 15 MB | 7,269 | ✅ ACTIVE | Single stock lookups |
| `idx_stock_prices_stock_date` | 76 MB | 771 | ✅ ACTIVE | Stock + date range queries |
| `idx_stock_prices_date` | 14 MB | 312 | ✅ ACTIVE | Date range queries |
| `stock_prices_pkey` | 40 MB | 1 | ✅ REQUIRED | Primary key |

**Query Performance:**
- Single stock historical query: **6.5ms** ⚡
- Join with shorts table: **24.8ms** ⚡
- All queries using correct indexes

### Recommendation: ✅ NO CHANGES NEEDED

All indexes are being used effectively. The composite index `idx_stock_prices_stock_date` perfectly matches the most common query pattern:
```sql
WHERE stock_code = 'IEL' AND date >= '2024-01-01' ORDER BY date DESC
```

---

## Shorts Table Analysis

### Current Status: ⚠️ NEEDS OPTIMIZATION

**Table Size:** 537 MB data, 1,865 MB indexes (5,881,622 rows)  
**Issue:** Indexes are 3.5x the data size (should be ~1-2x)

**Highly Used Indexes (Keep):**

| Index Name | Size | Times Used | Purpose |
|------------|------|------------|---------|
| `idx_shorts_product_code_date` | 117 MB | 4,654,544 | Most important - stock lookups |
| `idx_shorts_latest_per_product` | 112 MB | 476,070 | Latest short position per stock |
| `idx_shorts_product_date_for_windows` | 228 MB | 34,056 | Window functions/analytics |
| `idx_shorts_date_percent` | 179 MB | 28,572 | Top shorts queries |
| `idx_shorts_product_code_sort` | 40 MB | 3,712 | Sorting operations |
| `idx_shorts_product_code_trgm` | 69 MB | 2,800 | Text search (PRODUCT_CODE) |
| `idx_shorts_product_trgm` | 248 MB | 2,791 | Text search (PRODUCT name) |

**Unused Indexes (SAFE TO DROP):**

| Index Name | Size | Times Used | Reason |
|------------|------|------------|--------|
| ❌ `idx_shorts_search_composite` | 41 MB | **0** | Duplicate - covered by other indexes |
| ❌ `idx_shorts_percent_date` | 174 MB | **0** | Never used in queries |
| ❌ `idx_shorts_product_code_search` | 40 MB | **0** | Redundant with `product_code_sort` |
| ❌ `idx_shorts_product_name_search` | 41 MB | **0** | Redundant with trigram indexes |
| ❌ `idx_shorts_percentage_not_null` | 41 MB | **0** | Partial index, never needed |

**Total Space to Reclaim: 337 MB** 💾

---

## Optimization Recommendations

### Option 1: Drop Unused Indexes (Recommended)

```sql
-- SAFE: These indexes have 0 usage
DROP INDEX IF EXISTS idx_shorts_search_composite;
DROP INDEX IF EXISTS idx_shorts_percent_date;
DROP INDEX IF EXISTS idx_shorts_product_code_search;
DROP INDEX IF EXISTS idx_shorts_product_name_search;
DROP INDEX IF EXISTS idx_shorts_percentage_not_null;

-- Will reclaim: 337 MB
-- Impact: NONE (0 queries use these)
-- Risk: ZERO
```

**Benefits:**
- ✅ Reclaim 337 MB disk space
- ✅ Faster INSERT/UPDATE operations (fewer indexes to maintain)
- ✅ Faster VACUUM operations
- ✅ Reduced backup/restore time
- ✅ NO query performance impact (0 uses)

### Option 2: Monitor Low-Usage Indexes

These indexes have very low usage but might be useful occasionally:

| Index Name | Size | Times Used | Keep? |
|------------|------|------------|-------|
| `idx_shorts_timeseries_covering` | 224 MB | 113 | ⚠️ Monitor |
| `idx_shorts_date_desc_only` | 40 MB | 20 | ⚠️ Monitor |
| `idx_shorts_date_product_percent` | 228 MB | 6 | ⚠️ Consider dropping |
| `shorts_PRODUCT_CODE_idx` | 44 MB | 417 | ⚠️ Redundant with `product_code_date` |

**Recommendation:** Monitor these for another month. If usage stays < 100, consider dropping.

---

## Implementation Plan

### Step 1: Verify No Active Queries (Safety Check)

```sql
-- Check if any queries are currently using these indexes
SELECT 
    pid,
    query,
    state,
    query_start
FROM pg_stat_activity
WHERE query ILIKE '%idx_shorts_search_composite%'
   OR query ILIKE '%idx_shorts_percent_date%'
   OR query ILIKE '%idx_shorts_product_code_search%'
   OR query ILIKE '%idx_shorts_product_name_search%'
   OR query ILIKE '%idx_shorts_percentage_not_null%';
```

Expected: 0 results

### Step 2: Drop Unused Indexes

```bash
cd /Users/benebsworth/projects/shorted
export DATABASE_URL="postgresql://..."

psql "$DATABASE_URL" << 'EOF'
BEGIN;

-- Drop unused indexes
DROP INDEX IF EXISTS idx_shorts_search_composite;
DROP INDEX IF EXISTS idx_shorts_percent_date;
DROP INDEX IF EXISTS idx_shorts_product_code_search;
DROP INDEX IF EXISTS idx_shorts_product_name_search;
DROP INDEX IF EXISTS idx_shorts_percentage_not_null;

-- Verify
SELECT 
    COUNT(*) as total_indexes,
    pg_size_pretty(SUM(pg_relation_size(indexname::regclass))) as total_size
FROM pg_indexes
WHERE tablename = 'shorts';

COMMIT;
EOF
```

### Step 3: VACUUM to Reclaim Space

```sql
VACUUM ANALYZE shorts;
```

### Step 4: Verify Performance

Run common queries to ensure performance is maintained:

```sql
-- Test 1: Single stock lookup (should use idx_shorts_product_code_date)
EXPLAIN ANALYZE
SELECT * FROM shorts 
WHERE "PRODUCT_CODE" = 'IEL' 
  AND "DATE" >= CURRENT_DATE - INTERVAL '1 year';

-- Test 2: Top shorts (should use idx_shorts_date_percent)
EXPLAIN ANALYZE
SELECT "PRODUCT_CODE", "PERCENT_OF_TOTAL_PRODUCT_IN_ISSUE_REPORTED_AS_SHORT_POSITIONS"
FROM shorts
WHERE "DATE" = (SELECT MAX("DATE") FROM shorts)
ORDER BY "PERCENT_OF_TOTAL_PRODUCT_IN_ISSUE_REPORTED_AS_SHORT_POSITIONS" DESC
LIMIT 100;

-- Test 3: Search (should use trigram indexes)
EXPLAIN ANALYZE
SELECT * FROM shorts
WHERE "PRODUCT" ILIKE '%EDUCATION%'
LIMIT 10;
```

---

## Expected Results

**Before:**
- shorts table: 537 MB data + 1,865 MB indexes = 2,402 MB total
- 16 indexes

**After:**
- shorts table: 537 MB data + 1,528 MB indexes = 2,065 MB total
- 11 indexes
- **337 MB saved** (14% reduction)

---

## Maintenance Recommendations

### 1. Regular Index Usage Monitoring

```sql
-- Run monthly to identify unused indexes
SELECT 
    schemaname,
    relname,
    indexrelname,
    pg_size_pretty(pg_relation_size(indexrelid)) as size,
    idx_scan as scans,
    idx_tup_read as tuples_read
FROM pg_stat_user_indexes
WHERE relname IN ('stock_prices', 'shorts')
  AND idx_scan < 100
ORDER BY pg_relation_size(indexrelid) DESC;
```

### 2. Reset Statistics After Changes

```sql
-- After dropping indexes, reset stats to track new patterns
SELECT pg_stat_reset();
```

### 3. Analyze Query Patterns

```sql
-- Check slow queries
SELECT 
    query,
    calls,
    total_exec_time,
    mean_exec_time,
    max_exec_time
FROM pg_stat_statements
WHERE query LIKE '%shorts%' OR query LIKE '%stock_prices%'
ORDER BY mean_exec_time DESC
LIMIT 10;
```

---

## Performance Benchmarks

### Current Performance ✅

**Common Queries:**
- Single stock historical prices: **6.5ms**
- Stock + shorts join: **24.8ms**
- Latest short positions: **< 10ms**
- Top 100 shorted stocks: **< 50ms**

**All queries are performing excellently!**

---

## Conclusion

### stock_prices: ✅ Perfect
- All indexes are well-used
- Query performance is excellent (6-25ms)
- No changes needed

### shorts: ⚠️ Optimization Recommended
- Drop 5 unused indexes to reclaim **337 MB**
- No performance impact (0 queries use them)
- Will speed up INSERT/UPDATE operations
- Safe and recommended

**Overall Database Health: GOOD** 👍

---

## Files

- Analysis: `/Users/benebsworth/projects/shorted/DATABASE_INDEX_ANALYSIS.md` (this file)
- Stock code fix: `/Users/benebsworth/projects/shorted/STOCK_DATA_FIX_SUMMARY.md`

