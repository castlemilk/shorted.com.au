-- entity_kind: WHAT a declared interest is, not merely whether it matched.
--
-- WHY THIS EXISTS: aph_resolve.go already computes the discriminators — c.Private
-- (privateCompanyRe: Pty/proprietary/family trust/superannuation fund/SMSF),
-- nonSecurityRe and giftLogRe — and then collapses all of them into
-- resolution_status='not_a_security'. That name means "not a LISTED security",
-- but it reads as "not real", and nothing records WHICH kind of thing it was.
--
-- The cost of throwing that away is paid twice:
--
--   1. A READER cannot tell a family trust from a company we simply failed to
--      match. DeclaredEntity renders every unresolved row as
--      "<text> — not matched to an ASX listing". For "The Indinup Trust" that is
--      technically true and editorially useless: a trust can never have a
--      ticker, so the apology describes a system failure that did not happen.
--   2. The RESOLUTION GATE counts trusts, SMSFs and private companies in its
--      denominator, so the headline rate measures how many members hold
--      unlistable things. 17,923 of 18,799 published rows carry no ticker.
--
-- This column is PLUMBING: every value is derived from a discriminator that
-- already existed, so no new inference and no fuzzy matching is introduced. See
-- docs/politician-register-architecture.md §8.14.
--
-- 'foreign' is permitted but has NO automatic producer today, deliberately. The
-- corpus contains 14 distinct Inc/LLC/plc names and four of them are Australian
-- incorporated ASSOCIATIONS ("Street Law Centre (WA) Inc.", "EMILY'S LIST
-- (AUSTRALIA) INC."). Labelling those "Foreign listing" would state a wrong fact
-- about a named person's directorship, so the value is reserved for a curated
-- alias decision rather than a suffix guess.

ALTER TABLE register_item_securities
    ADD COLUMN IF NOT EXISTS entity_kind TEXT NOT NULL DEFAULT 'listed';

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
            'not_an_entity'     -- prose, a nil marker, a gift/travel log line
        ));

COMMENT ON COLUMN register_item_securities.entity_kind IS
    'What the declared candidate IS. Derived from the discriminators aph_resolve.go already computes; NOT an independent classifier. Only entity_kind=''listed'' belongs in the resolution gate denominator.';

-- Everything downstream of the resolver needs the label too, or the read path
-- cannot render it: the fold writes register_holding_periods and the public MV
-- reads only from there.
ALTER TABLE register_holding_periods
    ADD COLUMN IF NOT EXISTS entity_kind TEXT NOT NULL DEFAULT 'listed';

COMMENT ON COLUMN register_holding_periods.entity_kind IS
    'Carried through the fold from register_item_securities. Items 3 and 5-14 have no security candidate and stay ''listed'' by default, which no surface reads.';

-- The MV must be rebuilt rather than altered: a materialized view's column list
-- is fixed at creation. Definition is 000096's, plus hp.entity_kind.
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
    hp.entity_kind,
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
