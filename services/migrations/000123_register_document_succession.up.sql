-- Register document succession.
--
-- In 2026 APH moved the 48th Parliament Register of Members' Interests onto a
-- new host: 147 of 151 member rows now link
-- https://interests-register-api-public.aph.gov.au/api/members/{id}/statement/48
-- instead of the /-/media/… PDF we had fetched. source_url is this table's
-- identity, so each of those is a NEW row beside the old one — and without a
-- link between them, loading both publishes a member's declarations twice, and
-- resolving the new row by name mints a second person wherever the listing text
-- was edited in the move ("Antony" became "Tony"; "Brynes" became "Byrnes").
--
-- last_listed_at  when discover last saw this row on its listing page. A row the
--                 latest discover did not list has left the listing.
-- superseded_by   the row that replaced this one on the listing. Set by
--                 discover only on an unambiguous pairing; load carries the
--                 predecessor's resolved identity to the successor and retires
--                 the predecessor in the same transaction that publishes it.
--
-- Additive and idempotent: IF NOT EXISTS throughout, no existing row touched.
-- Apply BY HAND on prod (session pooler 5432) before deploying code that reads
-- these columns — the prod deploy does not run migrate up.

ALTER TABLE register_documents
    ADD COLUMN IF NOT EXISTS last_listed_at TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS superseded_by  UUID REFERENCES register_documents(id) ON DELETE SET NULL;

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conname = 'register_documents_not_self_superseded'
          AND conrelid = 'register_documents'::regclass
    ) THEN
        ALTER TABLE register_documents
            ADD CONSTRAINT register_documents_not_self_superseded
            CHECK (superseded_by IS NULL OR superseded_by <> id);
    END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_register_documents_superseded_by
    ON register_documents (superseded_by) WHERE superseded_by IS NOT NULL;

COMMENT ON COLUMN register_documents.last_listed_at IS
    'When register-discover last saw this row on its APH listing page. Older than the newest value = no longer listed.';
COMMENT ON COLUMN register_documents.superseded_by IS
    'The listing row that replaced this document (same parliament and division, unambiguous pairing). Load carries identity forward and retires this row.';
