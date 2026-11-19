-- Some ASX PDFs have a damaged text layer. Keep the figures read from the
-- rendered voting-power table, with the original PDF as their evidence.
BEGIN;
SET LOCAL lock_timeout = '15s';

CREATE TABLE IF NOT EXISTS ownership_reviewed_holder_votes (
    announcement_url TEXT PRIMARY KEY,
    stock_code TEXT NOT NULL,
    form TEXT NOT NULL,
    holder_name TEXT NOT NULL,
    source_url TEXT NOT NULL,
    previous_pct NUMERIC(7, 4) NOT NULL CHECK (previous_pct BETWEEN 0 AND 100),
    present_pct NUMERIC(7, 4) NOT NULL CHECK (present_pct BETWEEN 0 AND 100),
    previous_votes BIGINT NOT NULL CHECK (previous_votes >= 0),
    present_votes BIGINT NOT NULL CHECK (present_votes >= 0),
    ceased BOOLEAN NOT NULL
);

-- Section 2, page 1 of each PDF. The text extraction lost decimal points and
-- digits. The September 25 interest changed with an unchanged number of votes.
INSERT INTO ownership_reviewed_holder_votes
    (announcement_url, stock_code, form, holder_name, source_url,
     previous_pct, present_pct, previous_votes, present_votes, ceased)
VALUES
    ('https://www.asx.com.au/asx/v2/statistics/displayAnnouncement.do?display=pdf&idsId=03134187',
     'MHC', '604', 'Eric Sondergaard', 'https://announcements.asx.com.au/asxpdf/20260901/pdf/073l0w8y6h4yb3.pdf',
     12.68, 15.67, 87573000, 117335000, false),
    ('https://www.asx.com.au/asx/v2/statistics/displayAnnouncement.do?display=pdf&idsId=03144160',
     'MHC', '604', 'Eric Sondergaard', 'https://announcements.asx.com.au/asxpdf/20260925/pdf/074jsy8zbzlsmc.pdf',
     15.67, 12.80, 117335000, 117335000, false)
ON CONFLICT (announcement_url) DO NOTHING;

-- A re-read or a fresh database must keep the reviewed figures. Preserve the
-- original extraction method, holder key, dates and attribution on the notice.
CREATE OR REPLACE FUNCTION ownership_apply_reviewed_votes()
RETURNS TRIGGER LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
DECLARE
    r ownership_reviewed_holder_votes%ROWTYPE;
BEGIN
    SELECT * INTO r FROM ownership_reviewed_holder_votes
    WHERE announcement_url = NEW.announcement_url
      AND stock_code = NEW.stock_code AND form = NEW.form
      AND lower(trim(holder_name)) = lower(trim(NEW.holder_name));
    IF FOUND THEN
        NEW.previous_pct := r.previous_pct;
        NEW.present_pct := r.present_pct;
        NEW.previous_votes := r.previous_votes;
        NEW.present_votes := r.present_votes;
        NEW.ceased := r.ceased;
    END IF;
    RETURN NEW;
END;
$$;

DO $install$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_trigger WHERE tgname = 'ownership_reviewed_votes'
        AND tgrelid = 'substantial_holder_notices'::regclass
    ) THEN
        CREATE TRIGGER ownership_reviewed_votes
        BEFORE INSERT OR UPDATE OF announcement_url, stock_code, form, holder_name,
            previous_pct, present_pct, previous_votes, present_votes, ceased
        ON substantial_holder_notices
        FOR EACH ROW EXECUTE FUNCTION ownership_apply_reviewed_votes();
    END IF;
END;
$install$;

UPDATE substantial_holder_notices AS n
SET previous_pct = r.previous_pct, present_pct = r.present_pct,
    previous_votes = r.previous_votes, present_votes = r.present_votes, ceased = r.ceased
FROM ownership_reviewed_holder_votes AS r
WHERE n.announcement_url = r.announcement_url AND n.stock_code = r.stock_code
  AND n.form = r.form AND lower(trim(n.holder_name)) = lower(trim(r.holder_name))
  AND (n.previous_pct, n.present_pct, n.previous_votes, n.present_votes, n.ceased)
      IS DISTINCT FROM (r.previous_pct, r.present_pct, r.previous_votes, r.present_votes, r.ceased);

COMMIT;
