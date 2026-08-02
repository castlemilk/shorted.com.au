-- AEC Transparency Register — the political funding layer.
--
-- Namespaced `aec_` and DELIBERATELY OUTSIDE the register-of-interests
-- subsystem. The register discloses WHAT is held and never how much, and a
-- migration guard test asserts no magnitude column appears anywhere in it.
-- These tables carry amounts LAWFULLY: AEC bulk data is CC BY 4.0 (Crown
-- copyright, © Commonwealth of Australia) and the editorial standards doc's own
-- worked example blesses "Donated $250k (AEC)". Nothing here references a
-- register_ table, and nothing in the register references these.
--
-- Every amount is an INTEGER `*_cents BIGINT`. The source publishes whole
-- dollars (measured: zero decimal values across all 209k amount cells), so
-- cents are exact and no float ever touches a funding figure. Negative amounts
-- are legitimate (2 candidate-donation rows are refunds/corrections) and are
-- preserved rather than filtered.
--
-- Right-censoring: values below the disclosure threshold in force for a given
-- year are ABSENT from the source. A low total here is a disclosure fact, not a
-- funding fact, and every surface rendering these tables must say so. The
-- funding-and-disclosure reform commences 1 January 2027 ($5k threshold,
-- near-real-time notices, caps); the last old-scheme annual corpus is FY2024-25.
-- Any series crossing that boundary needs a break annotation.
--
-- Snapshot semantics: the AEC regenerates the bulk zips continuously as
-- amendments land, so a published financial year is never frozen. Ingest is
-- snapshot-REPLACE inside one transaction, never an append, and `snapshot_at`
-- records when the corpus was taken.

-- ---------------------------------------------------------------------------
-- 1. Annual returns — party level.
--
-- Party Returns carries `Party Group`, so the branch → party rollup is IN THE
-- DATA and never inferred from the branch name. Rows with an empty Party Group
-- (minor parties that are their own group) roll up under their own name; the
-- ingest writes that fallback, not the view, so the grouping key is inspectable.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS aec_party_returns (
    id                            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    financial_year                TEXT NOT NULL,        -- verbatim label: '2011-12' OR '1998-1999'
    financial_year_end            SMALLINT NOT NULL,    -- calendar year the FY ends in
    party_name                    TEXT NOT NULL,        -- verbatim, whitespace-trimmed only
    party_name_norm               TEXT NOT NULL,        -- normalizeAECEntityName()
    party_group                   TEXT NOT NULL DEFAULT '',
    party_group_key               TEXT NOT NULL,        -- party_group, or party_name when blank
    total_receipts_cents          BIGINT NOT NULL DEFAULT 0,
    total_payments_cents          BIGINT NOT NULL DEFAULT 0,
    total_debts_cents             BIGINT NOT NULL DEFAULT 0,
    total_discretionary_cents     BIGINT NOT NULL DEFAULT 0,
    occurrence                    INTEGER NOT NULL DEFAULT 1,
    source_url                    TEXT NOT NULL,
    source_licence                TEXT NOT NULL DEFAULT 'CC-BY-4.0',
    snapshot_at                   TIMESTAMPTZ NOT NULL DEFAULT now(),
    -- (financial_year, party_name) is NOT unique: eleven FY/name pairs carry
    -- several returns because separate state branches lodge under one
    -- identical registered name (Christian Democratic Party (Fred Nile Group)
    -- files six for FY2005-06, two of them byte-identical). Those are distinct
    -- returns, not duplicates — collapsing them would understate the party.
    UNIQUE (financial_year, party_name, total_receipts_cents, total_payments_cents,
            total_debts_cents, total_discretionary_cents, occurrence)
);
CREATE INDEX IF NOT EXISTS idx_aec_party_returns_group
    ON aec_party_returns (party_group_key, financial_year_end DESC);
CREATE INDEX IF NOT EXISTS idx_aec_party_returns_fy
    ON aec_party_returns (financial_year_end DESC);
CREATE INDEX IF NOT EXISTS idx_aec_party_returns_norm
    ON aec_party_returns (party_name_norm);

COMMENT ON TABLE aec_party_returns IS
    'AEC annual party return totals (CC BY 4.0). Snapshot-replaced each ingest; a published financial year is never frozen because amendments land continuously.';
COMMENT ON COLUMN aec_party_returns.party_group_key IS
    'Rollup key: the source Party Group when present, otherwise the party name itself so a group-less minor party is never silently dropped from a rollup.';

-- ---------------------------------------------------------------------------
-- 2. Itemised receipts — the recipient-declared side.
--
-- 124,280 rows. `receipt_type` distinguishes a donation from an "other receipt"
-- or a subscription, and that distinction MUST survive to the UI: a conference
-- fee is not a donation.
--
-- BYTE-IDENTICAL DUPLICATE ROWS ARE REAL (a donor can make the same gift twice
-- on the same day), so `occurrence` is a 1-based counter over identical source
-- tuples. Deduplicating them would understate declared funding; without the
-- counter the natural key collides.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS aec_receipts (
    id                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    financial_year       TEXT NOT NULL,
    financial_year_end   SMALLINT NOT NULL,
    return_type          TEXT NOT NULL DEFAULT '',
    recipient_name       TEXT NOT NULL,       -- verbatim
    recipient_name_norm  TEXT NOT NULL,
    received_from        TEXT NOT NULL,       -- verbatim; the paying side
    received_from_norm   TEXT NOT NULL,
    receipt_type         TEXT NOT NULL DEFAULT '',
    amount_cents         BIGINT NOT NULL,
    occurrence           INTEGER NOT NULL DEFAULT 1,
    source_url           TEXT NOT NULL,
    source_licence       TEXT NOT NULL DEFAULT 'CC-BY-4.0',
    snapshot_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (financial_year, return_type, recipient_name, received_from, receipt_type, amount_cents, occurrence)
);
CREATE INDEX IF NOT EXISTS idx_aec_receipts_payer
    ON aec_receipts (received_from_norm, financial_year_end DESC);
CREATE INDEX IF NOT EXISTS idx_aec_receipts_recipient
    ON aec_receipts (recipient_name_norm, financial_year_end DESC);
CREATE INDEX IF NOT EXISTS idx_aec_receipts_fy
    ON aec_receipts (financial_year_end DESC);

COMMENT ON COLUMN aec_receipts.occurrence IS
    'One-based counter over BYTE-IDENTICAL source rows. Identical duplicates in the AEC export are legitimate repeated transactions, not a parser artefact — dedup would understate declared funding.';
COMMENT ON COLUMN aec_receipts.receipt_type IS
    'Source distinction between a donation, an other receipt and a subscription. It must be rendered: a conference fee is not a donation.';

-- ---------------------------------------------------------------------------
-- 3. Donations made — the donor-declared side (66,248 rows).
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS aec_donations_made (
    id                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    financial_year       TEXT NOT NULL,
    financial_year_end   SMALLINT NOT NULL,
    donor_name           TEXT NOT NULL,       -- verbatim
    donor_name_norm      TEXT NOT NULL,
    made_to              TEXT NOT NULL,       -- verbatim
    made_to_norm         TEXT NOT NULL,
    donation_date        DATE,                -- NULL when the return omits it
    amount_cents         BIGINT NOT NULL,
    occurrence           INTEGER NOT NULL DEFAULT 1,
    source_url           TEXT NOT NULL,
    source_licence       TEXT NOT NULL DEFAULT 'CC-BY-4.0',
    snapshot_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (financial_year, donor_name, made_to, donation_date, amount_cents, occurrence)
);
CREATE INDEX IF NOT EXISTS idx_aec_donations_made_donor
    ON aec_donations_made (donor_name_norm, financial_year_end DESC);
CREATE INDEX IF NOT EXISTS idx_aec_donations_made_recipient
    ON aec_donations_made (made_to_norm, financial_year_end DESC);
CREATE INDEX IF NOT EXISTS idx_aec_donations_made_fy
    ON aec_donations_made (financial_year_end DESC);

-- ---------------------------------------------------------------------------
-- 4. Member-of-parliament annual returns.
--
-- 52 ROWS, ~16 MEMBERS, FY2020-21 ONWARDS. This layer is THIN and any surface
-- built on it must state its own coverage or it lies by construction. A member
-- with no row here has not been shown to receive nothing — most members simply
-- do not lodge this return.
--
-- politician_id is NULLABLE and stays NULL on ANY ambiguity. A name search once
-- matched "Anthony Smith" to Dean Smith; withholding is the only safe default.
-- The FK is deliberately ON DELETE SET NULL: losing the join must degrade the
-- row to its verbatim name, never delete a declared fact.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS aec_mp_returns (
    id                      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    financial_year          TEXT NOT NULL,
    financial_year_end      SMALLINT NOT NULL,
    return_type             TEXT NOT NULL,       -- 'Member of House of Representatives Return' | 'Senator Return'
    chamber                 TEXT NOT NULL DEFAULT 'unknown',
    member_name             TEXT NOT NULL,       -- verbatim, e.g. 'Ms Zali Steggall OAM MP'
    member_name_norm        TEXT NOT NULL,       -- honorific/post-nominal stripped, upper-cased
    surname                 TEXT NOT NULL DEFAULT '',
    given_names             TEXT NOT NULL DEFAULT '',
    total_donations_cents   BIGINT NOT NULL DEFAULT 0,
    donor_count             INTEGER NOT NULL DEFAULT 0,
    politician_id           UUID REFERENCES politicians(id) ON DELETE SET NULL,
    resolution_method       TEXT NOT NULL DEFAULT 'unresolved',
    source_url              TEXT NOT NULL,
    source_licence          TEXT NOT NULL DEFAULT 'CC-BY-4.0',
    snapshot_at             TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (financial_year, return_type, member_name),
    CONSTRAINT aec_mp_returns_chamber_check
        CHECK (chamber IN ('house', 'senate', 'unknown')),
    CONSTRAINT aec_mp_returns_resolution_check
        CHECK (resolution_method IN ('unresolved', 'curated_alias', 'surname_given_exact')),
    -- A resolution method may never be recorded without the join it claims, and
    -- a join may never exist without the method that produced it.
    CONSTRAINT aec_mp_returns_resolution_needs_politician
        CHECK ((politician_id IS NULL) = (resolution_method = 'unresolved'))
);
CREATE INDEX IF NOT EXISTS idx_aec_mp_returns_politician
    ON aec_mp_returns (politician_id, financial_year_end DESC) WHERE politician_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_aec_mp_returns_fy
    ON aec_mp_returns (financial_year_end DESC);

COMMENT ON TABLE aec_mp_returns IS
    'AEC annual member/senator returns (CC BY 4.0). 52 rows across ~16 members from FY2020-21 — a thin layer. Any surface must state its coverage; absence of a row is not evidence of nil receipts.';
COMMENT ON COLUMN aec_mp_returns.politician_id IS
    'NULL on ANY ambiguity. An unresolved return is publishable under its verbatim name on party-level surfaces only, never on a member page.';

-- ---------------------------------------------------------------------------
-- 5. Election candidate return summaries — the honest member layer.
--
-- 16,197 returns across 30 events, 11,012 of them NIL. A nil return is a
-- PUBLISHABLE FACT ("lodged a nil return for the 2025 election"), which is why
-- nil_return is stored rather than the row being dropped.
--
-- Senate Group returns carry a STATE in electorate_name, not a division; the
-- resolver never treats them as a division match.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS aec_candidate_returns (
    id                       UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    event                    TEXT NOT NULL,       -- verbatim, e.g. '2025 Federal Election'
    event_year               SMALLINT,
    event_parliament         SMALLINT,            -- the parliament the event elected; NULL for by-elections/unmapped
    return_type              TEXT NOT NULL,       -- 'Candidate' | 'Senate Group'
    candidate_name           TEXT NOT NULL,       -- verbatim 'SURNAME, Given Names'
    surname                  TEXT NOT NULL DEFAULT '',
    given_names              TEXT NOT NULL DEFAULT '',
    party_id                 TEXT NOT NULL DEFAULT '',
    party_name               TEXT NOT NULL DEFAULT '',
    electorate_name          TEXT NOT NULL DEFAULT '',
    electorate_state         TEXT NOT NULL DEFAULT '',
    nil_return               BOOLEAN NOT NULL DEFAULT FALSE,
    amendment_no             INTEGER NOT NULL DEFAULT 0,
    total_gift_cents         BIGINT NOT NULL DEFAULT 0,
    donor_count              INTEGER NOT NULL DEFAULT 0,
    expenditure_cents        BIGINT NOT NULL DEFAULT 0,
    discretionary_cents      BIGINT NOT NULL DEFAULT 0,
    politician_id            UUID REFERENCES politicians(id) ON DELETE SET NULL,
    resolution_method        TEXT NOT NULL DEFAULT 'unresolved',
    source_url               TEXT NOT NULL,
    source_licence           TEXT NOT NULL DEFAULT 'CC-BY-4.0',
    snapshot_at              TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (event, return_type, candidate_name, electorate_name),
    CONSTRAINT aec_candidate_returns_resolution_check
        CHECK (resolution_method IN ('unresolved', 'curated_alias', 'division_surname_exact')),
    CONSTRAINT aec_candidate_returns_resolution_needs_politician
        CHECK ((politician_id IS NULL) = (resolution_method = 'unresolved'))
);
CREATE INDEX IF NOT EXISTS idx_aec_candidate_returns_politician
    ON aec_candidate_returns (politician_id, event_year DESC) WHERE politician_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_aec_candidate_returns_event
    ON aec_candidate_returns (event, return_type);
CREATE INDEX IF NOT EXISTS idx_aec_candidate_returns_division
    ON aec_candidate_returns (upper(electorate_name), event_parliament)
    WHERE electorate_name <> '';

COMMENT ON COLUMN aec_candidate_returns.nil_return IS
    'A lodged nil return is a publishable fact, not missing data. 11,012 of 16,197 returns are nil.';

-- ---------------------------------------------------------------------------
-- 6. Itemised candidate donations (2,267 rows).
--
-- candidate_return_id links back to the summary; ON DELETE CASCADE because a
-- donation without its return has no attribution context.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS aec_candidate_donations (
    id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    candidate_return_id   UUID REFERENCES aec_candidate_returns(id) ON DELETE CASCADE,
    event                 TEXT NOT NULL,
    event_year            SMALLINT,
    return_type           TEXT NOT NULL DEFAULT '',
    candidate_name        TEXT NOT NULL,       -- verbatim
    donor_name            TEXT NOT NULL,       -- verbatim
    donor_name_norm       TEXT NOT NULL,
    donation_date         DATE,
    amount_cents          BIGINT NOT NULL,
    occurrence            INTEGER NOT NULL DEFAULT 1,
    source_url            TEXT NOT NULL,
    source_licence        TEXT NOT NULL DEFAULT 'CC-BY-4.0',
    snapshot_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (event, return_type, candidate_name, donor_name, donation_date, amount_cents, occurrence)
);
CREATE INDEX IF NOT EXISTS idx_aec_candidate_donations_return
    ON aec_candidate_donations (candidate_return_id);
CREATE INDEX IF NOT EXISTS idx_aec_candidate_donations_donor
    ON aec_candidate_donations (donor_name_norm, event_year DESC);

-- ---------------------------------------------------------------------------
-- 7. The single curated control surface.
--
-- Mirrors register_security_aliases: every row is a human decision, and the
-- resolvers read this FIRST, then the exact rules, and NEVER a fuzzy match.
-- target_kind 'ignore' actively SUPPRESSES an exact match that a human has
-- judged wrong — that is the only way to override the automatic layer, so the
-- override is always inspectable in one table.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS aec_entity_aliases (
    alias_norm    TEXT PRIMARY KEY,
    target_kind   TEXT NOT NULL,
    stock_code    VARCHAR(50),
    politician_id UUID REFERENCES politicians(id) ON DELETE CASCADE,
    party_group   TEXT NOT NULL DEFAULT '',
    display_name  TEXT NOT NULL DEFAULT '',
    note          TEXT NOT NULL DEFAULT '',
    curated_by    TEXT NOT NULL DEFAULT '',
    curated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT aec_entity_aliases_kind_check
        CHECK (target_kind IN ('company', 'politician', 'party_group', 'ignore')),
    -- Each kind must carry exactly the target it names. A 'company' row without
    -- a stock code would silently drop the donor out of the match layer while
    -- looking curated.
    CONSTRAINT aec_entity_aliases_company_needs_code
        CHECK (target_kind <> 'company' OR stock_code IS NOT NULL),
    CONSTRAINT aec_entity_aliases_politician_needs_id
        CHECK (target_kind <> 'politician' OR politician_id IS NOT NULL),
    CONSTRAINT aec_entity_aliases_party_needs_group
        CHECK (target_kind <> 'party_group' OR party_group <> ''),
    CONSTRAINT aec_entity_aliases_ignore_has_no_target
        CHECK (target_kind <> 'ignore'
               OR (stock_code IS NULL AND politician_id IS NULL AND party_group = ''))
);
CREATE INDEX IF NOT EXISTS idx_aec_entity_aliases_kind
    ON aec_entity_aliases (target_kind);
CREATE INDEX IF NOT EXISTS idx_aec_entity_aliases_stock
    ON aec_entity_aliases (stock_code) WHERE stock_code IS NOT NULL;

COMMENT ON TABLE aec_entity_aliases IS
    'Hand-curated normalised-name → target map for AEC entity resolution. Read FIRST by every resolver. target_kind=''ignore'' suppresses an otherwise-exact match a human has judged wrong; there is no other override path.';

-- ---------------------------------------------------------------------------
-- 8. The exact-name company match layer.
--
-- Donation rows carry NO ABN, so the join is exact normalised name only —
-- the same normalisation as store.go's normExpr (upper, punctuation → space,
-- trailing corporate suffix stripped TWICE). A normalised name that collides
-- across stock codes is AMBIGUOUS and EXCLUDED ENTIRELY (82 of 4,412 company
-- names collide). "XYZ Pty Ltd" ≠ "XYZ Holdings"; when in doubt, don't join.
--
-- A VIEW, not a table: it must never go stale against company-metadata or the
-- curated aliases, and it is cheap (4.4k rows).
-- ---------------------------------------------------------------------------
CREATE OR REPLACE VIEW v_aec_company_name_matches AS
WITH company_norm AS (
    SELECT
        stock_code,
        btrim(regexp_replace(
            btrim(regexp_replace(
                btrim(regexp_replace(upper(company_name), '[^A-Z0-9]+', ' ', 'g')),
                ' (LIMITED|LTD|GROUP|HOLDINGS|CORPORATION|PLC|TRUST|PTY|PROPRIETARY)$', '')),
            ' (LIMITED|LTD|GROUP|HOLDINGS|CORPORATION|PLC|TRUST|PTY|PROPRIETARY)$', '')) AS name_norm,
        company_name
    FROM "company-metadata"
    WHERE company_name IS NOT NULL AND btrim(company_name) <> ''
),
unambiguous AS (
    SELECT name_norm, min(stock_code) AS stock_code, min(company_name) AS company_name
    FROM company_norm
    WHERE name_norm <> ''
    GROUP BY name_norm
    HAVING count(DISTINCT stock_code) = 1
)
-- Curated aliases first.
SELECT
    a.alias_norm            AS name_norm,
    a.stock_code            AS stock_code,
    NULLIF(a.display_name, '') AS company_name,
    'curated_alias'         AS match_method
FROM aec_entity_aliases a
WHERE a.target_kind = 'company'
UNION ALL
-- Then exact matches a human has not overridden or suppressed.
SELECT u.name_norm, u.stock_code, u.company_name, 'name_exact'
FROM unambiguous u
WHERE NOT EXISTS (
    SELECT 1 FROM aec_entity_aliases a
    WHERE a.alias_norm = u.name_norm
      AND a.target_kind IN ('company', 'ignore')
);

COMMENT ON VIEW v_aec_company_name_matches IS
    'Exact normalised-name → ASX code map for AEC donor/payer names. Curated aliases win; normalised names colliding across stock codes are excluded entirely (82 of 4,412). No fuzzy matching, ever.';

-- Branch → party-group map, taken from the source Party Group column rather
-- than inferred from a branch name.
CREATE OR REPLACE VIEW v_aec_party_group_names AS
SELECT DISTINCT ON (party_name_norm)
    party_name_norm AS name_norm,
    party_group_key
FROM aec_party_returns
WHERE party_name_norm <> ''
ORDER BY party_name_norm, financial_year_end DESC;

-- ---------------------------------------------------------------------------
-- 9. Party funding rollup: party group × financial year.
--
-- Receipts and donations join to a party group through the branch-name map
-- above, so a receipt whose recipient is not a party (an associated entity or
-- significant third party that never lodged a party return) contributes to no
-- group rather than being force-fitted into one.
-- ---------------------------------------------------------------------------
CREATE MATERIALIZED VIEW mv_aec_party_funding AS
WITH party_totals AS (
    SELECT
        financial_year,
        financial_year_end,
        party_group_key,
        count(*)::INTEGER            AS party_return_count,
        sum(total_receipts_cents)    AS total_receipts_cents,
        sum(total_payments_cents)    AS total_payments_cents,
        sum(total_debts_cents)       AS total_debts_cents
    FROM aec_party_returns
    GROUP BY financial_year, financial_year_end, party_group_key
),
receipt_totals AS (
    SELECT
        r.financial_year,
        r.financial_year_end,
        g.party_group_key,
        count(*)::INTEGER                       AS itemised_receipt_count,
        sum(r.amount_cents)                     AS itemised_receipts_cents,
        count(DISTINCT r.received_from_norm)::INTEGER AS distinct_payer_count,
        count(DISTINCT m.stock_code) FILTER (WHERE m.stock_code IS NOT NULL)::INTEGER
                                                AS listed_payer_count,
        COALESCE(sum(r.amount_cents) FILTER (WHERE m.stock_code IS NOT NULL), 0)
                                                AS listed_payer_cents
    FROM aec_receipts r
    JOIN v_aec_party_group_names g ON g.name_norm = r.recipient_name_norm
    LEFT JOIN v_aec_company_name_matches m ON m.name_norm = r.received_from_norm
    GROUP BY r.financial_year, r.financial_year_end, g.party_group_key
),
donation_totals AS (
    SELECT
        d.financial_year,
        d.financial_year_end,
        g.party_group_key,
        count(*)::INTEGER                       AS donation_count,
        sum(d.amount_cents)                     AS donations_cents,
        count(DISTINCT d.donor_name_norm)::INTEGER AS distinct_donor_count,
        count(DISTINCT m.stock_code) FILTER (WHERE m.stock_code IS NOT NULL)::INTEGER
                                                AS listed_donor_count,
        COALESCE(sum(d.amount_cents) FILTER (WHERE m.stock_code IS NOT NULL), 0)
                                                AS listed_donor_cents
    FROM aec_donations_made d
    JOIN v_aec_party_group_names g ON g.name_norm = d.made_to_norm
    LEFT JOIN v_aec_company_name_matches m ON m.name_norm = d.donor_name_norm
    GROUP BY d.financial_year, d.financial_year_end, g.party_group_key
),
keys AS (
    SELECT financial_year, financial_year_end, party_group_key FROM party_totals
    UNION
    SELECT financial_year, financial_year_end, party_group_key FROM receipt_totals
    UNION
    SELECT financial_year, financial_year_end, party_group_key FROM donation_totals
)
SELECT
    k.party_group_key,
    k.financial_year,
    k.financial_year_end,
    COALESCE(p.party_return_count, 0)        AS party_return_count,
    COALESCE(p.total_receipts_cents, 0)      AS total_receipts_cents,
    COALESCE(p.total_payments_cents, 0)      AS total_payments_cents,
    COALESCE(p.total_debts_cents, 0)         AS total_debts_cents,
    COALESCE(r.itemised_receipt_count, 0)    AS itemised_receipt_count,
    COALESCE(r.itemised_receipts_cents, 0)   AS itemised_receipts_cents,
    COALESCE(r.distinct_payer_count, 0)      AS distinct_payer_count,
    COALESCE(r.listed_payer_count, 0)        AS listed_payer_count,
    COALESCE(r.listed_payer_cents, 0)        AS listed_payer_cents,
    COALESCE(d.donation_count, 0)            AS donation_count,
    COALESCE(d.donations_cents, 0)           AS donations_cents,
    COALESCE(d.distinct_donor_count, 0)      AS distinct_donor_count,
    COALESCE(d.listed_donor_count, 0)        AS listed_donor_count,
    COALESCE(d.listed_donor_cents, 0)        AS listed_donor_cents,
    -- Right-censoring is a property of EVERY row here, carried in the data so a
    -- surface cannot render a total without the disclosure caveat being at hand.
    TRUE                                     AS threshold_censored,
    -- The new scheme commences 1 Jan 2027; FY2027 onwards is a different regime
    -- and must not be splice-charted with what precedes it.
    (k.financial_year_end >= 2027)           AS post_reform_scheme
FROM keys k
LEFT JOIN party_totals p
    ON p.financial_year = k.financial_year AND p.party_group_key = k.party_group_key
LEFT JOIN receipt_totals r
    ON r.financial_year = k.financial_year AND r.party_group_key = k.party_group_key
LEFT JOIN donation_totals d
    ON d.financial_year = k.financial_year AND d.party_group_key = k.party_group_key;

CREATE UNIQUE INDEX IF NOT EXISTS idx_mv_aec_party_funding_key
    ON mv_aec_party_funding (party_group_key, financial_year);
CREATE INDEX IF NOT EXISTS idx_mv_aec_party_funding_fy
    ON mv_aec_party_funding (financial_year_end DESC, total_receipts_cents DESC);

COMMENT ON MATERIALIZED VIEW mv_aec_party_funding IS
    'Party group × financial year funding rollup from AEC returns (CC BY 4.0). Every total is right-censored at the disclosure threshold in force for that year; post_reform_scheme marks FY2027+ rows, which are a different regime and must carry a break annotation.';

-- ---------------------------------------------------------------------------
-- 10. Refresh wiring.
--
-- Separate from refresh_register_materialized_views() and from the daily shorts
-- refresh: this MV is rebuilt by the ingest that writes its inputs, not by an
-- unrelated schedule. statement_timeout 0 because prod's pooler default kills a
-- full refresh (the lesson from 000095).
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION refresh_aec_donations_materialized_views()
RETURNS void
LANGUAGE plpgsql
AS $$
BEGIN
    RAISE NOTICE 'Refreshing mv_aec_party_funding (concurrently)...';
    BEGIN
        BEGIN
            REFRESH MATERIALIZED VIEW CONCURRENTLY mv_aec_party_funding;
        EXCEPTION WHEN query_canceled OR OTHERS THEN
            RAISE WARNING 'Failed to refresh mv_aec_party_funding concurrently: %. Trying non-concurrent...', SQLERRM;
            REFRESH MATERIALIZED VIEW mv_aec_party_funding;
        END;
    EXCEPTION WHEN query_canceled OR OTHERS THEN
        RAISE WARNING 'Skipping mv_aec_party_funding: %', SQLERRM;
    END;
END;
$$;

ALTER FUNCTION refresh_aec_donations_materialized_views() SET statement_timeout TO '0';
