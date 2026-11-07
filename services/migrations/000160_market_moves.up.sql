-- 000160: market moves, posted by the market-moves workflow (docs/feature/market-moves/README.md),
-- and the tokens that workflow posts with.
--
--   market_moves  one row per move. The poster names each move with its own move_key, so a re-post of
--                 the same key updates the row in place (revision + 1) instead of adding a second one:
--                 "up 3% at noon" becomes "closed up 5%". A retraction is final: the row keeps its key
--                 with status 'retracted', the key cannot be posted again, and no reader serves it.
--
-- Every figure carries its own date: observed_at is when the poster observed the move, market_date its
-- Sydney calendar date. The writer (POST /v1/market-moves and the admin MCP post_market_move tool) checks
-- each code against company-metadata and refuses what it cannot place; the CHECKs below are the shape
-- only, so a writer bug cannot store a row no reader can draw.
--
-- LOCK-FREE ON REPLAY. Prod replays every allowlisted migration on every deploy
-- (.github/workflows/terraform-deploy.yml). The tables and their indexes are IF NOT EXISTS on tables this
-- file creates, so a replay takes no lock beyond the catalog check and touches no row.
--
-- No grants, owners, policies or RLS: 000138 closes every table in public on each deploy, and the backend
-- owns these tables. Readers tolerate its absence (42P01) for one release; the writer answers 503.

BEGIN;
SET LOCAL lock_timeout = '5s';

CREATE TABLE IF NOT EXISTS market_moves (
  id             BIGSERIAL PRIMARY KEY,
  move_key       TEXT NOT NULL CONSTRAINT market_moves_move_key_key UNIQUE
    CONSTRAINT market_moves_move_key_check CHECK (move_key ~ '^[a-z0-9][a-z0-9._:-]{2,127}$'),
  kind           TEXT NOT NULL CONSTRAINT market_moves_kind_check
    CHECK (kind IN ('stock', 'index', 'sector', 'market')),
  stock_code     TEXT CONSTRAINT market_moves_stock_code_check CHECK (stock_code ~ '^[A-Z0-9]{2,6}$'),
  index_code     TEXT CONSTRAINT market_moves_index_code_check CHECK (index_code ~ '^X[A-Z0-9]{2,5}$'),
  sector         TEXT CONSTRAINT market_moves_sector_check CHECK (char_length(sector) BETWEEN 2 AND 80),
  related_codes  TEXT[] NOT NULL DEFAULT '{}'
    CONSTRAINT market_moves_related_codes_check CHECK (cardinality(related_codes) <= 10),
  direction      TEXT NOT NULL CONSTRAINT market_moves_direction_check
    CHECK (direction IN ('up', 'down', 'flat', 'mixed')),
  change_pct     NUMERIC(8, 3) CONSTRAINT market_moves_change_pct_check CHECK (change_pct BETWEEN -100 AND 1000),
  price          NUMERIC(14, 4) CONSTRAINT market_moves_price_check CHECK (price > 0),
  volume_ratio   NUMERIC(8, 2) CONSTRAINT market_moves_volume_ratio_check CHECK (volume_ratio >= 0),
  headline       TEXT NOT NULL CONSTRAINT market_moves_headline_check CHECK (char_length(headline) BETWEEN 8 AND 140),
  summary        TEXT NOT NULL CONSTRAINT market_moves_summary_check CHECK (char_length(summary) BETWEEN 20 AND 1200),
  sources        JSONB NOT NULL DEFAULT '[]'::jsonb
    CONSTRAINT market_moves_sources_check CHECK (jsonb_typeof(sources) = 'array' AND jsonb_array_length(sources) <= 6),
  tags           TEXT[] NOT NULL DEFAULT '{}' CONSTRAINT market_moves_tags_check CHECK (cardinality(tags) <= 8),
  significance   SMALLINT NOT NULL DEFAULT 3 CONSTRAINT market_moves_significance_check CHECK (significance BETWEEN 1 AND 5),
  observed_at    TIMESTAMPTZ NOT NULL,
  market_date    DATE NOT NULL,
  status         TEXT NOT NULL DEFAULT 'published' CONSTRAINT market_moves_status_check
    CHECK (status IN ('published', 'retracted')),
  revision       INTEGER NOT NULL DEFAULT 1 CONSTRAINT market_moves_revision_check CHECK (revision >= 1),
  content_hash   TEXT NOT NULL,
  actor          TEXT NOT NULL,
  model          TEXT CONSTRAINT market_moves_model_check CHECK (char_length(model) <= 80),
  run_id         TEXT CONSTRAINT market_moves_run_id_check CHECK (char_length(run_id) <= 128),
  retracted_at   TIMESTAMPTZ,
  retract_reason TEXT CONSTRAINT market_moves_retract_reason_check CHECK (char_length(retract_reason) <= 280),
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- A move names what moved: a stock move its code, an index move its index, a sector move its sector.
  CONSTRAINT market_moves_subject_check CHECK (
    (kind <> 'stock' OR stock_code IS NOT NULL)
    AND (kind <> 'index' OR index_code IS NOT NULL)
    AND (kind <> 'sector' OR sector IS NOT NULL)
  ),
  CONSTRAINT market_moves_retracted_check CHECK ((status = 'retracted') = (retracted_at IS NOT NULL))
);

-- The feed: newest observation first, published only.
CREATE INDEX IF NOT EXISTS idx_market_moves_feed
  ON market_moves (observed_at DESC, id DESC) WHERE status = 'published';

-- A stock's moves: the stock it is about, and the stocks it names.
CREATE INDEX IF NOT EXISTS idx_market_moves_stock
  ON market_moves (stock_code, observed_at DESC, id DESC) WHERE status = 'published';
CREATE INDEX IF NOT EXISTS idx_market_moves_related
  ON market_moves USING GIN (related_codes) WHERE status = 'published';

-- The writer's per-day cap counts one market date.
CREATE INDEX IF NOT EXISTS idx_market_moves_market_date ON market_moves (market_date);

--   market_moves_tokens  the credentials a market-moves workflow posts with, created and revoked by an
--                        administrator in the admin console (/admin/market-moves). Only the SHA-256 of a
--                        token is stored: the token itself is shown once, when it is created, and cannot
--                        be read back. token_prefix is its first characters, enough to tell tokens apart
--                        on screen and in the audit log, far too few to use. A revoked token keeps its
--                        row (the moves it posted name it in their actor, token:<id>).
CREATE TABLE IF NOT EXISTS market_moves_tokens (
  id           BIGSERIAL PRIMARY KEY,
  name         TEXT NOT NULL CONSTRAINT market_moves_tokens_name_check CHECK (char_length(name) BETWEEN 1 AND 80),
  token_hash   TEXT NOT NULL CONSTRAINT market_moves_tokens_hash_key UNIQUE
    CONSTRAINT market_moves_tokens_hash_check CHECK (token_hash ~ '^[0-9a-f]{64}$'),
  token_prefix TEXT NOT NULL CONSTRAINT market_moves_tokens_prefix_check CHECK (token_prefix ~ '^smm_[A-Za-z0-9_-]{6}$'),
  created_by   TEXT NOT NULL,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at   TIMESTAMPTZ,
  last_used_at TIMESTAMPTZ,
  revoked_at   TIMESTAMPTZ,
  revoked_by   TEXT,
  CONSTRAINT market_moves_tokens_expiry_check CHECK (expires_at IS NULL OR expires_at > created_at),
  CONSTRAINT market_moves_tokens_revoked_check CHECK ((revoked_at IS NULL) = (revoked_by IS NULL))
);

COMMIT;
