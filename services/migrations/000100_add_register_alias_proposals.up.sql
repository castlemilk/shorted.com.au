-- register_alias_proposals: an LLM's SUGGESTED declared-name -> ASX-code link,
-- waiting for a human to accept or reject it.
--
-- WHY A SEPARATE TABLE. register_item_securities_public_gate permits
-- resolution_status='resolved' only for match_method IN ('curated_alias',
-- 'ticker_in_text','name_exact'). A model's opinion is 'analyst_fuzzy' by
-- definition and is therefore structurally unpublishable — which is the point.
-- The model may PROPOSE; only a person may DISPOSE.
--
-- Nothing in the read path or the resolver reads this table. The resolver reads
-- register_security_aliases and nothing else, so a proposal has NO effect on
-- what is published until a human promotes it. That promotion is the only step
-- that creates a curated_alias, and it records who did it and when.
--
-- The shortlist the model chose from is stored alongside the answer, so a
-- reviewer can see the alternatives it was offered and judge whether the choice
-- was between plausible options or a lucky pick from a bad list. A proposal
-- without its shortlist is not reviewable.
--
-- See docs/feature/politicians/architecture.md §8.19.

CREATE TABLE IF NOT EXISTS register_alias_proposals (
    id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    -- The normalised declared name, as it appears in
    -- register_item_securities.candidate_norm. Promotion copies this straight
    -- into register_security_aliases.alias_norm, so it MUST be the normalised
    -- form: a hand-typed alias that is not normalised can never be looked up
    -- (14 of the 42 seed aliases in 000097 hit zero rows for exactly that reason).
    candidate_norm        TEXT NOT NULL UNIQUE,
    candidate_sample      TEXT NOT NULL DEFAULT '',   -- a verbatim declaration
    occurrences           INTEGER NOT NULL DEFAULT 0, -- rows this would resolve
    proposed_stock_code   TEXT,                       -- NULL = the model said NONE
    proposed_company_name TEXT NOT NULL DEFAULT '',
    shortlist             JSONB NOT NULL DEFAULT '[]'::jsonb,
    model                 TEXT NOT NULL DEFAULT '',
    confidence            NUMERIC,
    rationale             TEXT NOT NULL DEFAULT '',
    status                TEXT NOT NULL DEFAULT 'proposed',
    reviewed_by           TEXT NOT NULL DEFAULT '',
    reviewed_at           TIMESTAMPTZ,
    created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT register_alias_proposals_status_check
        CHECK (status IN ('proposed', 'confirmed', 'rejected')),
    -- A confirmed proposal must name a code and a reviewer. Confirming an
    -- empty proposal would create an alias to nothing.
    CONSTRAINT register_alias_proposals_confirmed_check
        CHECK (status <> 'confirmed'
               OR (proposed_stock_code IS NOT NULL AND btrim(reviewed_by) <> ''))
);

CREATE INDEX IF NOT EXISTS idx_register_alias_proposals_queue
    ON register_alias_proposals (status, occurrences DESC);

COMMENT ON TABLE register_alias_proposals IS
    'LLM-proposed declared-name -> ASX-code links awaiting human review. NOT read by the resolver or any read path: only register_security_aliases is. Promotion to a curated_alias is a human action and is recorded in reviewed_by/reviewed_at.';
