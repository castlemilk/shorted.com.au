-- State lower-house member + party per suburb (current-term members from each
-- parliament, district-matched). Single-member states only (NSW/VIC/QLD/WA/SA/NT);
-- TAS/ACT are Hare-Clark multi-member so state_member/party stay NULL there.
ALTER TABLE suburb_demographics
    ADD COLUMN IF NOT EXISTS state_member   TEXT,
    ADD COLUMN IF NOT EXISTS state_party    TEXT,
    ADD COLUMN IF NOT EXISTS state_party_ab TEXT;
