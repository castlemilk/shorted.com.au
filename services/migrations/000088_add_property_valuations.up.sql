-- Address-seeded property VALUATION enrichment (Phase 0). property.com.au is REA
-- Group's per-address property-research portal (AVM price estimate + sales history
-- + property attributes + year built, keyed by ADDRESS, ~15M properties). Unlike
-- the listing tiers (000076/000078/000087), which sweep the FOR-SALE market, this
-- tier enriches our EXISTING address corpus: it is seeded from the distinct
-- addresses already in property_listings and keyed by the SAME canonical
-- address_key, so a valuation bridges 1:1 back to every listing at that address.
--
-- LICENCE: the harvested profile is proprietary/ToS-restricted (property.com.au's
-- robots.txt explicitly bans aggregators — same posture as the crawl_rea/crawl_domain
-- listings) and MUST NEVER be republished raw. Only DERIVED aggregates are a
-- publishable surface; the raw profile is stored for internal enrichment only. Gate
-- any public read on source_licence.
--
-- WORK-LIST CURSOR: the "when was this address last valued" cursor lives on
-- property_valuations.fetched_at. An address with no row here has never been
-- fetched — the collector's work-list LEFT JOINs property_listings against this
-- table and picks the NULL-join / >TTL rows (see loadPropertyWorklist).

-- One row per physical address (latest valuation snapshot, upserted).
CREATE TABLE IF NOT EXISTS property_valuations (
    address_key         TEXT PRIMARY KEY,              -- our canonical address_key (bridges to property_listings)
    source              TEXT NOT NULL DEFAULT 'property.com.au',
    profile_url         TEXT,                          -- the resolved property.com.au profile URL
    fetched_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
    fetch_status        TEXT NOT NULL,                 -- ok|blocked|notfound|error
    estimate_low        DOUBLE PRECISION,              -- AVM range low
    estimate_mid        DOUBLE PRECISION,              -- AVM point estimate
    estimate_high       DOUBLE PRECISION,              -- AVM range high
    estimate_confidence TEXT,                          -- low|medium|high (when exposed)
    rent_estimate_mid   DOUBLE PRECISION,              -- weekly rent estimate (when exposed)
    bedrooms            SMALLINT,
    bathrooms           SMALLINT,
    car_spaces          SMALLINT,
    land_size_sqm       DOUBLE PRECISION,
    building_size_sqm   DOUBLE PRECISION,
    year_built          SMALLINT,
    property_type       TEXT,
    latitude            DOUBLE PRECISION,
    longitude           DOUBLE PRECISION,
    sales_history       JSONB,                         -- [{date, price, agency?, type?}] full history
    raw                 JSONB NOT NULL,                -- the recognized fields only, never the whole page
    source_licence      TEXT NOT NULL DEFAULT 'proprietary-tos-restricted',
    content_hash        TEXT NOT NULL,                 -- sha1 of the raw payload
    created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- The work-list orders never-fetched-first then oldest-fetched, so the primary
-- cursor index is on fetched_at.
CREATE INDEX IF NOT EXISTS idx_property_valuations_todo
    ON property_valuations (fetched_at);
