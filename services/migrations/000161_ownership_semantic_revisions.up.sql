-- Versioned ownership extraction revisions. This sidecar does not require a
-- legacy parsed notice, and is deliberately absent from every public holding,
-- aggregate and feed. Applying it enables storage, not SHN interpretation or
-- publication. The unsupported-format guard and legacy voting columns remain.
--
-- Replays create no duplicate object or data. No historical row is rewritten.
-- This migration is not added to the deployment allowlist by this foundation.
-- A release must explicitly stage it before 000138's Data API grant lockdown.
BEGIN;
SET LOCAL lock_timeout = '5s';

CREATE TABLE IF NOT EXISTS ownership_disclosure_revisions (
    revision_id              TEXT PRIMARY KEY CHECK (revision_id ~ '^[a-f0-9]{64}$'),
    disclosure_id            TEXT NOT NULL CHECK (disclosure_id ~ '^[a-f0-9]{64}$'),
    source_url               TEXT NOT NULL CHECK (char_length(source_url) BETWEEN 1 AND 4096),
    disclosure_slot          INTEGER NOT NULL CHECK (disclosure_slot BETWEEN 1 AND 10000),
    source_sha256            TEXT NOT NULL CHECK (source_sha256 ~ '^[a-f0-9]{64}$'),
    extractor_version        TEXT NOT NULL CHECK (char_length(extractor_version) BETWEEN 1 AND 160),
    extractor_config_sha256  TEXT NOT NULL CHECK (extractor_config_sha256 ~ '^[a-f0-9]{64}$'),
    contract_version         TEXT NOT NULL CHECK (contract_version = 'shorted.ownership.disclosure.v1'),
    document_format          TEXT NOT NULL CHECK (document_format IN (
        'au_603_legacy', 'au_604_legacy', 'au_605_legacy',
        'au_603_transitional_2026', 'au_604_transitional_2026', 'au_605_transitional_2026',
        'au_shn_2026', 'nz', 'unknown')),
    review_state             TEXT NOT NULL CHECK (review_state IN ('needs_review', 'reviewed', 'rejected')),
    extraction_completeness  TEXT NOT NULL CHECK (extraction_completeness IN ('partial', 'complete', 'not_extracted')),
    publication_eligible     BOOLEAN NOT NULL DEFAULT false CHECK (NOT publication_eligible),
    supersedes_revision_id   TEXT REFERENCES ownership_disclosure_revisions(revision_id),
    supersedes_disclosure_id TEXT CHECK (supersedes_disclosure_id ~ '^[a-f0-9]{64}$'),
    payload_sha256           TEXT NOT NULL CHECK (payload_sha256 ~ '^[a-f0-9]{64}$'),
    payload                  JSONB NOT NULL CHECK (
        jsonb_typeof(payload) = 'object'
        AND octet_length(payload::text) <= 2097152
        AND payload @> '{"publication_eligible":false,"source":{"hash_status":"captured"}}'::jsonb
        AND payload->>'contract_version' IS NOT NULL
        AND payload->>'contract_version' = contract_version),
    recorded_at              TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT ownership_disclosure_revisions_identity_key UNIQUE (
        disclosure_id, source_sha256, extractor_version, extractor_config_sha256, contract_version),
    CONSTRAINT ownership_disclosure_revisions_no_self_revision CHECK (
        supersedes_revision_id IS NULL OR supersedes_revision_id <> revision_id),
    CONSTRAINT ownership_disclosure_revisions_no_self_correction CHECK (
        supersedes_disclosure_id IS NULL OR supersedes_disclosure_id <> disclosure_id)
);

CREATE INDEX IF NOT EXISTS idx_ownership_disclosure_revision_history
    ON ownership_disclosure_revisions (disclosure_id, recorded_at, revision_id);

-- No application path may rewrite or remove extraction history. The owner can
-- still deliberately remove the table using the down migration; ordinary row
-- mutation, including an UPDATE affecting no rows, is rejected.
CREATE OR REPLACE FUNCTION ownership_disclosure_revisions_immutable()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    RAISE EXCEPTION 'ownership disclosure revisions are append-only'
        USING ERRCODE = '55000';
END;
$$;

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_trigger
        WHERE tgrelid = 'ownership_disclosure_revisions'::regclass
          AND tgname = 'ownership_disclosure_revisions_no_mutation'
    ) THEN
        CREATE TRIGGER ownership_disclosure_revisions_no_mutation
            BEFORE UPDATE OR DELETE OR TRUNCATE ON ownership_disclosure_revisions
            FOR EACH STATEMENT EXECUTE FUNCTION ownership_disclosure_revisions_immutable();
    END IF;
END;
$$;

-- Close the new objects in this transaction, even when Supabase default
-- privileges would otherwise expose them through the Data API before 000138.
-- No policy or FORCE is added: the owning backend still works. service_role
-- grants are retained consistently with 000138, and global defaults are not
-- changed. This sidecar never grants public access based on review_state.
ALTER TABLE ownership_disclosure_revisions ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE ownership_disclosure_revisions FROM PUBLIC;
REVOKE ALL ON FUNCTION ownership_disclosure_revisions_immutable() FROM PUBLIC;

DO $$
DECLARE r record;
BEGIN
    FOR r IN SELECT rolname FROM pg_roles WHERE rolname IN ('anon', 'authenticated')
    LOOP
        EXECUTE format('REVOKE ALL ON TABLE ownership_disclosure_revisions FROM %I', r.rolname);
        EXECUTE format('REVOKE ALL ON FUNCTION ownership_disclosure_revisions_immutable() FROM %I', r.rolname);
    END LOOP;
END;
$$;

COMMIT;
