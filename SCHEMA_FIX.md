# Schema Column Fix

## Issue
The UPDATE query tried to set `updated_at = CURRENT_TIMESTAMP`, but the `company-metadata` table doesn't have an `updated_at` column.

## Root Cause
Multiple schema definitions exist across the codebase:
- `services/migrations/` - has `updated_at` column
- `web/supabase/migrations/` - does NOT have `updated_at` column
- `supabase/migrations/` - different schemas

The actual production `company-metadata` table follows the schema without `updated_at`.

## Solution
1. **Removed `updated_at` from UPDATE query** - We already track changes with `enrichment_date`
2. **Removed `sector`, `market_cap`, `created_at`, `updated_at` from view** - These columns don't exist in the actual table

### Changes Made

**Cell 10 in Notebook**:
```sql
-- BEFORE:
UPDATE "company-metadata"
SET 
    ...
    enrichment_error = :enrichment_error,
    updated_at = CURRENT_TIMESTAMP  -- ❌ Column doesn't exist
WHERE stock_code = :stock_code

-- AFTER:
UPDATE "company-metadata"
SET 
    ...
    enrichment_error = :enrichment_error
    -- Removed updated_at line ✅
WHERE stock_code = :stock_code
```

**002_enrich_company_metadata.sql**:
```sql
-- Removed columns that don't exist:
-- - sector
-- - market_cap  
-- - created_at
-- - updated_at
```

## Column Tracking
Changes are tracked via `enrichment_date` which records when the AI enrichment was performed.

## Status: FIXED ✅
The notebook now only updates columns that actually exist in the table.
