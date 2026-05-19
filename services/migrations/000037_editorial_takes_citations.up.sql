-- Citations array for journalism-engine Takes.
--
-- Each citation: { refId: "ref-1", url, source, headline, date, type }.
-- The body_md contains [ref-N] inline markers that the frontend turns
-- into superscript links pointing to a "Sources" list at the bottom of
-- the article. Same shape as the linkified-narrative component already
-- in use for weekly reports.

ALTER TABLE editorial_takes
  ADD COLUMN IF NOT EXISTS citations JSONB NOT NULL DEFAULT '[]'::jsonb;
