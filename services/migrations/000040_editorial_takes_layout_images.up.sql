ALTER TABLE editorial_takes ADD COLUMN IF NOT EXISTS layout_images JSONB NOT NULL DEFAULT '[]'::jsonb;
COMMENT ON COLUMN editorial_takes.layout_images IS 'art-director image plan: [{url,style,ratio,brief,caption,placement,anchorAfterBlock}]';
