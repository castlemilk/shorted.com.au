-- Editorial takes ("Shorted Take") — short Gemini-generated commentary
-- on price-sensitive news headlines. Posted to /news/[slug] so the
-- Twitter bot can link back to a shorted.com.au article instead of
-- the external publisher.
--
-- published_at is NULL until an admin (or auto-publish job) flips it.
-- The frontend filters on published_at IS NOT NULL; the cron writes
-- drafts with published_at NULL and an admin queue handles approval.

CREATE TABLE IF NOT EXISTS editorial_takes (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  slug              TEXT NOT NULL UNIQUE,
  headline          TEXT NOT NULL,
  stock_code        VARCHAR(10),
  body_md           TEXT NOT NULL,
  sentiment         VARCHAR(20),
  source_article_id UUID REFERENCES news_articles(id) ON DELETE SET NULL,
  source_url        TEXT,
  source_name       TEXT,
  og_image_url      TEXT,
  word_count        INTEGER,
  model             VARCHAR(50),
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  published_at      TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_editorial_takes_published
  ON editorial_takes (published_at DESC NULLS LAST)
  WHERE published_at IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_editorial_takes_stock_published
  ON editorial_takes (stock_code, published_at DESC)
  WHERE published_at IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_editorial_takes_drafts
  ON editorial_takes (created_at DESC)
  WHERE published_at IS NULL;
