-- Register of Members'/Senators' Interests — influence-layer schema.
--
-- Source: aph.gov.au. House = one PDF per member per parliament (44P-48P, 775
-- documents). Senate = combined tabled volumes (34 in the 2013+ window). Both
-- chambers use the same 14-item form with three holder rows (Self /
-- Spouse-Partner / Dependent children). A member's PDF contains their base
-- Statement of Registrable Interests followed by every dated Notification of
-- Alteration, each with explicit ADDITION / DELETION sections — so holdings are
-- event-sourced, not snapshots.
--
-- EDITORIAL (docs/influence-editorial-standards.md rule 5): the registers
-- disclose WHAT is held, NEVER quantity or value. There is deliberately no
-- amount / value / quantity / units / shares / price column anywhere in this
-- subsystem, and none may be added. register_of_interests.test.mjs asserts this
-- against this file's text.
--
-- LICENCE: parliamentary material, (c) Commonwealth. Extracted facts are
-- publishable with attribution; the PDFs are never rehosted. Public surfaces
-- deep-link source_url (aph.gov.au) with an as-at date. register_documents
-- .storage_uri points at a PRIVATE working cache and must never reach a read
-- path.
--
-- Design notes: docs/politician-register-architecture.md

-- ---------------------------------------------------------------------------
-- 1. Identity spine.
--
-- Names repeat across parliaments and people change seat, party and chamber, so
-- identity is a PERSON with many TERMS.
--
-- aph_mpid is populated opportunistically and never depended on: it is a stable
-- PERSON id (verified - Barnaby Joyce is MPID 'e5d' across both his Senate and
-- House service) but it does NOT appear on the Register listing pages, only on
-- Parliamentarian_Search_Results, so reaching it is itself a name join. Format
-- is opaque alphanumeric ('316915', 'R36', 'e5d') - store as TEXT, never parse.
--
-- The durable key is person_key (normalised surname + given names). The two
-- source name formats differ and both normalise into it:
--   Register listing <td>  'Albanese, Hon Anthony, Member for Grayndler, NSW'
--   Parliamentarian <a>    'Hon Anthony Albanese MP'
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS politicians (
    id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    person_key        TEXT NOT NULL UNIQUE,          -- 'ALBANESE|ANTHONY'
    surname           TEXT NOT NULL,
    given_names       TEXT NOT NULL DEFAULT '',
    display_name      TEXT NOT NULL,
    honorific         TEXT NOT NULL DEFAULT '',      -- 'Hon', 'Dr', 'Ms'
    slug              TEXT NOT NULL UNIQUE,          -- minted once, never reassigned
    aph_mpid          TEXT,
    first_parliament  SMALLINT,
    last_parliament   SMALLINT,
    merged_into_id    UUID REFERENCES politicians(id),
    source            TEXT NOT NULL DEFAULT 'aph-register-of-interests',
    source_licence    TEXT NOT NULL DEFAULT 'commonwealth-parliamentary-material',
    source_url        TEXT NOT NULL DEFAULT '',
    fetched_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
    created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT politicians_no_self_merge
        CHECK (merged_into_id IS NULL OR merged_into_id <> id)
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_politicians_aph_mpid
    ON politicians (aph_mpid) WHERE aph_mpid IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_politicians_surname ON politicians (upper(surname));

COMMENT ON COLUMN politicians.slug IS
    'URL slug, minted server-side once and never reassigned. Renames add a politician_aliases row; the read path returns this as canonical_slug and the web tier redirects on mismatch.';

-- Observed spellings, curated corrections, former names, and source filenames.
-- Filenames are audit-only: they are irregular (Scrymgour.pdf, Leeser46P.pdf,
-- ChesterD_48P.pdf, Dai_Le_48P.pdf, Llewellyn_OBrien48P.pdf) and must never be
-- used to derive identity.
CREATE TABLE IF NOT EXISTS politician_aliases (
    alias_key     TEXT PRIMARY KEY,                  -- normalised
    politician_id UUID NOT NULL REFERENCES politicians(id) ON DELETE CASCADE,
    alias_raw     TEXT NOT NULL,
    alias_kind    TEXT NOT NULL DEFAULT 'observed',
    curated_by    TEXT NOT NULL DEFAULT '',
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT politician_aliases_kind_check
        CHECK (alias_kind IN ('observed','curated','former_name','filename','slug'))
);
CREATE INDEX IF NOT EXISTS idx_politician_aliases_person
    ON politician_aliases (politician_id);

-- division deliberately uses the SAME vocabulary as
-- suburb_demographics.federal_division (populated by house-price-collector's
-- -mode electorates from web/public/geo/electorates/), which gives the
-- "suburbs this member represents" join for free.
CREATE TABLE IF NOT EXISTS politician_terms (
    id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    politician_id  UUID NOT NULL REFERENCES politicians(id) ON DELETE CASCADE,
    parliament     SMALLINT NOT NULL,
    chamber        TEXT NOT NULL,
    division       TEXT,                             -- House seat
    state_code     TEXT,                             -- Senate state; House seat's state
    party          TEXT,
    party_ab       TEXT,
    term_start     DATE,
    term_end       DATE,
    source         TEXT NOT NULL DEFAULT 'aph-register-of-interests',
    source_licence TEXT NOT NULL DEFAULT 'commonwealth-parliamentary-material',
    source_url     TEXT NOT NULL DEFAULT '',
    fetched_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT politician_terms_chamber_check CHECK (chamber IN ('house','senate')),
    UNIQUE (politician_id, parliament, chamber)
);
CREATE INDEX IF NOT EXISTS idx_politician_terms_division
    ON politician_terms (upper(division), parliament) WHERE division IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_politician_terms_state
    ON politician_terms (state_code, parliament) WHERE state_code IS NOT NULL;

-- ---------------------------------------------------------------------------
-- 2. Document manifest. One row per PHYSICAL PDF.
--
-- THIS IS THE CRAWL CURSOR: resumability and idempotence come from the
-- fetch/classify/extract status columns, not a separate runs table. Re-running
-- any mode is a no-op once its status column has advanced.
--
-- last_updated_at is the Register listing's own per-member date cell - a free
-- freshness signal that lets an incremental crawl skip unchanged documents.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS register_documents (
    id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    source_url        TEXT NOT NULL UNIQUE,
    listing_url       TEXT NOT NULL,
    chamber           TEXT NOT NULL,
    parliament        SMALLINT,
    member_hint       TEXT NOT NULL DEFAULT '',      -- raw listing name cell
    division_hint     TEXT NOT NULL DEFAULT '',
    state_hint        TEXT NOT NULL DEFAULT '',
    last_updated_at   DATE,                          -- listing 'date' cell
    listed_size_label TEXT NOT NULL DEFAULT '',      -- <img title="4948KB">
    volume_label      TEXT NOT NULL DEFAULT '',
    volume_range      TEXT NOT NULL DEFAULT '',      -- 'A-L' | 'M-Z'
    volume_ordinal    SMALLINT,
    tabled_from       DATE,
    tabled_to         DATE,
    statements_only   BOOLEAN,                       -- Senate volume label hint
    discovered_at     TIMESTAMPTZ NOT NULL DEFAULT now(),

    fetch_status      TEXT NOT NULL DEFAULT 'pending',
    fetch_attempts    SMALLINT NOT NULL DEFAULT 0,
    http_status       SMALLINT,
    fetch_error       TEXT NOT NULL DEFAULT '',
    fetched_at        TIMESTAMPTZ,
    content_sha256    TEXT,
    byte_size         BIGINT,
    storage_uri       TEXT,                          -- PRIVATE cache; never published

    classify_status   TEXT NOT NULL DEFAULT 'pending',
    page_count        INTEGER,
    text_chars_total  INTEGER,
    chars_per_page    NUMERIC,
    text_class        TEXT,
    -- Pages needing vision OCR, and pages with nothing on them. Kept apart
    -- deliberately: every born-digital statement carries a full-bleed
    -- letterhead, so counting "has an image" as a scan marks every blank
    -- continuation page for OCR — ~1,000 needless vision calls across the
    -- corpus. blank pages are excluded from the text-vs-scan judgement.
    scan_page_count   INTEGER,
    blank_page_count  INTEGER,

    extract_status    TEXT NOT NULL DEFAULT 'pending',
    extract_tier      TEXT,
    extractor_version TEXT,
    extracted_at      TIMESTAMPTZ,
    extract_error     TEXT NOT NULL DEFAULT '',
    page_coverage_pct NUMERIC,

    source            TEXT NOT NULL DEFAULT 'aph-register-of-interests',
    source_licence    TEXT NOT NULL DEFAULT 'commonwealth-parliamentary-material',
    created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at        TIMESTAMPTZ NOT NULL DEFAULT now(),

    CONSTRAINT register_documents_chamber_check
        CHECK (chamber IN ('house','senate')),
    CONSTRAINT register_documents_fetch_check
        CHECK (fetch_status IN ('pending','fetched','failed','blocked','skipped')),
    CONSTRAINT register_documents_classify_check
        CHECK (classify_status IN ('pending','classified','failed')),
    CONSTRAINT register_documents_extract_check
        CHECK (extract_status IN ('pending','extracted','partial','failed','skipped')),
    CONSTRAINT register_documents_textclass_check
        CHECK (text_class IS NULL OR text_class IN ('text','scan','mixed')),
    CONSTRAINT register_documents_tier_check
        CHECK (extract_tier IS NULL OR extract_tier IN ('deterministic','vision','hybrid'))
);
CREATE INDEX IF NOT EXISTS idx_register_documents_fetch_queue
    ON register_documents (fetch_status, parliament DESC, discovered_at);
CREATE INDEX IF NOT EXISTS idx_register_documents_extract_queue
    ON register_documents (extract_status, chamber, parliament DESC);
CREATE INDEX IF NOT EXISTS idx_register_documents_sha
    ON register_documents (content_sha256);

COMMENT ON COLUMN register_documents.storage_uri IS
    'Private GCS working cache only. Never expose on a read path - the licence permits extracted facts, not a PDF mirror. Public surfaces link source_url.';

-- ---------------------------------------------------------------------------
-- 3. Extraction artifacts. Content-addressed and versioned so a parser upgrade
--    coexists with the previous artifact instead of destroying it, and so
--    re-normalising costs no Gemini calls and no APH traffic.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS register_extractions (
    id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    document_id       UUID NOT NULL REFERENCES register_documents(id) ON DELETE CASCADE,
    content_sha256    TEXT NOT NULL,
    schema_version    TEXT NOT NULL,
    extractor_name    TEXT NOT NULL,
    extractor_version TEXT NOT NULL,
    tier              TEXT NOT NULL,
    model             TEXT NOT NULL DEFAULT '',
    payload           JSONB NOT NULL,
    payload_uri       TEXT NOT NULL DEFAULT '',
    statement_count   INTEGER NOT NULL DEFAULT 0,
    item_count        INTEGER NOT NULL DEFAULT 0,
    pages_covered     INTEGER NOT NULL DEFAULT 0,
    page_coverage_pct NUMERIC,
    warnings          JSONB NOT NULL DEFAULT '[]'::jsonb,
    input_tokens      INTEGER,
    output_tokens     INTEGER,
    created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT register_extractions_tier_check
        CHECK (tier IN ('deterministic','vision','hybrid')),
    UNIQUE (content_sha256, extractor_version, tier)
);
CREATE INDEX IF NOT EXISTS idx_register_extractions_document
    ON register_extractions (document_id, created_at DESC);

-- ---------------------------------------------------------------------------
-- 4. Logical statement.
--    House:  1 document -> 1 base statement + N dated alterations.
--    Senate: 1 volume   -> ~35-76 sections.
--
-- NOTE for the Senate parser: 'Form A' is a RUNNING PAGE HEADER, not a section
-- delimiter (2025 Volume 1 has 180 'Form A' lines but only 55 Surname: blocks
-- across 35 senators). Sections must anchor on the Surname:/Other names:/
-- State/Territory:/Date: header block. 'Form A - Alteration' remains a reliable
-- discriminator for statement_kind.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS register_statements (
    id                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    document_id          UUID NOT NULL REFERENCES register_documents(id) ON DELETE CASCADE,
    extraction_id        UUID REFERENCES register_extractions(id) ON DELETE SET NULL,
    politician_id        UUID REFERENCES politicians(id) ON DELETE SET NULL,
    statement_ordinal    SMALLINT NOT NULL,
    statement_kind       TEXT NOT NULL,
    chamber              TEXT NOT NULL,
    parliament           SMALLINT,
    declared_surname     TEXT NOT NULL DEFAULT '',
    declared_other_names TEXT NOT NULL DEFAULT '',
    declared_state       TEXT NOT NULL DEFAULT '',
    declared_division    TEXT NOT NULL DEFAULT '',
    lodged_date          DATE,
    date_is_stated       BOOLEAN NOT NULL DEFAULT FALSE,
    page_from            INTEGER,
    page_to              INTEGER,
    identity_status      TEXT NOT NULL DEFAULT 'unresolved',
    source_url           TEXT NOT NULL,
    source_licence       TEXT NOT NULL DEFAULT 'commonwealth-parliamentary-material',
    fetched_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
    created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT register_statements_kind_check
        CHECK (statement_kind IN ('base','alteration')),
    CONSTRAINT register_statements_chamber_check
        CHECK (chamber IN ('house','senate')),
    CONSTRAINT register_statements_identity_check
        CHECK (identity_status IN ('unresolved','resolved','ambiguous')),
    UNIQUE (document_id, statement_ordinal)
);
CREATE INDEX IF NOT EXISTS idx_register_statements_person
    ON register_statements (politician_id, lodged_date DESC) WHERE politician_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_register_statements_unresolved
    ON register_statements (identity_status) WHERE identity_status <> 'resolved';

COMMENT ON COLUMN register_statements.date_is_stated IS
    'FALSE when the form carried no legible date. The read path must render an unknown start, never infer or fabricate one.';

-- ---------------------------------------------------------------------------
-- 5. Raw declared items — all 14 categories, all three holders.
--
-- EDITORIAL rule 5: no quantity/value/amount column exists here or downstream.
--
-- Nil rows ARE stored (is_nil, declared_text preserved): "declared nothing under
-- item 1" is a fact in its own right, AND it is the anti-signal proving the
-- parser actually saw the item. A per-item null-rate alarm depends on it - item
-- 1 at 100% nil for a whole parliament is a broken parser, not 151 share-free
-- members.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS register_declared_items (
    id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    statement_id       UUID NOT NULL REFERENCES register_statements(id) ON DELETE CASCADE,
    politician_id      UUID REFERENCES politicians(id) ON DELETE SET NULL,
    item_no            SMALLINT NOT NULL,
    item_label         TEXT NOT NULL,
    holder             TEXT NOT NULL,
    change_type        TEXT NOT NULL,
    row_ordinal        SMALLINT NOT NULL DEFAULT 0,
    declared_text      TEXT NOT NULL,
    -- The PHYSICAL lines of the primary cell. The form lists one property (or
    -- one company) per line, so the joined text is often several entries welded
    -- together: "Warragul" + "Port Melbourne" flattens to a locality matching no
    -- suburb and loses both. The parser deliberately does not guess which breaks
    -- are wrapping — that is genuinely ambiguous — so both readings are kept and
    -- the resolvers try each.
    declared_lines     TEXT[] NOT NULL DEFAULT '{}',
    secondary_text     TEXT NOT NULL DEFAULT '',  -- item 3 Purpose / 6 Creditor / 4 Activities
    tertiary_text      TEXT NOT NULL DEFAULT '',  -- item 5 has three value columns
    is_nil             BOOLEAN NOT NULL DEFAULT FALSE,
    effective_from     DATE,
    page_no            INTEGER,
    extraction_id      UUID REFERENCES register_extractions(id) ON DELETE SET NULL,
    extract_confidence NUMERIC,
    contains_amount    BOOLEAN NOT NULL DEFAULT FALSE,   -- review flag, never published
    source_url         TEXT NOT NULL,
    source_licence     TEXT NOT NULL DEFAULT 'commonwealth-parliamentary-material',
    fetched_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
    created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT register_declared_items_item_check
        CHECK (item_no BETWEEN 1 AND 14),
    CONSTRAINT register_declared_items_holder_check
        CHECK (holder IN ('self','spouse_partner','dependent_children','unspecified')),
    CONSTRAINT register_declared_items_change_check
        CHECK (change_type IN ('declared','addition','deletion')),
    CONSTRAINT register_declared_items_conf_check
        CHECK (extract_confidence IS NULL
               OR (extract_confidence >= 0 AND extract_confidence <= 1)),
    UNIQUE (statement_id, item_no, holder, change_type, row_ordinal)
);
CREATE INDEX IF NOT EXISTS idx_register_items_person_item
    ON register_declared_items (politician_id, item_no) WHERE NOT is_nil;
CREATE INDEX IF NOT EXISTS idx_register_items_statement
    ON register_declared_items (statement_id);
CREATE INDEX IF NOT EXISTS idx_register_items_review
    ON register_declared_items (contains_amount) WHERE contains_amount;

COMMENT ON TABLE register_declared_items IS
    'Raw declared register items. Records WHAT is declared only - no quantity, value, amount or price column exists or may be added (influence-editorial-standards rule 5).';
COMMENT ON COLUMN register_declared_items.contains_amount IS
    'Vision-tier review flag: the model believed a cell contained a figure. Expected rate ~0; a spike means hallucination. Never rendered publicly.';

-- ---------------------------------------------------------------------------
-- 6. Resolved security links.
--
-- Auto-derived rows are rebuilt every run; curated rows in
-- register_security_aliases survive (same posture as runMatch/entity_asx_map).
--
-- The public gate is a CHECK, not a convention: analyst_fuzzy can never be
-- 'resolved', so a fuzzy match is structurally unable to reach a read path even
-- through a buggy query. Deliberate defence-in-depth - the 2026-07 audit found
-- the housing licence gate leaking on one read path.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS register_item_securities (
    id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    item_id           UUID NOT NULL REFERENCES register_declared_items(id) ON DELETE CASCADE,
    candidate_ordinal SMALLINT NOT NULL,
    candidate_raw     TEXT NOT NULL,
    candidate_norm    TEXT NOT NULL,
    stock_code        VARCHAR(50),
    company_name      TEXT NOT NULL DEFAULT '',
    resolution_status TEXT NOT NULL,
    match_method      TEXT,
    confidence        DOUBLE PRECISION NOT NULL DEFAULT 0,
    candidate_count   SMALLINT NOT NULL DEFAULT 0,
    resolved_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT register_item_securities_status_check
        CHECK (resolution_status IN ('resolved','ambiguous','unmatched','unlisted_fund','not_a_security')),
    -- ticker_in_text is the member writing the ASX code themselves, e.g.
    -- "iShares S&P 500 ETF (IVV)". It is publishable because it is stronger
    -- evidence than a name match, not weaker: the code is stated at source and
    -- then validated against "company-metadata". This is also the only thing
    -- that resolves ETFs at all — their company_name values are abbreviated
    -- ("Vngd Aus Shares Etf Units"), so no register spelling reaches them by
    -- name.
    CONSTRAINT register_item_securities_method_check
        CHECK (match_method IS NULL
               OR match_method IN ('curated_alias','ticker_in_text','name_exact','analyst_fuzzy')),
    CONSTRAINT register_item_securities_public_gate
        CHECK (resolution_status <> 'resolved'
               OR (stock_code IS NOT NULL
                   AND match_method IN ('curated_alias','ticker_in_text','name_exact'))),
    UNIQUE (item_id, candidate_ordinal)
);
CREATE INDEX IF NOT EXISTS idx_register_item_securities_stock
    ON register_item_securities (stock_code) WHERE resolution_status = 'resolved';
CREATE INDEX IF NOT EXISTS idx_register_item_securities_backlog
    ON register_item_securities (resolution_status, candidate_norm)
    WHERE resolution_status IN ('ambiguous','unmatched');

-- The curated alias table. A human authors every row, which is what keeps these
-- at the "verified manual mapping" bar the editorial standards allow.
--
-- ETFs need this almost universally: "company-metadata" DOES carry ASX ETF rows,
-- but with mangled names ('Vngd Aus Shares Etf Units' for VAS,
-- 'Betaaustralia200etf Etf Units' for A200) that no register spelling reaches by
-- exact match. Ticker shorthand ('CBA', 'ANZ') needs it too - those are codes,
-- not names.
CREATE TABLE IF NOT EXISTS register_security_aliases (
    alias_norm   TEXT PRIMARY KEY,
    stock_code   VARCHAR(50),
    alias_kind   TEXT NOT NULL DEFAULT 'equity',
    display_name TEXT NOT NULL DEFAULT '',
    resolution   TEXT NOT NULL DEFAULT 'resolved',
    note         TEXT NOT NULL DEFAULT '',
    curated_by   TEXT NOT NULL DEFAULT '',
    curated_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT register_security_aliases_kind_check
        CHECK (alias_kind IN ('equity','etf','lic','managed_fund','foreign','noise')),
    CONSTRAINT register_security_aliases_resolution_check
        CHECK (resolution IN ('resolved','unlisted_fund','not_a_security')),
    CONSTRAINT register_security_aliases_resolved_needs_code
        CHECK (resolution <> 'resolved' OR stock_code IS NOT NULL)
);

COMMENT ON TABLE register_security_aliases IS
    'Hand-curated declared-name -> ASX code map. Every row is a human decision. An unlisted/wholesale managed fund resolves with a NULL stock_code so it renders as declared text with no ticker link - the CHECK makes that structurally impossible to get wrong.';

-- ---------------------------------------------------------------------------
-- 7. Resolved property locations (item 3).
--
-- The register asks for "suburb or area only", so a 'region' result is a SOURCE
-- CHARACTERISTIC, not a parser bug. Alarm on the ambiguous bucket, never on
-- region, or you will chase a phantom forever.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS register_item_locations (
    id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    item_id           UUID NOT NULL REFERENCES register_declared_items(id) ON DELETE CASCADE,
    locality_raw      TEXT NOT NULL,
    locality_norm     TEXT NOT NULL,
    state_code        TEXT,
    purpose_raw       TEXT NOT NULL DEFAULT '',
    sal_code          TEXT,          -- suburb_demographics.sal_code (no FK, house style)
    resolution_status TEXT NOT NULL,
    match_method      TEXT,
    candidate_count   SMALLINT NOT NULL DEFAULT 0,
    resolved_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT register_item_locations_status_check
        CHECK (resolution_status IN ('resolved','ambiguous','region','no_state','unmatched')),
    CONSTRAINT register_item_locations_method_check
        CHECK (match_method IS NULL
               OR match_method IN ('name_state_exact','name_state_stripped','name_national_unique','curated')),
    CONSTRAINT register_item_locations_resolved_needs_sal
        CHECK (resolution_status <> 'resolved' OR sal_code IS NOT NULL),
    UNIQUE (item_id)
);
CREATE INDEX IF NOT EXISTS idx_register_item_locations_sal
    ON register_item_locations (sal_code) WHERE sal_code IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_register_item_locations_backlog
    ON register_item_locations (resolution_status, locality_norm)
    WHERE resolution_status <> 'resolved';

-- ---------------------------------------------------------------------------
-- 8. Point-in-time fold.
--
-- Built in Go by an ORDERED scan of the event stream, NOT by min()/max() in SQL:
-- an add / delete / re-add sequence is TWO intervals, and an aggregate silently
-- collapses it into one.
--
-- declared_to IS NULL  == currently declared
-- any row at all       == declared at some point
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS register_holding_periods (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    politician_id       UUID NOT NULL REFERENCES politicians(id) ON DELETE CASCADE,
    item_no             SMALLINT NOT NULL,
    holder              TEXT NOT NULL,
    holding_key         TEXT NOT NULL,     -- stock_code when resolved, else normalised text
    stock_code          VARCHAR(50),       -- ONLY set for curated_alias | name_exact
    sal_code            TEXT,
    declared_text       TEXT NOT NULL,
    secondary_text      TEXT NOT NULL DEFAULT '',
    declared_from       DATE,
    declared_from_known BOOLEAN NOT NULL DEFAULT TRUE,
    declared_to         DATE,
    first_statement_id  UUID REFERENCES register_statements(id) ON DELETE SET NULL,
    last_statement_id   UUID REFERENCES register_statements(id) ON DELETE SET NULL,
    first_parliament    SMALLINT,
    source_url          TEXT NOT NULL,
    source_licence      TEXT NOT NULL DEFAULT 'commonwealth-parliamentary-material',
    fetched_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
    rebuilt_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT register_holding_periods_holder_check
        CHECK (holder IN ('self','spouse_partner','dependent_children','unspecified')),
    CONSTRAINT register_holding_periods_interval_check
        CHECK (declared_to IS NULL OR declared_from IS NULL OR declared_to >= declared_from),
    UNIQUE (politician_id, item_no, holder, holding_key, declared_from)
);
CREATE INDEX IF NOT EXISTS idx_register_holding_periods_current
    ON register_holding_periods (stock_code, item_no)
    WHERE declared_to IS NULL AND stock_code IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_register_holding_periods_person
    ON register_holding_periods (politician_id, item_no, declared_from DESC);
CREATE INDEX IF NOT EXISTS idx_register_holding_periods_sal
    ON register_holding_periods (sal_code) WHERE sal_code IS NOT NULL;

COMMENT ON COLUMN register_holding_periods.declared_from_known IS
    'FALSE when the interval opens before our extraction window (e.g. a senator whose base statement predates the 2013 volume boundary). The UI renders an unknown start; never fabricate a date.';

-- ---------------------------------------------------------------------------
-- 9. Public read snapshot.
--
-- The gate is baked in: only identity-resolved holdings for non-merged people,
-- and stock_code is already guaranteed publishable by
-- register_item_securities_public_gate upstream of the fold.
-- ---------------------------------------------------------------------------
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

-- Per-suburb declared-property counts. Serves the housing choropleth metric,
-- which needs a value for every suburb in a state (~5000 rows per request) and
-- must never be a per-request join.
CREATE MATERIALIZED VIEW mv_register_suburb_property AS
SELECT
    hp.sal_code,
    count(DISTINCT hp.politician_id)::int                AS declaring_member_count,
    count(*)::int                                        AS declared_property_count,
    count(*) FILTER (WHERE hp.declared_to IS NULL)::int  AS current_property_count,
    now()                                                AS refreshed_at
FROM register_holding_periods hp
JOIN politicians p
    ON p.id = hp.politician_id
   AND p.merged_into_id IS NULL
WHERE hp.item_no = 3
  AND hp.sal_code IS NOT NULL
GROUP BY hp.sal_code;

CREATE UNIQUE INDEX IF NOT EXISTS idx_mv_register_suburb_property
    ON mv_register_suburb_property (sal_code);

-- ---------------------------------------------------------------------------
-- 10. Resolution + extraction observability.
--     register_resolution_backlog IS the alias-curation worklist.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE VIEW register_resolution_stats AS
SELECT d.parliament,
       d.chamber,
       i.item_no,
       s.resolution_status,
       s.match_method,
       count(*) AS candidates
FROM register_item_securities s
JOIN register_declared_items i ON i.id = s.item_id
JOIN register_statements st    ON st.id = i.statement_id
JOIN register_documents d      ON d.id = st.document_id
GROUP BY 1,2,3,4,5;

CREATE OR REPLACE VIEW register_resolution_backlog AS
SELECT candidate_norm,
       min(candidate_raw) AS example,
       count(*)           AS occurrences
FROM register_item_securities
WHERE resolution_status IN ('unmatched','ambiguous')
GROUP BY candidate_norm
ORDER BY occurrences DESC;

CREATE OR REPLACE VIEW register_location_backlog AS
SELECT locality_norm,
       min(locality_raw) AS example,
       min(state_code)   AS state_code,
       resolution_status,
       count(*)          AS occurrences
FROM register_item_locations
WHERE resolution_status <> 'resolved'
GROUP BY locality_norm, resolution_status
ORDER BY occurrences DESC;

-- Per-(parliament, item) nil rates. The tripwire for a silently-broken parser or
-- a degrading vision tier: item 1 at 100% nil for a whole parliament is a bug,
-- not 151 share-free members.
CREATE OR REPLACE VIEW register_extraction_stats AS
SELECT d.parliament,
       d.chamber,
       i.item_no,
       count(*)                                   AS rows_total,
       count(*) FILTER (WHERE i.is_nil)           AS rows_nil,
       count(*) FILTER (WHERE NOT i.is_nil)       AS rows_declared,
       round(100.0 * count(*) FILTER (WHERE i.is_nil)
             / NULLIF(count(*), 0), 2)            AS nil_pct,
       count(*) FILTER (WHERE i.contains_amount)  AS rows_flagged_amount,
       count(DISTINCT i.statement_id)             AS statements
FROM register_declared_items i
JOIN register_statements st ON st.id = i.statement_id
JOIN register_documents d   ON d.id = st.document_id
GROUP BY 1,2,3;

-- ---------------------------------------------------------------------------
-- 11. Guarded refresh.
--
-- The handlers name query_canceled EXPLICITLY. This is load-bearing: plpgsql's
-- WHEN OTHERS deliberately does NOT match query_canceled (57014), which is
-- exactly what a statement_timeout raises. Reference + full rationale:
-- 000095_harden_mv_refresh.up.sql.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION refresh_register_materialized_views()
RETURNS void
LANGUAGE plpgsql
AS $$
BEGIN
    RAISE NOTICE 'Refreshing mv_register_suburb_property (concurrently)...';
    BEGIN
        BEGIN
            REFRESH MATERIALIZED VIEW CONCURRENTLY mv_register_suburb_property;
        EXCEPTION WHEN query_canceled OR OTHERS THEN
            RAISE WARNING 'Failed to refresh mv_register_suburb_property concurrently: %. Trying non-concurrent...', SQLERRM;
            REFRESH MATERIALIZED VIEW mv_register_suburb_property;
        END;
    EXCEPTION WHEN query_canceled OR OTHERS THEN
        RAISE WARNING 'Skipping mv_register_suburb_property: %', SQLERRM;
    END;

    RAISE NOTICE 'Refreshing mv_register_public_holdings (concurrently)...';
    BEGIN
        BEGIN
            REFRESH MATERIALIZED VIEW CONCURRENTLY mv_register_public_holdings;
        EXCEPTION WHEN query_canceled OR OTHERS THEN
            RAISE WARNING 'Failed to refresh mv_register_public_holdings concurrently: %. Trying non-concurrent...', SQLERRM;
            REFRESH MATERIALIZED VIEW mv_register_public_holdings;
        END;
    EXCEPTION WHEN query_canceled OR OTHERS THEN
        RAISE WARNING 'Skipping mv_register_public_holdings: %', SQLERRM;
    END;
END;
$$;

ALTER FUNCTION refresh_register_materialized_views() SET statement_timeout TO '0';

-- ---------------------------------------------------------------------------
-- 12. Source registry.
--
-- signal_kind 'policy_footprint' and collection_method 'html' are already
-- permitted by the existing CHECK constraints, so no constraint migration is
-- needed. public_enabled stays FALSE until the extraction QA gates pass AND an
-- editorial template review against influence-editorial-standards rules 1-5 is
-- signed off.
-- ---------------------------------------------------------------------------
INSERT INTO industry_intelligence_sources
    (source_key, display_name, signal_kind, publisher, source_url, licence,
     cadence, collection_method, enabled, public_enabled, exact_entity_required, notes)
VALUES
    ('aph-register-of-interests',
     'Registers of Members'' and Senators'' Interests',
     'policy_footprint',
     'Parliament of Australia',
     'https://www.aph.gov.au/Senators_and_Members/Members/Register',
     'Parliamentary material; (c) Commonwealth of Australia',
     'Continuous during sitting periods',
     'html',
     TRUE,
     FALSE,
     TRUE,
     'Facts extracted from primary PDFs with attribution and a deep link; PDFs are never rehosted. The registers disclose what is held, never quantity or value. Only exact-normalised or human-curated alias matches surface publicly.')
ON CONFLICT (source_key) DO UPDATE SET
    display_name = EXCLUDED.display_name,
    notes        = EXCLUDED.notes,
    updated_at   = now();
