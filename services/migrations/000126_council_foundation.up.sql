-- Council (LGA) foundation: identity + ABS facts on the `lga` dimension, a long
-- `lga_series` table for everything that has a time axis, and the dominant
-- council's share on the suburb bridge.
--
-- `lga` keeps holding the CURRENT scalar facts (program decision 1). Every
-- scalar below is filled by a collector mode (see
-- docs/feature/housing/pipeline.md); nothing is added that no mode fills.
-- NULL means "no source covers this council", never zero.
--
-- Corrections to 000061's comments, which stay as applied (an applied
-- migration is never edited): `lga.population` is ABS ERP only from this
-- migration's `-mode erp-lga` onward -- before it, it was a Census 2021 sum of
-- member suburbs -- and `suburb_lga` is only mesh-block weighted from the
-- join-lga-mb.py artifact onward; 000061's "by mesh-block weight" described
-- an intent the centroid join never met.
--
-- Replay-safe on purpose (IF NOT EXISTS everywhere, no rows touched), matching
-- 000122, so it can sit on the deploy allowlist or be hand-applied twice.

ALTER TABLE lga
    ADD COLUMN IF NOT EXISTS kind                    TEXT,             -- council | unincorporated | pseudo
    ADD COLUMN IF NOT EXISTS display_name            TEXT,             -- ABS name, state suffix removed
    ADD COLUMN IF NOT EXISTS slug                    TEXT,             -- minted once, never reassigned
    ADD COLUMN IF NOT EXISTS erp_year                INTEGER,          -- ERP reference year (at 30 June)
    ADD COLUMN IF NOT EXISTS wikidata_qid            TEXT,             -- e.g. 'Q660298' (Wikidata, CC0)
    ADD COLUMN IF NOT EXISTS website                 TEXT,             -- official website (Wikidata P856, CC0)
    ADD COLUMN IF NOT EXISTS seifa_irsad_decile      SMALLINT,         -- ABS SEIFA 2021, national decile
    ADD COLUMN IF NOT EXISTS seifa_irsd_decile       SMALLINT,         -- ABS SEIFA 2021, national decile
    ADD COLUMN IF NOT EXISTS dwellings               INTEGER,          -- Census 2021 mesh-block dwelling count
    ADD COLUMN IF NOT EXISTS median_weekly_rent      INTEGER,          -- Census 2021 G02, $/week
    ADD COLUMN IF NOT EXISTS median_mortgage_monthly INTEGER,          -- Census 2021 G02, $/month
    ADD COLUMN IF NOT EXISTS avg_household_size      DOUBLE PRECISION; -- Census 2021 G02, persons

-- Constraints are added by name only when missing: ADD CONSTRAINT has no
-- IF NOT EXISTS form, and a replay must not fail on the second run.
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'lga_kind_check') THEN
        ALTER TABLE lga ADD CONSTRAINT lga_kind_check
            CHECK (kind IS NULL OR kind IN ('council', 'unincorporated', 'pseudo'));
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'lga_seifa_decile_check') THEN
        ALTER TABLE lga ADD CONSTRAINT lga_seifa_decile_check CHECK (
            (seifa_irsad_decile IS NULL OR seifa_irsad_decile BETWEEN 1 AND 10)
            AND (seifa_irsd_decile IS NULL OR seifa_irsd_decile BETWEEN 1 AND 10));
    END IF;
END $$;

-- Council URLs are /housing/<state>/council/<slug>; the same name recurs across
-- states (Campbelltown NSW/SA), so uniqueness is per state.
CREATE UNIQUE INDEX IF NOT EXISTS idx_lga_state_slug
    ON lga (state_code, slug) WHERE slug IS NOT NULL;

-- Share (0..1] of the suburb's weight -- Census 2021 residents, dwellings, then
-- area -- that falls in its dominant council. overlap_lgas (000061) now carries
-- every council holding >= 1%, dominant first.
ALTER TABLE suburb_lga
    ADD COLUMN IF NOT EXISTS dominant_share DOUBLE PRECISION;

DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'suburb_lga_dominant_share_check') THEN
        ALTER TABLE suburb_lga ADD CONSTRAINT suburb_lga_dominant_share_check
            CHECK (dominant_share IS NULL OR (dominant_share > 0 AND dominant_share <= 1));
    END IF;
END $$;

-- Every council fact with a time axis: ERP and its components, ABS council-level
-- house medians and transfer counts, building approvals, FAG history. One row
-- per council x measure x period x source, so two sources for one measure can
-- coexist and each carries its own licence. Licensing mirrors 000122: the
-- unlicensed state is unstorable.
CREATE TABLE IF NOT EXISTS lga_series (
    lga_code24     TEXT NOT NULL REFERENCES lga (lga_code24) ON DELETE CASCADE,
    measure        TEXT NOT NULL,             -- e.g. 'erp', 'house_median_price', 'fag_total_aud'
    period         DATE NOT NULL,             -- end of the reference period
    period_label   TEXT NOT NULL,             -- the source's own label, e.g. '2025-26', '2026-06'
    value          DOUBLE PRECISION NOT NULL,
    unit           TEXT NOT NULL,             -- 'persons' | 'AUD' | 'count'
    source         TEXT NOT NULL,             -- e.g. 'abs_erp_lga', 'abs_regional_lga', 'fed_fags'
    source_licence TEXT NOT NULL DEFAULT 'CC-BY-4.0',
    fetched_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (lga_code24, measure, period, source),
    CONSTRAINT lga_series_licence_check CHECK (source_licence <> 'proprietary-tos-restricted')
);

-- The read path asks for "latest value of <measure> for <council>".
CREATE INDEX IF NOT EXISTS idx_lga_series_measure_latest
    ON lga_series (lga_code24, measure, period DESC);
