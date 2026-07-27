-- Reverse 000098_add_entity_kind.
--
-- The MV is rebuilt to 000096's exact column list first, because dropping a
-- column a materialized view selects would fail.

DROP MATERIALIZED VIEW IF EXISTS mv_register_public_holdings;

CREATE MATERIALIZED VIEW mv_register_public_holdings AS
WITH latest_term AS (
    SELECT DISTINCT ON (politician_id)
           politician_id, parliament, chamber, division, state_code, party, party_ab
    FROM politician_terms
    ORDER BY politician_id, parliament DESC
)
SELECT
    hp.politician_id,
    p.display_name,
    p.slug,
    p.aph_mpid,
    t.chamber,
    t.division,
    t.state_code                       AS member_state,
    t.party,
    t.party_ab,
    hp.item_no,
    hp.holder,
    hp.declared_text,
    hp.secondary_text,
    hp.stock_code,
    cm.company_name,
    cm.industry,
    hp.sal_code,
    sd.sal_name,
    sd.state_code                      AS property_state,
    hp.declared_from,
    hp.declared_from_known,
    hp.declared_to,
    (hp.declared_to IS NULL)           AS currently_declared,
    hp.source_url,
    hp.source_licence,
    now()                              AS refreshed_at
FROM register_holding_periods hp
JOIN politicians p
    ON p.id = hp.politician_id
   AND p.merged_into_id IS NULL
LEFT JOIN latest_term t ON t.politician_id = hp.politician_id
LEFT JOIN "company-metadata" cm ON cm.stock_code = hp.stock_code
LEFT JOIN suburb_demographics sd ON sd.sal_code = hp.sal_code;

CREATE UNIQUE INDEX IF NOT EXISTS idx_mv_register_public_holdings
    ON mv_register_public_holdings
       (politician_id, item_no, holder, declared_text, declared_from);
CREATE INDEX IF NOT EXISTS idx_mv_register_public_holdings_stock
    ON mv_register_public_holdings (stock_code) WHERE stock_code IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_mv_register_public_holdings_sal
    ON mv_register_public_holdings (sal_code) WHERE sal_code IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_mv_register_public_holdings_slug
    ON mv_register_public_holdings (slug);

ALTER TABLE register_holding_periods DROP COLUMN IF EXISTS entity_kind;

ALTER TABLE register_item_securities
    DROP CONSTRAINT IF EXISTS register_item_securities_entity_kind_check;
ALTER TABLE register_item_securities DROP COLUMN IF EXISTS entity_kind;
