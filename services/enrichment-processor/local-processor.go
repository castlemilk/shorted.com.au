package main

import (
	"context"
	"time"

	shortsv1alpha1 "github.com/castlemilk/shorted.com.au/services/gen/proto/go/shorts/v1alpha1"
)

// runLocalProcessor runs a local processor that polls the database for queued jobs
func runLocalProcessor(ctx context.Context, processor *enrichmentProcessor) error {
	logger := processor.logger
	store := processor.store

	logger.Infof("Starting local enrichment processor (polling every %v)", DefaultPollingInterval)

	ticker := time.NewTicker(DefaultPollingInterval)
	defer ticker.Stop()

	// Heartbeat ticker - log periodically to show we're alive
	heartbeatTicker := time.NewTicker(DefaultHeartbeatInterval)
	defer heartbeatTicker.Stop()

	// Cleanup ticker runs periodically
	cleanupTicker := time.NewTicker(DefaultCleanupInterval)
	defer cleanupTicker.Stop()

	// Run initial cleanup
	go func() {
		logger.Infof("Running initial cleanup...")
		// Reset jobs stuck for more than the threshold
		thresholdMinutes := int(DefaultStuckJobThreshold.Minutes())
		if count, err := store.ResetStuckJobs(thresholdMinutes); err != nil {
			logger.Warnf("Failed to reset stuck jobs: %v", err)
		} else if count > 0 {
			logger.Infof("Reset %d stuck job(s) on startup", count)
		} else {
			logger.Infof("No stuck jobs found on startup")
		}
		if count, err := store.CleanupOldCompletedJobs(3); err != nil {
			logger.Warnf("Failed to cleanup old completed jobs: %v", err)
		} else if count > 0 {
			logger.Infof("Cleaned up %d old completed job(s) on startup", count)
		} else {
			logger.Infof("No old completed jobs to cleanup on startup")
		}
	}()

	for {
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-heartbeatTicker.C:
			// Periodic heartbeat to show processor is alive
			logger.Debugf("Enrichment processor heartbeat - still polling for jobs")
		case <-cleanupTicker.C:
			// Periodic cleanup: reset stuck jobs and remove old completed jobs
			logger.Infof("Running periodic cleanup...")
			thresholdMinutes := int(DefaultStuckJobThreshold.Minutes())
			if count, err := store.ResetStuckJobs(thresholdMinutes); err != nil {
				logger.Warnf("Failed to reset stuck jobs: %v", err)
			} else if count > 0 {
				logger.Infof("Reset %d stuck job(s)", count)
			}
			if count, err := store.CleanupOldCompletedJobs(3); err != nil {
				logger.Warnf("Failed to cleanup old completed jobs: %v", err)
			} else if count > 0 {
				logger.Infof("Cleaned up %d old completed job(s)", count)
			} else {
				logger.Debugf("No old completed jobs to cleanup")
			}
		case <-ticker.C:
			// Get queued jobs
			status := shortsv1alpha1.EnrichmentJobStatus_ENRICHMENT_JOB_STATUS_QUEUED
			logger.Debugf("Polling for queued jobs...")
			jobs, total, err := store.ListEnrichmentJobs(10, 0, &status)
			if err != nil {
				logger.Errorf("Failed to list queued jobs: %v", err)
				continue
			}
			logger.Debugf("ListEnrichmentJobs returned %d jobs (total: %d)", len(jobs), total)

			if len(jobs) == 0 {
				// Log periodically that we're polling (every 6th tick = 1 minute)
				continue
			}

			logger.Infof("Found %d queued job(s), processing...", len(jobs))

			for i, job := range jobs {
				logger.Debugf("Job %d/%d: id=%s, code=%s, status=%v", i+1, len(jobs), job.JobId, job.StockCode, job.Status)
				if job.Status != shortsv1alpha1.EnrichmentJobStatus_ENRICHMENT_JOB_STATUS_QUEUED {
					logger.Debugf("Skipping job %s - status is not QUEUED (%v)", job.JobId, job.Status)
					continue
				}

				logger.Infof("Processing job %s for stock %s (force=%v)", job.JobId, job.StockCode, job.Force)
				if err := processor.processJob(ctx, job.JobId, job.StockCode, job.Force); err != nil {
					logger.Errorf("Failed to process job %s: %v", job.JobId, err)
					// Ensure job is marked as failed if processJob didn't handle it
					// (processJob should handle this, but this is a safety net)
					errMsg := err.Error()
					if updateErr := store.UpdateEnrichmentJobStatus(
						job.JobId,
						shortsv1alpha1.EnrichmentJobStatus_ENRICHMENT_JOB_STATUS_FAILED,
						nil,
						&errMsg,
					); updateErr != nil {
						logger.Warnf("Failed to update job %s status after error: %v", job.JobId, updateErr)
					}
				} else {
					logger.Infof("Successfully processed job %s", job.JobId)
				}
			}
		}
	}
}

