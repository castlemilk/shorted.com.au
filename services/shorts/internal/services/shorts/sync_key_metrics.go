package shorts

import (
	"context"
	"encoding/json"
	"fmt"
	"os/exec"
	"strings"
	"time"

	"connectrpc.com/connect"
	shortsv1alpha1 "github.com/castlemilk/shorted.com.au/services/gen/proto/go/shorts/v1alpha1"
)

// SyncKeyMetrics triggers an on-demand sync of key metrics for specific stocks
func (s *ShortsServer) SyncKeyMetrics(
	ctx context.Context,
	req *connect.Request[shortsv1alpha1.SyncKeyMetricsRequest],
) (*connect.Response[shortsv1alpha1.SyncKeyMetricsResponse], error) {
	startTime := time.Now()

	// Validate and set defaults
	if err := ValidateSyncKeyMetricsRequest(req.Msg); err != nil {
		s.logger.Errorf("validation failed for SyncKeyMetrics: %v", err)
		return nil, err
	}

	stockCodes := req.Msg.StockCodes
	force := req.Msg.Force

	// If no stock codes provided, get all stocks from company-metadata
	if len(stockCodes) == 0 {
		allStocks, err := s.store.GetAllStockCodes()
		if err != nil {
			s.logger.Errorf("failed to get all stock codes: %v", err)
			return nil, connect.NewError(connect.CodeInternal, 
				fmt.Errorf("failed to get stock list"))
		}
		stockCodes = allStocks
	}

	s.logger.Infof("Starting key metrics sync for %d stocks (force=%v)", len(stockCodes), force)

	totalRequested := int32(len(stockCodes))
	var results []*shortsv1alpha1.StockSyncResult
	successCount := int32(0)
	failCount := int32(0)

	// Sync each stock
	for i, stockCode := range stockCodes {
		s.logger.Debugf("[%d/%d] Syncing %s...", i+1, len(stockCodes), stockCode)
		
		result := s.syncSingleStock(ctx, stockCode, force)
		results = append(results, result)
		
		if result.Success {
			successCount++
		} else {
			failCount++
		}

		// Add small delay to respect Yahoo Finance rate limits
		if i < len(stockCodes)-1 {
			time.Sleep(100 * time.Millisecond)
		}
	}

	duration := time.Since(startTime).Seconds()

	s.logger.Infof("Key metrics sync complete: %d succeeded, %d failed in %.2fs", 
		successCount, failCount, duration)

	response := &shortsv1alpha1.SyncKeyMetricsResponse{
		TotalRequested:    totalRequested,
		SuccessfullySynced: successCount,
		Failed:            failCount,
		Results:           results,
		DurationSeconds:   duration,
	}

	return connect.NewResponse(response), nil
}

// syncSingleStock syncs key metrics for a single stock
func (s *ShortsServer) syncSingleStock(ctx context.Context, stockCode string, force bool) *shortsv1alpha1.StockSyncResult {
	result := &shortsv1alpha1.StockSyncResult{
		StockCode: stockCode,
		Success:   false,
	}

	// Check if stock exists in company-metadata
	exists, err := s.store.StockExists(stockCode)
	if err != nil {
		result.ErrorMessage = fmt.Sprintf("database error: %v", err)
		return result
	}
	if !exists {
		result.ErrorMessage = "stock not found in company-metadata"
		return result
	}

	// Fetch metrics from Yahoo Finance
	metrics, err := fetchKeyMetricsFromYahoo(stockCode)
	if err != nil {
		result.ErrorMessage = fmt.Sprintf("failed to fetch from Yahoo Finance: %v", err)
		return result
	}

	if metrics == nil {
		result.ErrorMessage = "no data available from Yahoo Finance"
		return result
	}

	// Save to database
	if err := s.store.UpdateKeyMetrics(stockCode, metrics); err != nil {
		result.ErrorMessage = fmt.Sprintf("failed to save to database: %v", err)
		return result
	}

	// Populate result with synced metrics
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

// fetchKeyMetricsFromYahoo fetches key metrics from Yahoo Finance using Python script
func fetchKeyMetricsFromYahoo(stockCode string) (map[string]interface{}, error) {
	// Determine the script path - check multiple locations
	scriptPaths := []string{
		"./scripts/fetch_key_metrics.py",
		"./shorts/scripts/fetch_key_metrics.py",
		"/app/scripts/fetch_key_metrics.py", // Docker path
	}
	
	var cmd *exec.Cmd
	for _, path := range scriptPaths {
		cmd = exec.Command("python3", path, stockCode)
		// Try first path
		output, err := cmd.CombinedOutput()
		if err == nil {
			// Success!
			var result map[string]interface{}
			if err := json.Unmarshal(output, &result); err != nil {
				return nil, fmt.Errorf("failed to parse Python script output: %w", err)
			}

	// Check for error in response
	if errMsg, ok := result["error"].(string); ok {
		return nil, fmt.Errorf("yahoo Finance error: %s", errMsg)
	}

			return result, nil
		}
		// If error is not "file not found", return it
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

