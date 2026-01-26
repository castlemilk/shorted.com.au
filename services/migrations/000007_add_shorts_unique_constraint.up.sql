-- Add unique constraint to shorts table for proper upsert support
-- This fixes the bug where ON CONFLICT clause silently failed without a unique constraint

-- First, remove any duplicates (keeping latest by ctid)
DELETE FROM shorts a USING (
    SELECT MIN(ctid) as ctid, "DATE", "PRODUCT_CODE"
    FROM shorts
    GROUP BY "DATE", "PRODUCT_CODE"
    HAVING COUNT(*) > 1
) b
WHERE a."DATE" = b."DATE" 
  AND a."PRODUCT_CODE" = b."PRODUCT_CODE"
  AND a.ctid <> b.ctid;

-- Add the unique constraint
ALTER TABLE shorts 
ADD CONSTRAINT shorts_date_product_code_unique 
UNIQUE ("DATE", "PRODUCT_CODE");

COMMENT ON CONSTRAINT shorts_date_product_code_unique ON shorts IS 
'Required for ON CONFLICT upsert to work correctly in daily sync';

