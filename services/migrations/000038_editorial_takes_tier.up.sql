-- Tiered editorial output: most takes are tight 4-section "take"s; a
-- couple per day are promoted to long-form "deep_dive" investigations.
-- The investigative newsroom (scripts/take-writer) sets this.
ALTER TABLE editorial_takes
  ADD COLUMN IF NOT EXISTS tier VARCHAR(20) NOT NULL DEFAULT 'take';

-- Allowed values: 'take' | 'deep_dive'. Enforced in app, documented here.
COMMENT ON COLUMN editorial_takes.tier IS 'take | deep_dive';
