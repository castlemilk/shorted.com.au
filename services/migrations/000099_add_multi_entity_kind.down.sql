-- Reverting drops 'multi_entity', so any row carrying it must be moved to a
-- value the old CHECK permits. 'not_an_entity' is the closest in EFFECT — both
-- are excluded from the fold, so nothing that was withheld becomes published by
-- rolling back. It is less accurate (these rows are entities, several of them),
-- which is exactly why 000099 added the value in the first place.
UPDATE register_item_securities
   SET entity_kind = 'not_an_entity'
 WHERE entity_kind = 'multi_entity';

ALTER TABLE register_item_securities
    DROP CONSTRAINT IF EXISTS register_item_securities_entity_kind_check;
ALTER TABLE register_item_securities
    ADD CONSTRAINT register_item_securities_entity_kind_check
        CHECK (entity_kind IN (
            'listed',
            'private_company',
            'family_trust',
            'smsf',
            'managed_fund',
            'foreign',
            'not_an_entity'
        ));

UPDATE register_item_locations
   SET resolution_status = 'unmatched'
 WHERE resolution_status = 'not_a_location';

ALTER TABLE register_item_locations
    DROP CONSTRAINT IF EXISTS register_item_locations_status_check;
ALTER TABLE register_item_locations
    ADD CONSTRAINT register_item_locations_status_check
        CHECK (resolution_status IN (
            'resolved', 'ambiguous', 'region', 'no_state', 'unmatched'
        ));

ALTER TABLE register_holding_periods
    ALTER COLUMN entity_kind SET DEFAULT 'listed';

COMMENT ON COLUMN register_holding_periods.entity_kind IS
    'Carried through the fold from register_item_securities. Items 3 and 5-14 have no security candidate and stay ''listed'' by default, which no surface reads.';
