-- Secondary listing DETAIL-page crawl (Phase 0). The listing tier in 000076
-- sweeps SEARCH-results pages, which by portal each leave a different gap: REA's
-- SRP blob carries no geo/land-size/property-type, Domain's SRP blob carries no
-- agency/agents. Visiting each listing's own detail page (LDP) closes each
-- portal's gap and — because a delisted ad 404s or redirects to a search page —
-- gives us definitive delist detection the SRP sweep can't.
--
-- LICENCE: the harvested detail is proprietary/ToS-restricted (same posture as
-- property_listings in 000076/000078) and MUST NEVER be republished. Only DERIVED
-- aggregates are a publishable surface; the raw per-listing detail is stored for
-- backfilling the base row + internal enrichment only. Gate any public read on
-- source_licence.
--
-- WORK-LIST CURSOR: the "when was this listing last detail-fetched" cursor lives on
-- property_listing_details.detail_fetched_at (below), NOT on property_listings. A
-- listing with no detail row has never been fetched — the collector's work-list
-- LEFT JOINs the two and picks the NULL-join / price-moved / >90-day rows. So there
-- is deliberately no base-row cursor column; the details row IS the marker.

-- One row per listing's harvested detail page (latest snapshot, upserted).
CREATE TABLE IF NOT EXISTS property_listing_details (
    listing_pk         BIGINT PRIMARY KEY REFERENCES property_listings(id) ON DELETE CASCADE,
    source             TEXT NOT NULL,                 -- 'rea' | 'domain'
    detail_fetched_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    detail_status      TEXT NOT NULL,                 -- ok|blocked|notfound|error
    http_final_url     TEXT,                          -- URL after redirects (drives delist detection)
    description        TEXT,
    land_size_sqm      DOUBLE PRECISION,
    building_size_sqm  DOUBLE PRECISION,
    latitude           DOUBLE PRECISION,
    longitude          DOUBLE PRECISION,
    property_type      TEXT,
    features           TEXT[],
    image_count        SMALLINT,
    inspection_next    TIMESTAMPTZ,
    auction_at         TIMESTAMPTZ,
    listed_at          DATE,
    agent_phones       TEXT[],
    raw                JSONB NOT NULL,                -- the recognized fields only, never the whole page
    source_licence     TEXT NOT NULL DEFAULT 'proprietary-tos-restricted',
    content_hash       TEXT NOT NULL,                 -- sha1 of the raw payload
    created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_property_listing_details_fetched
    ON property_listing_details (detail_fetched_at DESC);
CREATE INDEX IF NOT EXISTS idx_property_listing_details_status
    ON property_listing_details (detail_status);
