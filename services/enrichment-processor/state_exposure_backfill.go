package main

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"sync"
	"time"

	"github.com/castlemilk/shorted.com.au/services/pkg/enrichment"
	"github.com/castlemilk/shorted.com.au/services/pkg/log"
)

// stateExposureConcurrency is the number of companies processed in parallel.
const stateExposureConcurrency = 3

// stateExposureMaxFailRatio aborts the run (non-zero exit) when exceeded.
const stateExposureMaxFailRatio = 0.2

// runStateExposureBackfill selects the top `limit` companies by market cap that
// have no state_exposure yet, then for each: LLM generate → validate → write.
// Returns an error when more than stateExposureMaxFailRatio of companies fail.
func runStateExposureBackfill(ctx context.Context, store enrichment.EnrichmentStore, client *enrichment.OpenAIGPTClient, logger *log.Logger, limit int) error {
	logger.Infof("Starting state exposure backfill (limit: %d, concurrency: %d)", limit, stateExposureConcurrency)

	candidates, err := store.GetStocksForStateExposure(limit)
	if err != nil {
		return fmt.Errorf("failed to query state exposure candidates: %w", err)
	}

	if len(candidates) == 0 {
		logger.Infof("No stocks need state exposure enrichment")
		return nil
	}

	logger.Infof("Found %d stocks needing state exposure", len(candidates))

	var (
		mu           sync.Mutex
		successCount int
		failCount    int
	)

	sem := make(chan struct{}, stateExposureConcurrency)
	var wg sync.WaitGroup

	for i, candidate := range candidates {
		wg.Add(1)
		sem <- struct{}{}
		go func(idx int, c enrichment.StateExposureCandidate) {
			defer wg.Done()
			defer func() { <-sem }()

			if err := backfillStockStateExposure(ctx, store, client, c); err != nil {
				logger.Errorf("[%d/%d] FAIL %s (%s): %v", idx+1, len(candidates), c.StockCode, c.CompanyName, err)
				mu.Lock()
				failCount++
				mu.Unlock()
				return
			}

			logger.Infof("[%d/%d] ok %s (%s)", idx+1, len(candidates), c.StockCode, c.CompanyName)
			mu.Lock()
			successCount++
			mu.Unlock()
		}(i, candidate)
	}

	wg.Wait()

	total := len(candidates)
	logger.Infof("State exposure backfill complete: %d succeeded, %d failed, %d total", successCount, failCount, total)

	if failRatio := float64(failCount) / float64(total); failRatio > stateExposureMaxFailRatio {
		return fmt.Errorf("state exposure backfill failure rate %.0f%% exceeds %.0f%% threshold (%d/%d failed)",
			failRatio*100, stateExposureMaxFailRatio*100, failCount, total)
	}

	return nil
}

// backfillStockStateExposure processes one company: generate → validate → write.
func backfillStockStateExposure(ctx context.Context, store enrichment.EnrichmentStore, client *enrichment.OpenAIGPTClient, c enrichment.StateExposureCandidate) error {
	raw, err := client.GenerateStateExposure(ctx, enrichment.StateExposureCompanyInput(c))
	if err != nil {
		return fmt.Errorf("generate: %w", err)
	}

	validated, err := enrichment.ValidateStateExposure(raw)
	if err != nil {
		return fmt.Errorf("validate: %w", err)
	}

	payload, err := json.Marshal(validated)
	if err != nil {
		return fmt.Errorf("marshal: %w", err)
	}

	if err := store.UpdateStateExposure(c.StockCode, payload); err != nil {
		return fmt.Errorf("write: %w", err)
	}

	return nil
}

// runStateExposureBackfillMain is the entry point for --backfill-state-exposure mode.
func runStateExposureBackfillMain(store enrichment.EnrichmentStore, client *enrichment.OpenAIGPTClient, logger *log.Logger, limit int) {
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Hour)
	defer cancel()

	if err := runStateExposureBackfill(ctx, store, client, logger, limit); err != nil {
		logger.Errorf("State exposure backfill failed: %v", err)
		os.Exit(1)
	}
}
