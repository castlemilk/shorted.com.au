-- Add enrichment pending table for v2 enrichment review workflow
-- Stores proposed enrichment updates for manual approval before applying to company-metadata.

CREATE TABLE IF NOT EXISTS "enrichment-pending" (
  enrichment_id UUID PRIMARY KEY,
  stock_code TEXT NOT NULL,
  enrichment_data JSONB NOT NULL,
  quality_score JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  reviewed_at TIMESTAMPTZ NULL,
  reviewed_by TEXT NULL,
  review_notes TEXT NULL,
  status TEXT NOT NULL DEFAULT 'pending_review',
  CONSTRAINT enrichment_pending_status_check CHECK (
    status IN ('pending_review', 'approved', 'rejected')
  )
);

CREATE INDEX IF NOT EXISTS idx_enrichment_pending_stock_code
  ON "enrichment-pending"(stock_code);

CREATE INDEX IF NOT EXISTS idx_enrichment_pending_status_created_at
  ON "enrichment-pending"(status, created_at DESC);


