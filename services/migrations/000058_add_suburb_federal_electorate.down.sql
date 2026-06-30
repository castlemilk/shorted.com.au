ALTER TABLE suburb_demographics
    DROP COLUMN IF EXISTS federal_division,
    DROP COLUMN IF EXISTS federal_member,
    DROP COLUMN IF EXISTS federal_party,
    DROP COLUMN IF EXISTS federal_party_ab,
    DROP COLUMN IF EXISTS federal_tpp_alp;
