-- Federal electoral representation per suburb (AEC 2025 election, 48th Parliament).
-- Each suburb is spatially joined to its Commonwealth Electoral Division; we store
-- the sitting member + party (categorical "who holds the seat") and the Labor
-- two-party-preferred share (continuous "political lean"). Source: AEC (CC-BY-4.0).

ALTER TABLE suburb_demographics
    ADD COLUMN IF NOT EXISTS federal_division   TEXT,     -- Commonwealth Electoral Division name
    ADD COLUMN IF NOT EXISTS federal_member     TEXT,     -- sitting House of Reps member
    ADD COLUMN IF NOT EXISTS federal_party      TEXT,     -- member's party (full name)
    ADD COLUMN IF NOT EXISTS federal_party_ab   TEXT,     -- party abbreviation (palette key)
    ADD COLUMN IF NOT EXISTS federal_tpp_alp    NUMERIC;  -- 0..100 Labor two-party-preferred %
