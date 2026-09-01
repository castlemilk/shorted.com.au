-- Migration 000118: capture industry classification changes as they happen (#557)
--
-- A cross-sectional short-interest signal is normally sector-neutralised,
-- because raw short interest is heavily sector-clustered — on the ASX,
-- lithium and battery-materials names carried structurally elevated short
-- interest for years, so a naive "long the least-shorted" book is a large
-- implicit sector bet. Doing that neutralisation correctly needs the sector a
-- stock was in ON THE OBSERVATION DATE, not today's label.
--
-- We do not have that history and CANNOT reconstruct it. `company-metadata`
-- holds exactly one current row per stock, enrichment overwrites `industry` in
-- place, and `updated_at` is a bulk-sweep timestamp — identical (2026-07-10)
-- across all 2,258 rows — so it dates the sweep, not the label. Ranking a 2014
-- cross-section by 2026 sector labels is mild lookahead that nobody outside can
-- correct for, and neither can we.
--
-- So this fixes the problem FORWARD only. It is worth doing now rather than
-- later for one reason: every day without capture is a day of history
-- permanently lost, and the cost of starting is a table and a trigger.
--
-- A TRIGGER rather than a polling job, deliberately. Enrichment can rewrite a
-- label at any time; a nightly snapshot would miss any change that was made and
-- overwritten between runs, and would fail silently when the job did. The
-- trigger fires on the write itself, so it cannot miss one and has nothing to
-- schedule.
--
-- REPLAY-SAFE: table and index are IF NOT EXISTS, the function is CREATE OR
-- REPLACE, and the trigger is dropped and recreated — which is cheap, unlike
-- rebuilding a materialized view.

CREATE TABLE IF NOT EXISTS stock_industry_history (
    id            BIGSERIAL    PRIMARY KEY,
    stock_code    VARCHAR(50)  NOT NULL,
    industry      TEXT,
    -- When this classification started applying, as far as we can observe.
    -- For the seeded baseline this is the date the row was seeded, NOT the date
    -- the label was assigned — which is unknown and unknowable. `source` says
    -- which it is, so nothing downstream mistakes a baseline for an observation.
    observed_from DATE         NOT NULL DEFAULT CURRENT_DATE,
    source        VARCHAR(16)  NOT NULL DEFAULT 'observed',
    recorded_at   TIMESTAMPTZ  NOT NULL DEFAULT now(),
    CONSTRAINT stock_industry_history_source_check CHECK (source IN ('seed', 'observed'))
);

CREATE INDEX IF NOT EXISTS idx_stock_industry_history_code_from
    ON stock_industry_history (stock_code, observed_from DESC);

-- One row per stock per distinct classification start. A re-run of the same
-- day's value is a no-op rather than a duplicate.
CREATE UNIQUE INDEX IF NOT EXISTS idx_stock_industry_history_unique
    ON stock_industry_history (stock_code, observed_from);

CREATE OR REPLACE FUNCTION record_industry_change() RETURNS TRIGGER AS $$
BEGIN
    -- IS DISTINCT FROM, not <>: a label going to or from NULL is a change, and
    -- <> would silently ignore both directions.
    IF NEW.industry IS DISTINCT FROM OLD.industry THEN
        INSERT INTO stock_industry_history (stock_code, industry, observed_from, source)
        VALUES (NEW.stock_code, NEW.industry, CURRENT_DATE, 'observed')
        -- source is updated too. A change landing on the same day as the
            -- baseline collapses into that row (observed_from is a DATE, and one
            -- row per stock per day is the intent), and leaving it marked 'seed'
            -- would label an observed value as a baseline — the row would claim
            -- to be something it is not.
            ON CONFLICT (stock_code, observed_from) DO UPDATE
            SET industry = EXCLUDED.industry,
                source = 'observed',
                recorded_at = now();
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_record_industry_change ON "company-metadata";
CREATE TRIGGER trg_record_industry_change
    AFTER UPDATE ON "company-metadata"
    FOR EACH ROW
    EXECUTE FUNCTION record_industry_change();

-- Baseline. Marked 'seed' so it is never mistaken for an observed change: it
-- says "this was the label when capture began", not "the label changed today".
INSERT INTO stock_industry_history (stock_code, industry, observed_from, source)
SELECT stock_code, industry, CURRENT_DATE, 'seed'
FROM "company-metadata"
WHERE stock_code IS NOT NULL AND industry IS NOT NULL AND industry <> ''
ON CONFLICT (stock_code, observed_from) DO NOTHING;
