package shorts

import (
	"context"
	"encoding/json"
	"fmt"
	"os/exec"
	"strings"
	"sync/atomic"
	"time"

	"connectrpc.com/connect"
	shortsv1alpha1 "github.com/castlemilk/shorted.com.au/services/gen/proto/go/shorts/v1alpha1"
)

// keyMetricsSyncRunning is a process-level guard ensuring only one
// SyncKeyMetrics goroutine runs per container instance at a time. If a
// scheduler retry arrives while a sync is already in flight, we return
// success immediately without starting a second loop.
var keyMetricsSyncRunning atomic.Bool

// SyncKeyMetrics triggers an on-demand sync of key metrics for specific
// stocks. The sync is heavy (forks python+yfinance per stock with rate-
// limit pacing) and does not fit inside a single Cloud Run request
// timeout, so this handler kicks the work off in a background goroutine
// and returns success immediately. The scheduler only needs to know the
// trigger landed; actual progress is visible in service logs and the
// downstream database state.
func (s *ShortsServer) SyncKeyMetrics(
	ctx context.Context,
	req *connect.Request[shortsv1alpha1.SyncKeyMetricsRequest],
) (*connect.Response[shortsv1alpha1.SyncKeyMetricsResponse], error) {
	if err := ValidateSyncKeyMetricsRequest(req.Msg); err != nil {
		s.logger.Errorf("validation failed for SyncKeyMetrics: %v", err)
		return nil, err
	}

	stockCodes := req.Msg.StockCodes
	force := req.Msg.Force

	if len(stockCodes) == 0 {
		allStocks, err := s.store.GetAllStockCodes()
		if err != nil {
			s.logger.Errorf("failed to get all stock codes: %v", err)
			return nil, connect.NewError(connect.CodeInternal,
				fmt.Errorf("failed to get stock list"))
		}
		stockCodes = allStocks
	}

	totalRequested := int32(len(stockCodes))

	// Single-flight guard. If another sync is in flight on this instance,
	// just acknowledge the trigger and return — don't start another one.
	if !keyMetricsSyncRunning.CompareAndSwap(false, true) {
		s.logger.Infof("SyncKeyMetrics: already in flight, skipping new run for %d stocks", totalRequested)
		return connect.NewResponse(&shortsv1alpha1.SyncKeyMetricsResponse{
			TotalRequested:     totalRequested,
			SuccessfullySynced: 0,
			Failed:             0,
			Results:            nil,
			DurationSeconds:    0,
		}), nil
	}

	s.logger.Infof("SyncKeyMetrics: dispatching background sync for %d stocks (force=%v)", totalRequested, force)

	// Detached context so the goroutine survives the request's scope.
	// Cloud Run keeps the instance alive while the goroutine is doing work
	// (idle timeout is generous), but instance termination is still
	// possible mid-sync — we accept that risk; the next scheduled run
	// picks up where the database left off.
	go func(stockCodes []string, force bool) {
		defer keyMetricsSyncRunning.Store(false)
		bgCtx := context.Background()
		s.runKeyMetricsSync(bgCtx, stockCodes, force)
	}(stockCodes, force)

	return connect.NewResponse(&shortsv1alpha1.SyncKeyMetricsResponse{
		TotalRequested:     totalRequested,
		SuccessfullySynced: 0,
		Failed:             0,
		Results:            nil,
		DurationSeconds:    0,
	}), nil
}

// runKeyMetricsSync executes the actual sync loop. Always called from a
// background goroutine started by SyncKeyMetrics.
func (s *ShortsServer) runKeyMetricsSync(ctx context.Context, stockCodes []string, force bool) {
	startTime := time.Now()
	successCount := 0
	failCount := 0

	for i, stockCode := range stockCodes {
		s.logger.Debugf("[%d/%d] Syncing %s...", i+1, len(stockCodes), stockCode)

		result := s.syncSingleStock(ctx, stockCode, force)
		if result.Success {
			successCount++
		} else {
			failCount++
		}

		// Small delay to respect Yahoo Finance rate limits.
		if i < len(stockCodes)-1 {
			time.Sleep(100 * time.Millisecond)
		}
	}

	duration := time.Since(startTime).Seconds()
	s.logger.Infof("SyncKeyMetrics: complete. %d/%d succeeded, %d failed in %.1fs",
		successCount, len(stockCodes), failCount, duration)
}

// syncSingleStock syncs key metrics for a single stock
func (s *ShortsServer) syncSingleStock(ctx context.Context, stockCode string, force bool) *shortsv1alpha1.StockSyncResult {
	result := &shortsv1alpha1.StockSyncResult{
		StockCode: stockCode,
		Success:   false,
	}

	exists, err := s.store.StockExists(stockCode)
	if err != nil {
		result.ErrorMessage = fmt.Sprintf("database error: %v", err)
		return result
	}
	if !exists {
		result.ErrorMessage = "stock not found in company-metadata"
		return result
	}

	metrics, err := fetchKeyMetricsFromYahoo(stockCode)
	if err != nil {
		result.ErrorMessage = fmt.Sprintf("failed to fetch from Yahoo Finance: %v", err)
		return result
	}

	if metrics == nil {
		result.ErrorMessage = "no data available from Yahoo Finance"
		return result
	}

	if err := s.store.UpdateKeyMetrics(stockCode, metrics); err != nil {
		result.ErrorMessage = fmt.Sprintf("failed to save to database: %v", err)
		return result
	}

	result.Success = true
	result.Metrics = &shortsv1alpha1.KeyMetricsData{
		MarketCap:        getFloat64(metrics, "market_cap"),
		PeRatio:          getFloat64(metrics, "pe_ratio"),
		Eps:              getFloat64(metrics, "eps"),
		DividendYield:    getFloat64(metrics, "dividend_yield"),
		Beta:             getFloat64(metrics, "beta"),
		FiftyTwoWeekHigh: getFloat64(metrics, "fifty_two_week_high"),
		FiftyTwoWeekLow:  getFloat64(metrics, "fifty_two_week_low"),
		AvgVolume:        getFloat64(metrics, "avg_volume"),
	}

	return result
}

// fetchKeyMetricsFromYahoo fetches key metrics from Yahoo Finance using a Python script.
func fetchKeyMetricsFromYahoo(stockCode string) (map[string]interface{}, error) {
	scriptPaths := []string{
		"./scripts/fetch_key_metrics.py",
		"./shorts/scripts/fetch_key_metrics.py",
		"/app/scripts/fetch_key_metrics.py",
	}

	var cmd *exec.Cmd
	for _, path := range scriptPaths {
		cmd = exec.Command("python3", path, stockCode)
		output, err := cmd.CombinedOutput()
		if err == nil {
			var result map[string]interface{}
			if err := json.Unmarshal(output, &result); err != nil {
				return nil, fmt.Errorf("failed to parse Python script output: %w", err)
			}
			if errMsg, ok := result["error"].(string); ok {
				return nil, fmt.Errorf("yahoo Finance error: %s", errMsg)
			}
			return result, nil
		}
		if !strings.Contains(err.Error(), "no such file") && !strings.Contains(string(output), "can't open file") {
			return nil, fmt.Errorf("python script failed: %w, output: %s", err, string(output))
		}
	}

	return nil, fmt.Errorf("fetch_key_metrics.py script not found in any of: %v", scriptPaths)
}

// getFloat64 safely extracts a float64 from a map
func getFloat64(m map[string]interface{}, key string) float64 {
	if v, ok := m[key]; ok {
		if f, ok := v.(float64); ok {
			return f
		}
	}
	return 0
}

// ValidateSyncKeyMetricsRequest validates the sync request
func ValidateSyncKeyMetricsRequest(req *shortsv1alpha1.SyncKeyMetricsRequest) error {
	// Stock codes are optional (empty = sync all)
	// Force is optional (defaults to false)
	return nil
}
