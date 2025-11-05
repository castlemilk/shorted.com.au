# Backend SQL Column Casing Fixes

## Issue

Backend integration tests were failing with:
```
ERROR: column s.product_code does not exist (SQLSTATE 42703)
```

## Root Cause

PostgreSQL quoted identifiers are case-sensitive. The migration creates uppercase columns:

```sql
CREATE TABLE shorts (
    "PRODUCT_CODE" text,
    "DATE" timestamp,
    "PERCENT_OF_TOTAL_PRODUCT_IN_ISSUE_REPORTED_AS_SHORT_POSITIONS" double precision,
    ...
);
```

But test queries used lowercase unquoted identifiers:

```sql
SELECT s.product_code  -- ❌ Doesn't match "PRODUCT_CODE"
```

## Solution

Updated test SQL queries to use uppercase quoted identifiers:

### File: `services/test/integration/shorts_test.go`

#### Fix 1: TestDataConsistency/MetadataConsistency (line 360-362)

**Before:**
```sql
SELECT COUNT(DISTINCT s.product_code) 
FROM shorts s 
LEFT JOIN "company-metadata" m ON s.product_code = m.stock_code 
WHERE m.stock_code IS NULL
```

**After:**
```sql
SELECT COUNT(DISTINCT s."PRODUCT_CODE") 
FROM shorts s 
LEFT JOIN "company-metadata" m ON s."PRODUCT_CODE" = m.stock_code 
WHERE m.stock_code IS NULL
```

#### Fix 2: TestPerformance/QueryResponseTime (line 392-396)

**Before:**
```sql
SELECT s.product_code, s.percent_of_total_shares, m.company_name
FROM shorts s
JOIN "company-metadata" m ON s.product_code = m.stock_code
WHERE s.date = $1
ORDER BY s.percent_of_total_shares DESC
LIMIT 10
```

**After:**
```sql
SELECT s."PRODUCT_CODE", s."PERCENT_OF_TOTAL_PRODUCT_IN_ISSUE_REPORTED_AS_SHORT_POSITIONS", m.company_name
FROM shorts s
JOIN "company-metadata" m ON s."PRODUCT_CODE" = m.stock_code
WHERE s."DATE" = $1
ORDER BY s."PERCENT_OF_TOTAL_PRODUCT_IN_ISSUE_REPORTED_AS_SHORT_POSITIONS" DESC
LIMIT 10
```

## Test Results

### Fixed Tests ✅
```
--- PASS: TestDataConsistency (1.99s)
    --- PASS: TestDataConsistency/ShortsDataIntegrity (0.00s)
    --- PASS: TestDataConsistency/MetadataConsistency (0.00s)
--- PASS: TestPerformance (1.99s)
    --- PASS: TestPerformance/QueryResponseTime (0.01s)
```

### Remaining Test Issues ⚠️

These are **test logic issues**, not SQL syntax:

1. **TestShortsServiceIntegration/GetStockData**
   - Error: "Should NOT be empty, but was"
   - Issue: Data seeding or service logic

2. **TestShortsServiceIntegration/ErrorHandling/NonExistentStock**
   - Error: Expected error code 0x5 (NotFound), got 0x3 (InvalidArgument)
   - Issue: Error handling logic in service

## Files Modified

- `services/test/integration/shorts_test.go`

## PostgreSQL Column Naming Best Practice

To avoid this issue in the future, consider either:

**Option 1: Use lowercase unquoted (recommended)**
```sql
CREATE TABLE shorts (
    product_code text,  -- No quotes, lowercase
    date timestamp,
    ...
);
```

**Option 2: Always quote identifiers consistently**
```sql
-- In migrations
CREATE TABLE shorts ("PRODUCT_CODE" text, ...);

-- In all queries
SELECT s."PRODUCT_CODE" FROM shorts s;
```

## Impact on Frontend PR

**None** - These backend SQL fixes are independent of the frontend authentication and rate limiting changes.

The frontend is ready to deploy regardless of these backend test issues.

