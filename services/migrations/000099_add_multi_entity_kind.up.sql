-- multi_entity: the declared text names MORE THAN ONE entity, so no single
-- label is true of it.
--
-- WHY THIS EXISTS: migration 000098 gave every candidate a vehicle label, and
-- the fold was widened to publish them. Adversarial review of the loaded corpus
-- found that a cell naming a real ASX listing ALONGSIDE a private vehicle was
-- chipped with the vehicle — and the vehicle chips carry tooltips reading
-- "these are not on the ASX, so there is no ticker". The label therefore denied
-- the shareholding sitting next to it, against a named member:
--
--   Sarah Henderson  "Santos Ltd. Held by SMH Superannuation Fund: Amcor Ltd"
--                    -> chip: Self-managed super fund   (Santos AND Amcor hidden)
--   Ross Vasta       "Superannuation Fund - Listed Companies: VCX"
--                    -> chip: Self-managed super fund   (VCX = Vicinity Centres)
--   John Cobb        "Amcor Ltd Bronomics Pty Ltd Tyco International Ltd"
--                    -> chip: Private company
--   Helen Haines     "Igas Energy Pty Ltd (UK listed)"
--                    -> chip: Private company
--
-- Splitting these was measured and rejected: no splitter recovers the Henderson
-- row (abbreviationTail correctly refuses "Santos Ltd. Held", because
-- "Pty. Ltd." must not split), and a corporate-suffix boundary manufactures a
-- standalone "Citigroup (USA)" that resolves USA to UraniumSA — a NEW wrong link
-- against a named person. So the honest move is to name what these rows are and
-- withhold them, rather than assert a label we know to be false.
--
-- Rows carrying this kind are excluded from the fold exactly as 'not_an_entity'
-- is, so nothing bearing it reaches a read path. It is a WITHHOLDING label, and
-- it must never be inverted into a resolver: "names a listing" is evidence that
-- a chip would be wrong, not evidence of WHICH listing is held.
--
-- See docs/politician-register-architecture.md §8.17.

ALTER TABLE register_item_securities
    DROP CONSTRAINT IF EXISTS register_item_securities_entity_kind_check;
ALTER TABLE register_item_securities
    ADD CONSTRAINT register_item_securities_entity_kind_check
        CHECK (entity_kind IN (
            'listed',           -- an ASX listing, matched or not yet matched
            'private_company',  -- Pty Ltd / proprietary company
            'family_trust',     -- a family trust
            'smsf',             -- a self-managed superannuation fund
            'managed_fund',     -- an unlisted/wholesale fund (resolution 'unlisted_fund')
            'foreign',          -- a listing on a non-Australian exchange
            'multi_entity',     -- names several entities; no single label is true
            'not_an_entity'     -- prose, a nil marker, a gift/travel log line
        ));

-- register_holding_periods deliberately gets NO new CHECK. It already has none,
-- and it must be able to hold '' — the honest value for items 3 and 5-14, which
-- have no security candidate and therefore no classification at all. Migration
-- 000098 defaulted those to 'listed', which made DeclaredEntity render
-- "not matched to an ASX listing" against 666 superannuation accounts, trusts
-- and gifts that were never securities.
ALTER TABLE register_holding_periods
    ALTER COLUMN entity_kind SET DEFAULT '';

COMMENT ON COLUMN register_holding_periods.entity_kind IS
    'Carried through the fold from register_item_securities for items 1 and 4. EMPTY for items 3 and 5-14, which have no security candidate — an empty value means "not classified", and the read path must render no ASX-matching claim for it.';

-- 'not_a_location': the item-3 cell does not name a place AT ALL.
--
-- A reject used to collapse into 'unmatched', which is indistinguishable from a
-- real suburb we simply could not find — and the fold falls back to the raw
-- declared_text when there is no locality, so the non-place published anyway.
-- Two holder labels ("Self", "Partner") rendered on profiles as somewhere the
-- member owns property, and disposals ("Sale of Real Estate in Spearwood WA")
-- rendered as CURRENT property.
--
-- Only the structural non-places get this status. Prose, an unrecognised
-- locality and a too-short fragment stay 'unmatched' and keep publishing their
-- declared text, because those ARE property declarations we merely failed to
-- geocode.
ALTER TABLE register_item_locations
    DROP CONSTRAINT IF EXISTS register_item_locations_status_check;
ALTER TABLE register_item_locations
    ADD CONSTRAINT register_item_locations_status_check
        CHECK (resolution_status IN (
            'resolved', 'ambiguous', 'region', 'no_state', 'unmatched',
            'not_a_location'
        ));
