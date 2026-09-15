DROP INDEX IF EXISTS idx_register_documents_superseded_by;
ALTER TABLE register_documents DROP CONSTRAINT IF EXISTS register_documents_not_self_superseded;
ALTER TABLE register_documents
    DROP COLUMN IF EXISTS superseded_by,
    DROP COLUMN IF EXISTS last_listed_at;
