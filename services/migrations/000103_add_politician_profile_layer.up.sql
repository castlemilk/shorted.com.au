-- The profile layer: an identity key, structured facts, and human curation.
--
-- WHY THIS EXISTS. Two problems, one shape.
--
-- 1. IDENTITY IS BROKEN AND IT IS PUBLISHED. `merged_into_id` is 0 of 324, and
--    28 people exist twice — `christopher-bowen` (26 statements) and
--    `chris-bowen` (9) are one man, split by preferred name vs legal name.
--    §3.3's `person_key` keeps only the FIRST given name, so it cannot collapse
--    Chris against Christopher. Both slugs are minted, indexed, in the sitemap
--    and now carry portraits, and each page understates that person's history.
--    The APH Parliamentary Handbook gives every member a stable PHID, which
--    resolves 309 of our 324 rows and collapses all 28 pairs.
--
-- 2. EVERY COLLECTOR BLIND-OVERWRITES PERSON METADATA. There is no curated
--    layer: a re-run of any register mode rewrites the row. So an operator
--    correcting a name today would lose it on the next load. That is the same
--    failure the review console's alias table was built to avoid, and it gets
--    the same answer — a separate, human-owned table that the crawl may not
--    touch.
--
-- SCOPE IS DELIBERATELY NARROW. docs/influence-editorial-standards.md §4:
-- "any data obtained other than from official publications are out of scope,
-- full stop." So this layer holds STRUCTURED FACTS from official sources
-- (occupations, qualifications, dated roles) and OUTBOUND LINKS — never a
-- free-text biography, and never anything from LinkedIn, a campaign site or a
-- news article. A `field` denylist trigger enforces that mechanically below,
-- because a vocabulary policed only by review is a vocabulary that widens.

-- ---------------------------------------------------------------------------
-- 1. The identity key
-- ---------------------------------------------------------------------------

-- The Handbook's stable person id. `aph_mpid` already exists and is 0 of 324
-- populated — it is a DIFFERENT id from a source we never wired up, and it is
-- left alone rather than repurposed so a later fix can still use it for what it
-- names.
ALTER TABLE politicians
    ADD COLUMN IF NOT EXISTS aph_phid TEXT NOT NULL DEFAULT '';

CREATE INDEX IF NOT EXISTS idx_politicians_aph_phid
    ON politicians (aph_phid) WHERE btrim(aph_phid) <> '';

-- Merge provenance. `merged_into_id` already exists but records only the fact,
-- not who decided or on what evidence — and a merge moves an ENTIRE declared
-- history onto a named individual, which is the highest-blast-radius action in
-- the subsystem (§7.2 item 4 says so, and keeps it out of the row editor).
ALTER TABLE politicians
    ADD COLUMN IF NOT EXISTS merged_by       TEXT NOT NULL DEFAULT '',
    ADD COLUMN IF NOT EXISTS merged_at       TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS merge_evidence  TEXT NOT NULL DEFAULT '';

-- A merge must record its reason. Anonymous history-moving is not reviewable.
ALTER TABLE politicians DROP CONSTRAINT IF EXISTS politicians_merge_needs_evidence;
ALTER TABLE politicians
    ADD CONSTRAINT politicians_merge_needs_evidence
        CHECK (merged_into_id IS NULL
               OR (btrim(merged_by) <> '' AND btrim(merge_evidence) <> ''));

-- A merge must never form a CHAIN. A two-hop A -> B -> C means the slug of A
-- resolves to B, who no longer exists either — a redirect into a hole, which is
-- worse than the duplicate it was meant to fix.
--
-- BOTH DIRECTIONS ARE CHECKED, and the second one is not obvious: blocking
-- "merge into an already-merged row" alone still permits merging away a row that
-- others already point AT, which builds the same chain from the other end. The
-- first version of this trigger did exactly that and the migration's own guard
-- test caught it.
CREATE OR REPLACE FUNCTION politicians_reject_merge_chain() RETURNS trigger AS $$
BEGIN
    IF NEW.merged_into_id IS NOT NULL THEN
        IF NEW.merged_into_id = NEW.id THEN
            RAISE EXCEPTION 'politician % cannot be merged into itself', NEW.id;
        END IF;
        -- Forward: the target must be a survivor.
        IF EXISTS (SELECT 1 FROM politicians p
                    WHERE p.id = NEW.merged_into_id AND p.merged_into_id IS NOT NULL) THEN
            RAISE EXCEPTION 'refusing merge chain: target % is itself merged away', NEW.merged_into_id;
        END IF;
        -- Backward: nobody may already be pointing at the row being merged away.
        IF EXISTS (SELECT 1 FROM politicians p
                    WHERE p.merged_into_id = NEW.id) THEN
            RAISE EXCEPTION 'refusing merge chain: % is already the merge target of another row', NEW.id;
        END IF;
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_politicians_reject_merge_chain ON politicians;
CREATE TRIGGER trg_politicians_reject_merge_chain
    BEFORE INSERT OR UPDATE OF merged_into_id ON politicians
    FOR EACH ROW EXECUTE FUNCTION politicians_reject_merge_chain();

-- ---------------------------------------------------------------------------
-- 2. Structured facts from official sources
-- ---------------------------------------------------------------------------

-- One row per (person, field, source). Machine-owned: a collector may INSERT
-- and UPDATE freely here, and nothing a human types ever lands in this table.
CREATE TABLE IF NOT EXISTS politician_profile_facts (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    politician_id   UUID NOT NULL REFERENCES politicians(id) ON DELETE CASCADE,
    field           TEXT NOT NULL,
    -- Ordinal lets a field repeat: four occupations, three committees.
    ordinal         SMALLINT NOT NULL DEFAULT 0,
    fact_text       TEXT NOT NULL DEFAULT '',
    fact_from       DATE,
    fact_to         DATE,
    -- Provenance PER FACT, not per row. The politicians table carries one
    -- source/licence for the whole person, which cannot describe a row whose
    -- fields come from three different publications.
    source_key      TEXT NOT NULL,
    source_url      TEXT NOT NULL DEFAULT '',
    source_licence  TEXT NOT NULL DEFAULT '',
    fetched_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT politician_profile_facts_unique
        UNIQUE (politician_id, field, ordinal, source_key)
);

CREATE INDEX IF NOT EXISTS idx_politician_profile_facts_person
    ON politician_profile_facts (politician_id, field);

COMMENT ON TABLE politician_profile_facts IS
    'Structured facts about a parliamentarian from OFFICIAL sources only (editorial standards §4). Machine-owned and rebuilt by collectors; human corrections live in politician_profile_overrides and always win.';

-- ---------------------------------------------------------------------------
-- 3. Human curation, which always beats the crawl
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS politician_profile_overrides (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    politician_id   UUID NOT NULL REFERENCES politicians(id) ON DELETE CASCADE,
    field           TEXT NOT NULL,
    ordinal         SMALLINT NOT NULL DEFAULT 0,
    action          TEXT NOT NULL,
    -- The machine reading AT THE MOMENT OF THE DECISION, frozen. Without it a
    -- reviewer cannot tell whether a later crawl changed under them, and the
    -- console cannot show "machine read X, we publish Y" — the grammar
    -- DeclaredEntity already uses.
    machine_text    TEXT NOT NULL DEFAULT '',
    curated_text    TEXT NOT NULL DEFAULT '',
    -- Why. Not optional: a correction to a named person's record without a
    -- reason is not reviewable, and this is the field a dispute is answered from.
    rationale       TEXT NOT NULL,
    -- Where the curator got it. Officially-sourced or it does not go in.
    evidence_url    TEXT NOT NULL DEFAULT '',
    curated_by      TEXT NOT NULL,
    curated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    -- Append-only: a correction is superseded, never edited in place, or the
    -- trail is not evidence (§7.3).
    superseded_by   UUID REFERENCES politician_profile_overrides(id),
    CONSTRAINT politician_profile_overrides_action_check
        CHECK (action IN ('amend', 'suppress', 'reinstate')),
    CONSTRAINT politician_profile_overrides_needs_reason
        CHECK (btrim(rationale) <> '' AND btrim(curated_by) <> ''),
    -- An amend must actually say something, and must differ from what the
    -- machine already had — otherwise it is a no-op that looks like a decision.
    CONSTRAINT politician_profile_overrides_amend_has_value
        CHECK (action <> 'amend'
               OR (btrim(curated_text) <> '' AND curated_text IS DISTINCT FROM machine_text))
);

-- One live override per (person, field, ordinal). Superseded rows stay.
CREATE UNIQUE INDEX IF NOT EXISTS idx_politician_profile_overrides_live
    ON politician_profile_overrides (politician_id, field, ordinal)
    WHERE superseded_by IS NULL;

COMMENT ON TABLE politician_profile_overrides IS
    'Human corrections to profile facts. ALWAYS beat politician_profile_facts, survive every re-crawl, and are append-only: a correction is superseded, never edited in place.';

-- ---------------------------------------------------------------------------
-- 4. The read view — override wins, crawl fills the rest
-- ---------------------------------------------------------------------------

-- THIS VIEW IS THE ONLY THING A READ PATH SHOULD QUERY. Reading the facts table
-- directly would serve a value a human has already corrected, which is exactly
-- the "fixed in two layers, still served from the third" failure of §8.17.
CREATE OR REPLACE VIEW politician_profile_resolved AS
SELECT
    f.politician_id,
    f.field,
    f.ordinal,
    COALESCE(NULLIF(o.curated_text, ''), f.fact_text) AS resolved_text,
    f.fact_from,
    f.fact_to,
    f.source_key,
    f.source_url,
    f.source_licence,
    (o.id IS NOT NULL)                                AS is_curated,
    o.machine_text,
    o.curated_by,
    o.curated_at
FROM politician_profile_facts f
LEFT JOIN politician_profile_overrides o
       ON o.politician_id = f.politician_id
      AND o.field = f.field
      AND o.ordinal = f.ordinal
      AND o.superseded_by IS NULL
      AND o.action <> 'suppress'
WHERE NOT EXISTS (
    -- A suppressed fact is withheld entirely rather than shown corrected.
    SELECT 1 FROM politician_profile_overrides s
     WHERE s.politician_id = f.politician_id AND s.field = f.field
       AND s.ordinal = f.ordinal AND s.superseded_by IS NULL AND s.action = 'suppress');

COMMENT ON VIEW politician_profile_resolved IS
    'Profile facts with human overrides applied. The ONLY view a read path may use — querying politician_profile_facts directly serves values a curator has already corrected.';

-- ---------------------------------------------------------------------------
-- 5. The field vocabulary is CLOSED, and enforced
-- ---------------------------------------------------------------------------

-- Editorial standards §4 keeps non-official data out of scope, and rule 5 keeps
-- magnitude out of the subsystem entirely. Both are policy today and policy
-- widens. This makes them structural: a field name that looks like personal
-- contact detail, protected-attribute data or a money figure cannot be inserted
-- at all, whatever the CRM's UI happens to offer.
CREATE OR REPLACE FUNCTION politician_profile_reject_field() RETURNS trigger AS $$
BEGIN
    IF NEW.field ~* '(address|street|postal|phone|mobile|email|dob|date_of_birth|birth|home|residen|spouse|partner|child|family|school|religio|health|medical|sexual|ethnic|race|criminal|conviction|allegation|scandal|controvers)' THEN
        RAISE EXCEPTION 'field %: personal/private attributes are out of scope (editorial standards §4)', NEW.field;
    END IF;
    IF NEW.field ~* '(amount|value|salary|worth|price|cost|expenditure|holding_size|portfolio)' THEN
        RAISE EXCEPTION 'field %: the registers record no quantity or value (editorial rule 5)', NEW.field;
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_politician_profile_facts_field ON politician_profile_facts;
CREATE TRIGGER trg_politician_profile_facts_field
    BEFORE INSERT OR UPDATE ON politician_profile_facts
    FOR EACH ROW EXECUTE FUNCTION politician_profile_reject_field();

DROP TRIGGER IF EXISTS trg_politician_profile_overrides_field ON politician_profile_overrides;
CREATE TRIGGER trg_politician_profile_overrides_field
    BEFORE INSERT OR UPDATE ON politician_profile_overrides
    FOR EACH ROW EXECUTE FUNCTION politician_profile_reject_field();
