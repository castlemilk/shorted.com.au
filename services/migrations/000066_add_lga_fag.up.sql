-- Federal Financial Assistance Grants (FAGs) per council — the untied
-- Commonwealth grants every Australian local government receives (Local
-- Government (Financial Assistance) Act 1995). National, all states. CC-BY-4.0
-- (Dept of Infrastructure). Attached to the LGA dimension; a suburb inherits its
-- council's FAG via the suburb_lga bridge. Per-capita is derived from lga.population.
ALTER TABLE lga
    ADD COLUMN IF NOT EXISTS fed_fag_aud  NUMERIC,   -- total FAG (inc early payment), latest year, AUD
    ADD COLUMN IF NOT EXISTS fed_fag_year TEXT;      -- e.g. '2024-25'
