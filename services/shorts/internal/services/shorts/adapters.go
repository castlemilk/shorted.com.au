package shorts

import (
	"log"

	shortsv1alpha1 "github.com/castlemilk/shorted.com.au/services/gen/proto/go/shorts/v1alpha1"
	stocksv1alpha1 "github.com/castlemilk/shorted.com.au/services/gen/proto/go/stocks/v1alpha1"
	"github.com/castlemilk/shorted.com.au/services/shorts/internal/store/shorts"
)

// StoreAdapter adapts the concrete store implementation to the ShortsStore interface
type StoreAdapter struct {
	store shorts.Store
}

// NewStoreAdapter creates a new store adapter
func NewStoreAdapter(store shorts.Store) *StoreAdapter {
	return &StoreAdapter{store: store}
}

func (s *StoreAdapter) GetTopShorts(period string, limit int32, offset int32) ([]*stocksv1alpha1.TimeSeriesData, int, error) {
	return s.store.GetTopShorts(period, limit, offset)
}

func (s *StoreAdapter) GetStock(productCode string) (*stocksv1alpha1.Stock, error) {
	return s.store.GetStock(productCode)
}

func (s *StoreAdapter) GetStockData(productCode, period string) (*stocksv1alpha1.TimeSeriesData, error) {
	return s.store.GetStockData(productCode, period)
}

func (s *StoreAdapter) GetStockDetails(productCode string) (*stocksv1alpha1.StockDetails, error) {
	return s.store.GetStockDetails(productCode)
}

func (s *StoreAdapter) GetIndustryTreeMap(limit int32, period, viewMode string) (*stocksv1alpha1.IndustryTreeMap, error) {
	return s.store.GetIndustryTreeMap(limit, period, viewMode)
}

func (s *StoreAdapter) SearchStocks(query string, limit int32) ([]*stocksv1alpha1.Stock, error) {
	return s.store.SearchStocks(query, limit)
}

func (s *StoreAdapter) GetSyncStatus(filter shorts.SyncStatusFilter) ([]*shortsv1alpha1.SyncRun, error) {
	return s.store.GetSyncStatus(filter)
}

func (s *StoreAdapter) CleanupStuckSyncRuns() (int, error) {
	return s.store.CleanupStuckSyncRuns()
}

// GetAllStockCodes wraps the store's GetAllStockCodes
func (s *StoreAdapter) GetAllStockCodes() ([]string, error) {
	return s.store.GetAllStockCodes()
}

// StockExists wraps the store's StockExists
func (s *StoreAdapter) StockExists(stockCode string) (bool, error) {
	return s.store.StockExists(stockCode)
}

// UpdateKeyMetrics wraps the store's UpdateKeyMetrics
func (s *StoreAdapter) UpdateKeyMetrics(stockCode string, metrics map[string]interface{}) error {
	return s.store.UpdateKeyMetrics(stockCode, metrics)
}

func (s *StoreAdapter) GetTopStocksForEnrichment(limit int32, priority shortsv1alpha1.EnrichmentPriority) ([]*shortsv1alpha1.StockEnrichmentCandidate, error) {
	return s.store.GetTopStocksForEnrichment(limit, priority)
}

func (s *StoreAdapter) SavePendingEnrichment(enrichmentID, stockCode string, status shortsv1alpha1.EnrichmentStatus, data *shortsv1alpha1.EnrichmentData, quality *shortsv1alpha1.QualityScore) (string, error) {
	return s.store.SavePendingEnrichment(enrichmentID, stockCode, status, data, quality)
}

func (s *StoreAdapter) ListPendingEnrichments(limit int32, offset int32) ([]*shortsv1alpha1.PendingEnrichmentSummary, error) {
	return s.store.ListPendingEnrichments(limit, offset)
}

func (s *StoreAdapter) GetPendingEnrichment(enrichmentID string) (*shortsv1alpha1.PendingEnrichment, error) {
	return s.store.GetPendingEnrichment(enrichmentID)
}

func (s *StoreAdapter) GetPendingEnrichmentByStockCode(stockCode string) (*shortsv1alpha1.PendingEnrichmentSummary, error) {
	return s.store.GetPendingEnrichmentByStockCode(stockCode)
}

func (s *StoreAdapter) ReviewEnrichment(enrichmentID string, approve bool, reviewedBy, reviewNotes string) error {
	return s.store.ReviewEnrichment(enrichmentID, approve, reviewedBy, reviewNotes)
}

func (s *StoreAdapter) ApplyEnrichment(stockCode string, data *shortsv1alpha1.EnrichmentData) error {
	return s.store.ApplyEnrichment(stockCode, data)
}

func (s *StoreAdapter) CreateEnrichmentJob(stockCode string, force bool) (string, error) {
	return s.store.CreateEnrichmentJob(stockCode, force)
}

func (s *StoreAdapter) GetEnrichmentJob(jobID string) (*shortsv1alpha1.EnrichmentJob, error) {
	return s.store.GetEnrichmentJob(jobID)
}

func (s *StoreAdapter) GetActiveEnrichmentJobByStockCode(stockCode string) (*shortsv1alpha1.EnrichmentJob, error) {
	return s.store.GetActiveEnrichmentJobByStockCode(stockCode)
}

func (s *StoreAdapter) UpdateEnrichmentJobStatus(jobID string, status shortsv1alpha1.EnrichmentJobStatus, enrichmentID *string, errorMsg *string) error {
	return s.store.UpdateEnrichmentJobStatus(jobID, status, enrichmentID, errorMsg)
}

func (s *StoreAdapter) ListEnrichmentJobs(limit, offset int32, status *shortsv1alpha1.EnrichmentJobStatus) ([]*shortsv1alpha1.EnrichmentJob, int32, error) {
	return s.store.ListEnrichmentJobs(limit, offset, status)
}

func (s *StoreAdapter) UpdateLogoURLs(stockCode, logoGCSURL, logoIconGCSURL string) error {
	return s.store.UpdateLogoURLs(stockCode, logoGCSURL, logoIconGCSURL)
}

func (s *StoreAdapter) UpdateLogoURLsWithSVG(stockCode, logoGCSURL, logoIconGCSURL, logoSVGGCSURL, logoSourceURL, logoFormat string) error {
	return s.store.UpdateLogoURLsWithSVG(stockCode, logoGCSURL, logoIconGCSURL, logoSVGGCSURL, logoSourceURL, logoFormat)
}

func (s *StoreAdapter) GetAPISubscription(userID string) (*shorts.APISubscription, error) {
	return s.store.GetAPISubscription(userID)
}

func (s *StoreAdapter) GetAPISubscriptionByCustomer(stripeCustomerID string) (*shorts.APISubscription, error) {
	return s.store.GetAPISubscriptionByCustomer(stripeCustomerID)
}

func (s *StoreAdapter) UpsertAPISubscription(sub *shorts.APISubscription) error {
	return s.store.UpsertAPISubscription(sub)
}

func (s *StoreAdapter) UpdateAPISubscriptionByCustomer(stripeCustomerID string, update *shorts.APISubscriptionUpdate) error {
	return s.store.UpdateAPISubscriptionByCustomer(stripeCustomerID, update)
}

// LoggerAdapter adapts the standard logger to the Logger interface
type LoggerAdapter struct{}

// NewLoggerAdapter creates a new logger adapter
func NewLoggerAdapter() *LoggerAdapter {
	return &LoggerAdapter{}
}

func (l *LoggerAdapter) Debugf(format string, args ...interface{}) {
	log.Printf("[DEBUG] "+format, args...)
}

func (l *LoggerAdapter) Infof(format string, args ...interface{}) {
	log.Printf("[INFO] "+format, args...)
}

func (l *LoggerAdapter) Warnf(format string, args ...interface{}) {
	log.Printf("[WARN] "+format, args...)
}

func (l *LoggerAdapter) Errorf(format string, args ...interface{}) {
	log.Printf("[ERROR] "+format, args...)
}
