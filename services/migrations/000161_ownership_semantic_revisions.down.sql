-- Explicit rollback removes only the new sidecar and its immutability helper.
-- It does not change legacy notices, attempts, forms, voting fields or views.
BEGIN;
SET LOCAL lock_timeout = '5s';
DROP TABLE IF EXISTS ownership_disclosure_revisions;
DROP FUNCTION IF EXISTS ownership_disclosure_revisions_immutable();
COMMIT;
