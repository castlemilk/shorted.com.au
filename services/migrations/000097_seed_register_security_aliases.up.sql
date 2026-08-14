-- Starter curation for register_security_aliases.
--
-- WHY THIS EXISTS: exact-normalised name matching cannot reach the two commonest
-- ways a member writes a holding.
--
--   1. Ticker shorthand. A member writes "CBA" or "NAB"; those are CODES, not
--      names, so they never normalise to "COMMONWEALTH BANK OF AUSTRALIA".
--   2. Everyday short names. "Westpac Bank", "Commonwealth Bank Shares" and
--      "Rio" are not the registered company names.
--
-- EDITORIAL BAR (docs/influence-editorial-standards.md §2): every row here is a
-- human decision, which is what keeps these at the "verified manual mapping"
-- standard rather than a fuzzy guess. Each alias below is an unambiguous,
-- well-known Australian listing, checked against "company-metadata".
--
-- alias_norm must be the output of normalizeEntityName(): uppercased,
-- non-alphanumerics stripped, then corporate suffixes (LIMITED/LTD/GROUP/
-- HOLDINGS/CORPORATION/PLC/TRUST/PTY/PROPRIETARY) removed twice.
--
-- This is a SEED, not the finished job. The curation worklist is the
-- register_resolution_backlog view, ordered by frequency.

INSERT INTO register_security_aliases
    (alias_norm, stock_code, alias_kind, display_name, resolution, note, curated_by)
VALUES
    -- Big-four banks: ticker shorthand and everyday short names.
    ('CBA',                     'CBA', 'equity', 'Commonwealth Bank of Australia', 'resolved', 'Ticker shorthand for Commonwealth Bank.', 'seed'),
    ('COMMONWEALTH BANK',       'CBA', 'equity', 'Commonwealth Bank of Australia', 'resolved', 'Everyday short name.', 'seed'),
    ('COMMONWEALTH BANK SHARES','CBA', 'equity', 'Commonwealth Bank of Australia', 'resolved', 'Everyday short name with a redundant "shares" suffix.', 'seed'),
    ('COMMBANK',                'CBA', 'equity', 'Commonwealth Bank of Australia', 'resolved', 'Brand name.', 'seed'),
    ('WESTPAC',                 'WBC', 'equity', 'Westpac Banking Corporation',    'resolved', 'Everyday short name.', 'seed'),
    ('WESTPAC BANK',            'WBC', 'equity', 'Westpac Banking Corporation',    'resolved', 'Everyday short name.', 'seed'),
    ('WBC',                     'WBC', 'equity', 'Westpac Banking Corporation',    'resolved', 'Ticker shorthand.', 'seed'),
    ('NAB',                     'NAB', 'equity', 'National Australia Bank',        'resolved', 'Ticker shorthand / brand name.', 'seed'),
    ('NATIONAL AUSTRALIA BANK', 'NAB', 'equity', 'National Australia Bank',        'resolved', 'Full name; "BANK" is not stripped by the normaliser.', 'seed'),
    ('ANZ',                     'ANZ', 'equity', 'ANZ Group Holdings',             'resolved', 'Ticker shorthand / brand name.', 'seed'),
    ('ANZ BANK',                'ANZ', 'equity', 'ANZ Group Holdings',             'resolved', 'Everyday short name.', 'seed'),

    -- Other large caps written short.
    ('RIO',                     'RIO', 'equity', 'Rio Tinto',                      'resolved', 'Everyday short name.', 'seed'),
    ('RIO TINTO',               'RIO', 'equity', 'Rio Tinto',                      'resolved', 'Full name.', 'seed'),
    ('BHP BILLITON',            'BHP', 'equity', 'BHP Group',                      'resolved', 'Former name, still written by members.', 'seed'),
    ('TELSTRA CORPORATION',     'TLS', 'equity', 'Telstra Group',                  'resolved', 'Former registered name.', 'seed'),
    ('WOOLWORTHS',              'WOW', 'equity', 'Woolworths Group',               'resolved', 'Everyday short name.', 'seed'),
    ('WOOLIES',                 'WOW', 'equity', 'Woolworths Group',               'resolved', 'Colloquial name.', 'seed'),
    ('COLES',                   'COL', 'equity', 'Coles Group',                    'resolved', 'Everyday short name.', 'seed'),
    ('WESFARMERS',              'WES', 'equity', 'Wesfarmers',                     'resolved', 'Everyday short name.', 'seed'),
    ('MACQUARIE',               'MQG', 'equity', 'Macquarie Group',                'resolved', 'Everyday short name.', 'seed'),
    ('MACQUARIE BANK',          'MQG', 'equity', 'Macquarie Group',                'resolved', 'Everyday short name.', 'seed'),
    ('QANTAS',                  'QAN', 'equity', 'Qantas Airways',                 'resolved', 'Everyday short name.', 'seed'),
    ('SUNCORP',                 'SUN', 'equity', 'Suncorp Group',                  'resolved', 'Everyday short name.', 'seed'),
    ('SUNCORP AUSTRALIA',       'SUN', 'equity', 'Suncorp Group',                  'resolved', 'Member-written variant.', 'seed'),
    ('FORTESCUE METALS',        'FMG', 'equity', 'Fortescue',                      'resolved', 'Former registered name.', 'seed'),
    ('CSL LIMITED',             'CSL', 'equity', 'CSL',                            'resolved', 'Suffix already stripped by the normaliser; kept for clarity.', 'seed'),

    -- Noise: meta-statements members write into the shareholdings cell. Recorded
    -- explicitly so they leave the curation backlog instead of burying real work.
    ('NIL APPLICABLE',           NULL, 'noise', '', 'not_a_security', 'Member wrote a nil declaration into the value cell.', 'seed'),
    ('NIL RETURN',               NULL, 'noise', '', 'not_a_security', 'Nil declaration.', 'seed'),
    ('NONE',                     NULL, 'noise', '', 'not_a_security', 'Nil declaration.', 'seed'),
    ('NO',                       NULL, 'noise', '', 'not_a_security', 'Parser fragment / nil declaration.', 'seed'),
    ('FUND',                     NULL, 'noise', '', 'not_a_security', 'Parser fragment, not an entity.', 'seed'),
    ('LTD',                      NULL, 'noise', '', 'not_a_security', 'Parser fragment, not an entity.', 'seed'),
    ('APPLICABLE',               NULL, 'noise', '', 'not_a_security', 'Parser fragment of "Not Applicable".', 'seed'),
    ('REFER TO JOINTLY HELD ASSETS', NULL, 'noise', '', 'not_a_security', 'Cross-reference, not an entity.', 'seed'),
    ('SEE ATTACHED',             NULL, 'noise', '', 'not_a_security', 'Cross-reference, not an entity.', 'seed'),

    -- Unlisted/wholesale funds: real declarations, but NOT ASX listings. These
    -- resolve with a NULL stock_code so the UI renders the declared text with no
    -- ticker link. The CHECK constraint makes getting this wrong impossible.
    ('MELCHIOR EUROPEAN OPPORTUNITIES',  NULL, 'managed_fund', '', 'unlisted_fund', 'Unlisted managed fund.', 'seed'),
    ('NEUBERGER BERMAN CONNECTIVITY',    NULL, 'managed_fund', '', 'unlisted_fund', 'Unlisted managed fund.', 'seed'),
    ('SEASONS GLOBAL PRIVATE EQUITY',    NULL, 'managed_fund', '', 'unlisted_fund', 'Unlisted private-equity fund.', 'seed'),
    ('BENNELONG AUSTRALIAN EQUITIES',    NULL, 'managed_fund', '', 'unlisted_fund', 'Unlisted managed fund.', 'seed'),
    ('VANGUARD CASH RESERVE',            NULL, 'managed_fund', '', 'unlisted_fund', 'Unlisted cash fund; distinct from any listed Vanguard ETF.', 'seed'),
    ('AUSTRALIAN ETHICAL AUSTRALIAN SHARES', NULL, 'managed_fund', '', 'unlisted_fund', 'Unlisted managed fund.', 'seed'),
    ('NANUK NEW WORLD',                  NULL, 'managed_fund', '', 'unlisted_fund', 'Unlisted managed fund.', 'seed')
ON CONFLICT (alias_norm) DO NOTHING;
