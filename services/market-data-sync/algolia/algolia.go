package algolia

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"net/http"
	"time"
)

// Syncer handles Algolia index synchronization
type Syncer struct {
	appID    string
	adminKey string
	index    string
	client   *http.Client
}

// StockRecord represents a stock record for Algolia indexing
type StockRecord struct {
	ObjectID    string   `json:"objectID"`
	StockCode   string   `json:"stock_code"`
	CompanyName string   `json:"company_name"`
	Industry    string   `json:"industry,omitempty"`
	Tags        []string `json:"tags,omitempty"`
}

// New creates a new Algolia Syncer
func New(appID, adminKey, index string) *Syncer {
	return &Syncer{
		appID:    appID,
		adminKey: adminKey,
		index:    index,
		client: &http.Client{
			Timeout: 30 * time.Second,
		},
	}
}

// IsConfigured returns true if Algolia credentials are set
func (s *Syncer) IsConfigured() bool {
	return s.appID != "" && s.adminKey != ""
}

// SyncBatch sends a batch of stock records to Algolia
func (s *Syncer) SyncBatch(ctx context.Context, records []StockRecord) (int, error) {
	if len(records) == 0 {
		return 0, nil
	}

	if !s.IsConfigured() {
		return 0, fmt.Errorf("algolia is not configured")
	}

	// Build batch request
	requests := make([]map[string]interface{}, len(records))
	for i, r := range records {
		requests[i] = map[string]interface{}{
			"action": "updateObject",
			"body":   r,
		}
	}

	body := map[string]interface{}{"requests": requests}
	bodyBytes, err := json.Marshal(body)
	if err != nil {
		return 0, fmt.Errorf("failed to marshal batch request: %w", err)
	}

	url := fmt.Sprintf("https://%s.algolia.net/1/indexes/%s/batch", s.appID, s.index)
	req, err := http.NewRequestWithContext(ctx, "POST", url, bytes.NewReader(bodyBytes))
	if err != nil {
		return 0, fmt.Errorf("failed to create request: %w", err)
	}

	req.Header.Set("X-Algolia-API-Key", s.adminKey)
	req.Header.Set("X-Algolia-Application-Id", s.appID)
	req.Header.Set("Content-Type", "application/json")

	resp, err := s.client.Do(req)
	if err != nil {
		return 0, fmt.Errorf("request failed: %w", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		respBody, _ := io.ReadAll(resp.Body)
		return 0, fmt.Errorf("algolia returned status %d: %s", resp.StatusCode, string(respBody))
	}

	return len(records), nil
}

// SyncBatchWithRetry sends a batch with retry logic
func (s *Syncer) SyncBatchWithRetry(ctx context.Context, records []StockRecord, maxRetries int) (int, error) {
	var lastErr error
	for attempt := 0; attempt <= maxRetries; attempt++ {
		if attempt > 0 {
			// Exponential backoff
			backoff := time.Duration(attempt*attempt) * time.Second
			log.Printf("🔄 Retrying Algolia sync (attempt %d/%d) after %v", attempt+1, maxRetries+1, backoff)
			select {
			case <-ctx.Done():
				return 0, ctx.Err()
			case <-time.After(backoff):
			}
		}

		count, err := s.SyncBatch(ctx, records)
		if err == nil {
			return count, nil
		}
		lastErr = err
		log.Printf("⚠️ Algolia sync attempt %d failed: %v", attempt+1, err)
	}
	return 0, fmt.Errorf("all %d retry attempts failed: %w", maxRetries+1, lastErr)
}

// SyncInBatches splits records into batches and syncs them
func (s *Syncer) SyncInBatches(ctx context.Context, records []StockRecord, batchSize int) (int, error) {
	if batchSize <= 0 {
		batchSize = 1000 // Algolia recommends batches of 1000
	}

	totalSynced := 0
	for i := 0; i < len(records); i += batchSize {
		end := i + batchSize
		if end > len(records) {
			end = len(records)
		}

		batch := records[i:end]
		count, err := s.SyncBatchWithRetry(ctx, batch, 3)
		if err != nil {
			return totalSynced, fmt.Errorf("failed to sync batch %d-%d: %w", i, end, err)
		}
		totalSynced += count

		log.Printf("🔍 Synced batch %d-%d to Algolia (%d records)", i, end, count)
	}

	return totalSynced, nil
}
