-- Auto-reset stuck enrichment jobs
-- Database-level safeguard to prevent jobs from getting stuck in processing status
-- This function automatically resets jobs that have been in processing for >10 minutes

CREATE OR REPLACE FUNCTION reset_stuck_enrichment_jobs()
RETURNS void
LANGUAGE plpgsql
AS $$
DECLARE
  reset_count INTEGER;
BEGIN
  -- Reset jobs stuck in processing for more than 10 minutes
  UPDATE "enrichment-jobs"
  SET 
    status = 'queued',
    started_at = NULL,
    error_message = 'Job was automatically reset after being stuck in processing for >10 minutes'
  WHERE status = 'processing'
    AND started_at IS NOT NULL
    AND started_at < NOW() - INTERVAL '10 minutes';
  
  GET DIAGNOSTICS reset_count = ROW_COUNT;
  
  IF reset_count > 0 THEN
    RAISE NOTICE 'Auto-reset % stuck enrichment job(s)', reset_count;
  END IF;
END;
$$;

-- Create a scheduled job using pg_cron (if available) or manual trigger
-- For now, this will be called by the application's periodic cleanup
-- In production, you could set up pg_cron to run this every 5 minutes:
-- SELECT cron.schedule('reset-stuck-jobs', '*/5 * * * *', $$SELECT reset_stuck_enrichment_jobs()$$);

-- Add a comment explaining the function
COMMENT ON FUNCTION reset_stuck_enrichment_jobs() IS 
  'Automatically resets enrichment jobs stuck in processing status for more than 10 minutes. '
  'This is a database-level safeguard to prevent jobs from getting permanently stuck.';
