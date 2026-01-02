-- Add enrichment jobs table for async enrichment processing
-- Tracks enrichment job requests and their lifecycle status

CREATE TABLE IF NOT EXISTS "enrichment-jobs" (
  job_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  stock_code TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'queued',
  priority INTEGER DEFAULT 0,
  force BOOLEAN DEFAULT false,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  started_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,
  error_message TEXT,
  enrichment_id UUID REFERENCES "enrichment-pending"(enrichment_id),
  CONSTRAINT enrichment_jobs_status_check CHECK (
    status IN ('queued', 'processing', 'completed', 'failed', 'cancelled')
  )
);

CREATE INDEX IF NOT EXISTS idx_enrichment_jobs_status ON "enrichment-jobs"(status, created_at);
CREATE INDEX IF NOT EXISTS idx_enrichment_jobs_stock_code ON "enrichment-jobs"(stock_code);

