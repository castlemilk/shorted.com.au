package shorts

import (
	"fmt"

	shortsv1alpha1 "github.com/castlemilk/shorted.com.au/services/gen/proto/go/shorts/v1alpha1"
	stocksv1alpha1 "github.com/castlemilk/shorted.com.au/services/gen/proto/go/stocks/v1alpha1"
	"github.com/castlemilk/shorted.com.au/services/pkg/enrichment"
	shortsstore "github.com/castlemilk/shorted.com.au/services/shorts/internal/store/shorts"
)

// EnrichmentStoreConfig for creating enrichment stores
type EnrichmentStoreConfig struct {
	PostgresAddress  string
	PostgresDatabase string
	PostgresUsername string
	PostgresPassword string
}

// NewEnrichmentStore creates an EnrichmentStore from the internal store implementation
func NewEnrichmentStore(config EnrichmentStoreConfig) (enrichment.EnrichmentStore, error) {
	storeConfig := shortsstore.Config{
		StorageBackend:    shortsstore.PostgresStore,
		PostgresAddress:   config.PostgresAddress,
		PostgresDatabase:  config.PostgresDatabase,
		PostgresUsername:  config.PostgresUsername,
		PostgresPassword:  config.PostgresPassword,
	}

	internalStore, err := shortsstore.NewStore(storeConfig)
	if err != nil {
		return nil, fmt.Errorf("failed to create store: %w", err)
	}

	return &enrichmentStoreAdapter{store: internalStore}, nil
}

// enrichmentStoreAdapter wraps the internal store to implement EnrichmentStore
type enrichmentStoreAdapter struct {
	store shortsstore.Store
}

func (a *enrichmentStoreAdapter) GetStockDetails(stockCode string) (*stocksv1alpha1.StockDetails, error) {
	return a.store.GetStockDetails(stockCode)
}

func (a *enrichmentStoreAdapter) GetEnrichmentJob(jobID string) (*shortsv1alpha1.EnrichmentJob, error) {
	return a.store.GetEnrichmentJob(jobID)
}

func (a *enrichmentStoreAdapter) UpdateEnrichmentJobStatus(jobID string, status shortsv1alpha1.EnrichmentJobStatus, enrichmentID *string, errorMsg *string) error {
	return a.store.UpdateEnrichmentJobStatus(jobID, status, enrichmentID, errorMsg)
}

func (a *enrichmentStoreAdapter) ListEnrichmentJobs(limit, offset int32, status *shortsv1alpha1.EnrichmentJobStatus) ([]*shortsv1alpha1.EnrichmentJob, int32, error) {
	return a.store.ListEnrichmentJobs(limit, offset, status)
}

func (a *enrichmentStoreAdapter) ResetStuckJobs(stuckThresholdMinutes int) (int, error) {
	return a.store.ResetStuckJobs(stuckThresholdMinutes)
}

// CleanupOldCompletedJobs removes old completed jobs, keeping only the most recent ones per stock
func (a *enrichmentStoreAdapter) CleanupOldCompletedJobs(keepPerStock int) (int, error) {
	return a.store.CleanupOldCompletedJobs(keepPerStock)
}

func (a *enrichmentStoreAdapter) UpdateLogoURLs(stockCode, logoGCSURL, logoIconGCSURL string) error {
	return a.store.UpdateLogoURLs(stockCode, logoGCSURL, logoIconGCSURL)
}

func (a *enrichmentStoreAdapter) UpdateLogoURLsWithSVG(stockCode, logoGCSURL, logoIconGCSURL, logoSVGGCSURL, logoSourceURL, logoFormat string) error {
	return a.store.UpdateLogoURLsWithSVG(stockCode, logoGCSURL, logoIconGCSURL, logoSVGGCSURL, logoSourceURL, logoFormat)
}

func (a *enrichmentStoreAdapter) SavePendingEnrichment(enrichmentID, stockCode string, status shortsv1alpha1.EnrichmentStatus, data *shortsv1alpha1.EnrichmentData, quality *shortsv1alpha1.QualityScore) (string, error) {
	return a.store.SavePendingEnrichment(enrichmentID, stockCode, status, data, quality)
}

func (a *enrichmentStoreAdapter) GetTopStocksForEnrichment(limit int32, priority shortsv1alpha1.EnrichmentPriority) ([]*shortsv1alpha1.StockEnrichmentCandidate, error) {
	return a.store.GetTopStocksForEnrichment(limit, priority)
}

func (a *enrichmentStoreAdapter) CreateEnrichmentJob(stockCode string, force bool) (string, error) {
	return a.store.CreateEnrichmentJob(stockCode, force)
}

func (a *enrichmentStoreAdapter) GetActiveEnrichmentJobByStockCode(stockCode string) (*shortsv1alpha1.EnrichmentJob, error) {
	return a.store.GetActiveEnrichmentJobByStockCode(stockCode)
}

func (a *enrichmentStoreAdapter) ReviewEnrichment(enrichmentID string, approve bool, reviewedBy, reviewNotes string) error {
	return a.store.ReviewEnrichment(enrichmentID, approve, reviewedBy, reviewNotes)
}

func (a *enrichmentStoreAdapter) ApplyEnrichment(stockCode string, data *shortsv1alpha1.EnrichmentData) error {
	return a.store.ApplyEnrichment(stockCode, data)
}

func (a *enrichmentStoreAdapter) GetPendingEnrichment(enrichmentID string) (*shortsv1alpha1.PendingEnrichment, error) {
	return a.store.GetPendingEnrichment(enrichmentID)
}

func (a *enrichmentStoreAdapter) GetEnrichmentStats() (*enrichment.EnrichmentStats, error) {
	stats, err := a.store.GetEnrichmentStats()
	if err != nil {
		return nil, err
	}
	return &enrichment.EnrichmentStats{
		TotalStocks:     stats.TotalStocks,
		Enriched:        stats.Enriched,
		PendingReview:   stats.PendingReview,
		Failed:          stats.Failed,
		Unenriched:      stats.Unenriched,
		CoveragePercent: stats.CoveragePercent,
	}, nil
}

func (a *enrichmentStoreAdapter) GetStocksForPeopleEnrichment(limit int) ([]enrichment.StockPeopleData, error) {
	rows, err := a.store.GetStocksForPeopleEnrichment(limit)
	if err != nil {
		return nil, err
	}
	result := make([]enrichment.StockPeopleData, len(rows))
	for i, row := range rows {
		result[i] = enrichment.StockPeopleData{
			StockCode:   row.StockCode,
			CompanyName: row.CompanyName,
			KeyPeople:   row.KeyPeople,
		}
	}
	return result, nil
}

func (a *enrichmentStoreAdapter) UpdateKeyPeopleEnriched(stockCode string, keyPeopleJSON []byte) error {
	return a.store.UpdateKeyPeopleEnriched(stockCode, keyPeopleJSON)
}


// Explicit interface check to ensure enrichmentStoreAdapter implements enrichment.EnrichmentStore
var _ enrichment.EnrichmentStore = (*enrichmentStoreAdapter)(nil)

type ErrStoreCreationFailed struct{}

func (e *ErrStoreCreationFailed) Error() string {
	return "failed to create store"
}

