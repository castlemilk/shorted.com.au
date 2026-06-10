-- MDX-powered editorial takes: body format discriminator + masthead fields.
ALTER TABLE editorial_takes ADD COLUMN IF NOT EXISTS body_format TEXT NOT NULL DEFAULT 'markdown';
ALTER TABLE editorial_takes ADD COLUMN IF NOT EXISTS standfirst TEXT;
ALTER TABLE editorial_takes ADD COLUMN IF NOT EXISTS byline TEXT;
ALTER TABLE editorial_takes ADD COLUMN IF NOT EXISTS hero_caption TEXT;
ALTER TABLE editorial_takes ADD COLUMN IF NOT EXISTS hero_credit TEXT;
COMMENT ON COLUMN editorial_takes.body_format IS 'markdown | mdx — render path discriminator';
