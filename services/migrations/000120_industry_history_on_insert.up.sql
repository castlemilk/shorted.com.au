-- Migration 000120: capture a stock's FIRST classification, not only its changes (#557)
--
-- 000118 put an AFTER UPDATE trigger on "company-metadata" and seeded a
-- baseline row for every stock that existed at that moment. Both halves are
-- right and together they still leave a hole: a stock that arrives AFTER the
-- seed gets no history row at all, because an INSERT fires no UPDATE trigger.
--
-- That is not merely missing data, it is wrong data, and the wrongness only
-- appears later. Observed on a local database:
--
--   INSERT ZZNEW industry='Materials'   →  <no history row>
--   UPDATE ZZNEW industry='Energy'      →  "Energy @2026-09-06 (observed)"
--
-- The timeline now claims the stock has been Energy since the day it was
-- reclassified, and says nothing about the Materials period before it. A caller
-- asking "what sector was this on the day it listed" gets no row, falls back to
-- the current label, and reads a reclassification as though it never happened —
-- the exact lookahead #557 exists to remove, reintroduced by the mechanism
-- built to prevent it.
--
-- A newly listed stock is also precisely the case where forward capture should
-- be at its best: we are present for its whole life, so its history should be
-- complete rather than starting at its first reclassification.
--
-- source='seed' for the INSERT row, deliberately. The vocabulary means "the
-- label as it stood when capture began", and for a stock that arrives now,
-- capture begins now. It is not a change we witnessed, and calling it
-- 'observed' would claim we saw a reclassification that did not happen.
--
-- A same-day INSERT-then-UPDATE still collapses into one row carrying the later
-- label. That is correct at this table's daily resolution: observed_from means
-- "this label applied FROM this date", and a classification that lasted part of
-- one day applied from no date at all.
--
-- REPLAY-SAFE: CREATE OR REPLACE for the function, DROP + CREATE for the
-- triggers (cheap), and the catch-up INSERT is ON CONFLICT DO NOTHING.

CREATE OR REPLACE FUNCTION record_industry_change() RETURNS TRIGGER AS $$
BEGIN
    IF TG_OP = 'INSERT' THEN
        -- A stock with no classification yet has nothing to record; it will get
        -- a row from the UPDATE path when one is assigned.
        IF NEW.industry IS NOT NULL AND NEW.industry <> '' THEN
            INSERT INTO stock_industry_history (stock_code, industry, observed_from, source)
            VALUES (NEW.stock_code, NEW.industry, CURRENT_DATE, 'seed')
            -- DO NOTHING, not DO UPDATE: if a row already exists for today it
            -- was written by something that knows more than this INSERT does.
            ON CONFLICT (stock_code, observed_from) DO NOTHING;
        END IF;
        RETURN NEW;
    END IF;

    -- IS DISTINCT FROM, not <>: a label going to or from NULL is a change, and
    -- <> would silently ignore both directions.
    IF NEW.industry IS DISTINCT FROM OLD.industry THEN
        INSERT INTO stock_industry_history (stock_code, industry, observed_from, source)
        VALUES (NEW.stock_code, NEW.industry, CURRENT_DATE, 'observed')
        -- source is updated too. A change landing on the same day as the
        -- baseline collapses into that row (observed_from is a DATE, and one
        -- row per stock per day is the intent), and leaving it marked 'seed'
        -- would label an observed value as a baseline.
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

DROP TRIGGER IF EXISTS trg_record_industry_insert ON "company-metadata";
CREATE TRIGGER trg_record_industry_insert
    AFTER INSERT ON "company-metadata"
    FOR EACH ROW
    EXECUTE FUNCTION record_industry_change();

-- Catch-up for anything that arrived between 000118's seed and this migration,
-- which is exactly the population the missing INSERT trigger dropped. Dated
-- CURRENT_DATE and marked 'seed' for the same reason as the original baseline:
-- it records where our knowledge of this stock starts, and we genuinely do not
-- know when the label was assigned.
INSERT INTO stock_industry_history (stock_code, industry, observed_from, source)
SELECT m.stock_code, m.industry, CURRENT_DATE, 'seed'
FROM "company-metadata" m
WHERE m.stock_code IS NOT NULL
  AND m.industry IS NOT NULL
  AND m.industry <> ''
  AND NOT EXISTS (
      SELECT 1 FROM stock_industry_history h WHERE h.stock_code = m.stock_code
  )
ON CONFLICT (stock_code, observed_from) DO NOTHING;
