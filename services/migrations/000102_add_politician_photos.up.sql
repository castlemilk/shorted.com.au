-- Portrait photographs for parliamentarians.
--
-- WHY NOT THE OBVIOUS SOURCE. aph.gov.au carries a portrait of every sitting
-- member, and §3.1 of the architecture doc rules it out in its own words:
-- "Extracted facts are publishable with attribution; the PDFs must not be
-- mirrored wholesale", with the GCS bucket kept as a private working cache so
-- that "we do not maintain a mirror" is true in fact. A portrait is an ARTEFACT,
-- not an extracted fact, and photographs are the likeliest part of that corpus
-- to carry a separate photographer/AUSPIC copyright on top of the Commonwealth's.
-- Serving one from our own infrastructure is the exact thing that posture exists
-- to prevent. (`aph_mpid` — the natural key to those images — is also 0 of 324
-- populated, so the approach was not even available without new crawling.)
--
-- SO: Wikimedia Commons, reached through Wikidata's P18. Commons requires a FREE
-- licence by policy — it does not host fair-use files — which is why P18 is a
-- much safer source than an English Wikipedia page image, where a local fair-use
-- upload is possible. (Measured: an enwiki-page-image sample returned unknown
-- licences for 3 of 20; every P18 target resolves to Commons.)
--
-- Measured coverage against this corpus: 238 of 324 (73%) match a Wikidata
-- record uniquely on surname + electoral division and carry a portrait; 4 are
-- ambiguous and are withheld; 12 do not match.

ALTER TABLE politicians
    -- The Commons file URL. NOT a copy of ours: nothing here is mirrored into a
    -- bucket, so the licence holder's own hosting continues to serve it.
    ADD COLUMN IF NOT EXISTS photo_url        TEXT NOT NULL DEFAULT '',
    -- The licence as Commons states it, verbatim ("CC BY-SA 4.0", "Public domain").
    ADD COLUMN IF NOT EXISTS photo_licence    TEXT NOT NULL DEFAULT '',
    -- The author/credit line Commons carries. CC BY and CC BY-SA both REQUIRE
    -- attribution by name, so this is a licence obligation and not metadata.
    ADD COLUMN IF NOT EXISTS photo_author     TEXT NOT NULL DEFAULT '',
    -- The Commons file description page. The licence also requires a link back
    -- to the source, and this is the page that carries the full terms.
    ADD COLUMN IF NOT EXISTS photo_source_url TEXT NOT NULL DEFAULT '',
    -- The Wikidata item the match resolved to, kept so a wrong photo can be
    -- traced back to the record that produced it rather than re-derived.
    ADD COLUMN IF NOT EXISTS photo_entity_id  TEXT NOT NULL DEFAULT '',
    ADD COLUMN IF NOT EXISTS photo_fetched_at TIMESTAMPTZ;

-- A PHOTO WITHOUT ITS ATTRIBUTION IS A LICENCE BREACH, not a cosmetic gap.
-- Under CC BY / CC BY-SA, publishing the image while dropping the credit is the
-- one thing the licence does not permit — so the database refuses to hold that
-- state at all, rather than relying on every read path to remember. This is the
-- same shape as register_item_securities_public_gate: make the unpublishable
-- state structurally impossible instead of merely discouraged.
ALTER TABLE politicians
    DROP CONSTRAINT IF EXISTS politicians_photo_needs_attribution;
ALTER TABLE politicians
    ADD CONSTRAINT politicians_photo_needs_attribution
        CHECK (
            btrim(photo_url) = ''
            OR (btrim(photo_licence) <> '' AND btrim(photo_source_url) <> '')
        );

COMMENT ON COLUMN politicians.photo_url IS
    'Wikimedia Commons portrait URL. Never an aph.gov.au image (see 000102 header) and never mirrored into our own storage. A CHECK forbids storing it without a licence and a source link, because CC BY-SA requires both.';

COMMENT ON COLUMN politicians.photo_author IS
    'Credit line required by CC BY / CC BY-SA. Rendered wherever the photo is rendered.';

CREATE INDEX IF NOT EXISTS idx_politicians_with_photo
    ON politicians (id)
    WHERE btrim(photo_url) <> '';
