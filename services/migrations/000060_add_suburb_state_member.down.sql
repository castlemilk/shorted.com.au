ALTER TABLE suburb_demographics
    DROP COLUMN IF EXISTS state_member,
    DROP COLUMN IF EXISTS state_party,
    DROP COLUMN IF EXISTS state_party_ab;
