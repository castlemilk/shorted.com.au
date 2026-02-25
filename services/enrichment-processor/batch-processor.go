package main

import (
	"context"
	"fmt"
	"os"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	shortsv1alpha1 "github.com/castlemilk/shorted.com.au/services/gen/proto/go/shorts/v1alpha1"
	"golang.org/x/sync/semaphore"
)

const (
	// DefaultBatchSize is the default number of stocks to enrich in batch mode
	DefaultBatchSize = 50

	// DefaultBatchConcurrency is the default number of concurrent enrichment workers
	DefaultBatchConcurrency = 3
)

// batchConfig holds configuration for batch enrichment
type batchConfig struct {
	batchSize   int
	concurrency int
	dryRun      bool
	priority    shortsv1alpha1.EnrichmentPriority
}

// loadBatchConfig reads batch configuration from environment variables
func loadBatchConfig() batchConfig {
	config := batchConfig{
		batchSize:   DefaultBatchSize,
		concurrency: DefaultBatchConcurrency,
		dryRun:      false,
	}

	if v := os.Getenv("BATCH_SIZE"); v != "" {
		if n, err := strconv.Atoi(v); err == nil && n > 0 {
			config.batchSize = n
		}
	}

	if v := os.Getenv("BATCH_CONCURRENCY"); v != "" {
		if n, err := strconv.Atoi(v); err == nil && n > 0 {
			config.concurrency = n
		}
	}

	if v := os.Getenv("DRY_RUN"); v != "" {
		config.dryRun = strings.EqualFold(v, "true") || v == "1"
	}

	config.priority = shortsv1alpha1.EnrichmentPriority_ENRICHMENT_PRIORITY_UNENRICHED
	if v := strings.ToLower(strings.TrimSpace(os.Getenv("BATCH_PRIORITY"))); v != "" {
		switch v {
		case "short_position":
			config.priority = shortsv1alpha1.EnrichmentPriority_ENRICHMENT_PRIORITY_SHORT_POSITION
		case "stale":
			config.priority = shortsv1alpha1.EnrichmentPriority_ENRICHMENT_PRIORITY_STALE
		}
	}

	return config
}

// batchResult tracks the outcome of a single stock enrichment in batch mode
type batchResult struct {
	stockCode   string
	companyName string
	status      string // "succeeded", "failed", "skipped"
	err         error
}

// runBatchProcessor runs a one-shot batch enrichment of unenriched stocks
func runBatchProcessor(ctx context.Context, processor *enrichmentProcessor) error {
	logger := processor.logger
	store := processor.store
	config := loadBatchConfig()

	logger.Infof("Starting batch enrichment (batch_size=%d, concurrency=%d, dry_run=%v, priority=%s)",
		config.batchSize, config.concurrency, config.dryRun, config.priority.String())

	// Query for unenriched stocks
	candidates, err := store.GetTopStocksForEnrichment(
		int32(config.batchSize),
		config.priority,
	)
	if err != nil {
		return fmt.Errorf("failed to get unenriched stocks: %w", err)
	}

	if len(candidates) == 0 {
		logger.Infof("No unenriched stocks found. All stocks are already enriched!")
		return nil
	}

	logger.Infof("Found %d unenriched stock(s) to process", len(candidates))

	// Dry run mode - list what would be enriched without doing it
	if config.dryRun {
		logger.Infof("=== DRY RUN MODE - No enrichments will be performed ===")
		for i, candidate := range candidates {
			logger.Infof("  [%d/%d] %s - %s (industry: %s, market_cap: %.0f, short%%: %.2f, status: %s)",
				i+1, len(candidates),
				candidate.StockCode,
				candidate.CompanyName,
				candidate.Industry,
				candidate.MarketCap,
				candidate.ShortPositionPercent,
				candidate.EnrichmentStatus,
			)
		}
		logger.Infof("=== DRY RUN COMPLETE: Would enrich %d stock(s) ===", len(candidates))
		return nil
	}

	// Process stocks concurrently with a semaphore to limit concurrency
	sem := semaphore.NewWeighted(int64(config.concurrency))
	var (
		mu         sync.Mutex
		results    []batchResult
		succeeded  int64
		failed     int64
		skipped    int64
	)

	startTime := time.Now()

	for i, candidate := range candidates {
		// Check for context cancellation
		if ctx.Err() != nil {
			logger.Warnf("Context cancelled, stopping batch processing")
			break
		}

		// Acquire semaphore slot
		if err := sem.Acquire(ctx, 1); err != nil {
			logger.Warnf("Failed to acquire semaphore: %v", err)
			break
		}

		// Capture loop variables
		idx := i
		cand := candidate

		go func() {
			defer sem.Release(1)

			result := batchResult{
				stockCode:   cand.StockCode,
				companyName: cand.CompanyName,
			}

			logger.Infof("Enriching stock %d of %d: %s (%s)",
				idx+1, len(candidates), cand.StockCode, cand.CompanyName)

			// Check if there's already an active job for this stock
			activeJob, err := store.GetActiveEnrichmentJobByStockCode(cand.StockCode)
			if err != nil {
				logger.Warnf("Failed to check active job for %s: %v", cand.StockCode, err)
				// Continue anyway - CreateEnrichmentJob will handle duplicates
			}
			if activeJob != nil {
				logger.Infof("Skipping %s - already has an active job (id=%s, status=%s)",
					cand.StockCode, activeJob.JobId, activeJob.Status)
				result.status = "skipped"
				atomic.AddInt64(&skipped, 1)
				mu.Lock()
				results = append(results, result)
				mu.Unlock()
				return
			}

			// Create enrichment job
			jobID, err := store.CreateEnrichmentJob(cand.StockCode, false)
			if err != nil {
				logger.Errorf("Failed to create enrichment job for %s: %v", cand.StockCode, err)
				result.status = "failed"
				result.err = err
				atomic.AddInt64(&failed, 1)
				mu.Lock()
				results = append(results, result)
				mu.Unlock()
				return
			}

			logger.Infof("Created job %s for %s, processing...", jobID, cand.StockCode)

			// Process the job
			if err := processor.processJob(ctx, jobID, cand.StockCode, false); err != nil {
				logger.Errorf("Failed to enrich %s (job %s): %v", cand.StockCode, jobID, err)
				result.status = "failed"
				result.err = err
				atomic.AddInt64(&failed, 1)
			} else {
				logger.Infof("Successfully enriched %s (job %s)", cand.StockCode, jobID)
				result.status = "succeeded"
				atomic.AddInt64(&succeeded, 1)
			}

			mu.Lock()
			results = append(results, result)
			mu.Unlock()
		}()
	}

	// Wait for all goroutines to finish by acquiring all semaphore slots
	if err := sem.Acquire(ctx, int64(config.concurrency)); err != nil {
		logger.Warnf("Error waiting for batch completion: %v", err)
	}

	elapsed := time.Since(startTime)

	// Log summary
	logger.Infof("=== Batch Enrichment Complete ===")
	logger.Infof("Duration: %v", elapsed.Round(time.Second))
	logger.Infof("Batch complete: %d succeeded, %d failed, %d skipped",
		atomic.LoadInt64(&succeeded), atomic.LoadInt64(&failed), atomic.LoadInt64(&skipped))

	// Log failures for debugging
	mu.Lock()
	defer mu.Unlock()
	for _, r := range results {
		if r.status == "failed" && r.err != nil {
			logger.Errorf("  FAILED %s (%s): %v", r.stockCode, r.companyName, r.err)
		}
	}

	return nil
}
