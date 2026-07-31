-- The operator review console for the security backlog, and row-level takedown.
--
-- WHY THIS EXISTS. §6.1's item-1 gate is 51.18% (1,174 / 2,294 locally), and
-- §8.19.1 established that the number is measuring the wrong thing: the
-- denominator is `entity_kind='listed'`, which entityKindOf assigns BY DEFAULT to
-- anything it cannot otherwise explain. Measured on this corpus: `foreign` = 0
-- rows, `unlisted_fund` = 0, `managed_fund` = 2. The whole backlog of CORRECTLY
-- unresolvable declarations (foreign listings, ETFs, delistings, prose) still
-- sits inside the denominator.
--
-- So there are two ways to move coverage, and only one of them is matching:
--
--   * resolve a name to a code   -> numerator up   (a real new link)
--   * classify a name honestly   -> denominator down (an explained failure)
--
-- Both are HUMAN decisions and both already have exactly one destination:
-- register_security_aliases. The resolver reads that table and nothing else
-- (aph_resolve.go:loadRegisterSecurityAliases), so a row there is the single
-- control surface for both halves. This migration does not add a second one.
--
-- Measured addressable set at the time of writing: 2,070 distinct names across
-- 2,638 rows in the queue; the item-1 slice that moves the gate is 814 names /
-- 1,120 rows, of which 208 names (514 rows) occur more than once.

-- ---------------------------------------------------------------------------
-- 1. The queue
-- ---------------------------------------------------------------------------

-- register_resolution_backlog (000096) is candidate_norm + example + count. That
-- is enough to ORDER work and not enough to DECIDE it: the doc's screen (b)
-- requires blast radius stated in NAMED PEOPLE before the click, because one
-- alias fans out to N politicians' published profiles. "SYDNEY AIRPORT" is six
-- rows across FIVE members; a wrong call there is five wrong facts, not one.
--
-- The filters mirror loadAliasCandidates (aph_alias_propose.go) deliberately, so
-- the model's queue and the human's queue are the same queue. In particular
-- entity_kind is NOT restricted to 'listed': §8.19's cell-context rule moves
-- unmatched item-1 candidates to 'not_an_entity', and filtering them out was the
-- §8.19.1 defect that made 1,301 names invisible to the one lever that raises
-- resolution. A name the classifier could not explain is exactly what a human
-- should be shown.
--
-- Already-curated names are excluded: an alias row IS the decision, so a decided
-- candidate leaves the queue with no extra state to keep in sync.
CREATE OR REPLACE VIEW register_review_security_queue AS
SELECT
    s.candidate_norm,
    -- The shortest raw spelling reads best on the card; the reviewer sees the
    -- full declared_text strings separately, which is what they judge from.
    (array_agg(s.candidate_raw ORDER BY length(s.candidate_raw), s.candidate_raw))[1] AS example,
    count(*)                                                        AS occurrences,
    count(DISTINCT i.politician_id)                                 AS people,
    array_agg(DISTINCT i.item_no)                                   AS items,
    array_remove(array_agg(DISTINCT st.parliament), NULL)           AS parliaments,
    array_agg(DISTINCT s.entity_kind)                               AS entity_kinds,
    -- Whether this candidate counts toward the §6.1 gate denominator, so the
    -- console can state honestly what a decision will and will not move.
    count(*) FILTER (WHERE i.item_no = 1 AND s.entity_kind = 'listed') AS gate_rows
FROM register_item_securities s
JOIN register_declared_items i  ON i.id = s.item_id
JOIN register_statements     st ON st.id = i.statement_id
WHERE i.item_no IN (1, 4)
  AND s.entity_kind IN ('listed', 'not_an_entity')
  AND s.resolution_status IN ('unmatched', 'ambiguous')
  AND btrim(s.candidate_norm) <> ''
  AND length(s.candidate_norm) >= 3
  AND NOT EXISTS (
      SELECT 1 FROM register_security_aliases a WHERE a.alias_norm = s.candidate_norm)
GROUP BY s.candidate_norm;

COMMENT ON VIEW register_review_security_queue IS
    'Undecided declared names for the operator console, with blast radius counted in named people. Excludes anything register_security_aliases already decides. gate_rows is the subset inside the §6.1 item-1 denominator.';

-- ---------------------------------------------------------------------------
-- 2. Skips
-- ---------------------------------------------------------------------------

-- Screen (b)'s fourth key. A skip writes no alias — that is the whole point, it
-- is the "I do not know" answer — so it needs somewhere of its own to live, and
-- a candidate that several reviewers have skipped is a signal (it wants a second
-- opinion or a source page), not noise.
--
-- Keyed by candidate_norm rather than by a proposal id because most of the queue
-- has no proposal: the model has answered 43 of 2,070 names.
CREATE TABLE IF NOT EXISTS register_review_skips (
    candidate_norm   TEXT PRIMARY KEY,
    skip_count       INTEGER NOT NULL DEFAULT 0,
    last_skipped_by  TEXT NOT NULL DEFAULT '',
    last_skipped_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

COMMENT ON TABLE register_review_skips IS
    'Per-candidate skip tally from the review console. Carries no editorial meaning and is read by nothing except the console ordering.';

-- ---------------------------------------------------------------------------
-- 3. Row-level takedown (§6.3 open item 1)
-- ---------------------------------------------------------------------------

-- Rule 8 of the editorial standards promises a reader they can report an error.
-- Until now the only remedy was POLITICIAN_INTERESTS_ENABLED=false — one
-- contested declaration meant withdrawing the whole surface for everyone.
--
-- SUPPRESSION IS NOT DELETION, and the column name is chosen to say so. The row
-- survives in register_declared_items with its provenance intact; it is dropped
-- from the fold, so it leaves mv_register_public_holdings and every read path
-- that hangs off it. Deleting a row a member actually made would remove a real
-- declaration from a named person's record, and would also break the nil-rate
-- tripwire that register_extraction_stats measures (000096:285-290).
ALTER TABLE register_declared_items
    ADD COLUMN IF NOT EXISTS suppressed_at     TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS suppressed_by     TEXT NOT NULL DEFAULT '',
    ADD COLUMN IF NOT EXISTS suppression_note  TEXT NOT NULL DEFAULT '';

COMMENT ON COLUMN register_declared_items.suppressed_at IS
    'Set to withdraw ONE declared row from publication without taking down the feature. The row is retained; the fold skips it. Never a delete.';

-- Partial: suppression is expected to stay a handful of rows, and the fold's
-- filter is `suppressed_at IS NULL` over everything, which this does not serve.
-- It exists so an operator can list what is currently withheld.
CREATE INDEX IF NOT EXISTS idx_register_items_suppressed
    ON register_declared_items (suppressed_at)
    WHERE suppressed_at IS NOT NULL;

-- ---------------------------------------------------------------------------
-- 4. A curated alias may say "foreign"
-- ---------------------------------------------------------------------------

-- entityKindOf's own comment records that 'foreign' is "declared and permitted by
-- the CHECK but is never returned here", because the only automatic signal would
-- be an Inc/LLC/plc suffix and four of the fourteen such names in this corpus are
-- Australian incorporated associations. It says foreign "waits for a curated
-- decision rather than a suffix guess" — but there was no way to record that
-- decision, because resolution had no 'foreign' value and alias_kind='foreign'
-- fell through to not_a_security, which labels a real foreign listing as naming
-- nothing at all.
--
-- A foreign listing IS a security. It is simply not one we can link, so it must
-- leave the ASX-resolution denominator while keeping an honest label.
ALTER TABLE register_security_aliases
    DROP CONSTRAINT IF EXISTS register_security_aliases_resolution_check;
ALTER TABLE register_security_aliases
    ADD CONSTRAINT register_security_aliases_resolution_check
        CHECK (resolution IN ('resolved', 'unlisted_fund', 'not_a_security', 'foreign'));
