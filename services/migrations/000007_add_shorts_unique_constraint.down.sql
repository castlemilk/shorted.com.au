-- Remove unique constraint from shorts table
ALTER TABLE shorts DROP CONSTRAINT IF EXISTS shorts_date_product_code_unique;

