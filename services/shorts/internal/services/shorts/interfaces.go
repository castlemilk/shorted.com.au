package shorts

import (
	shortsv1alpha1 "github.com/castlemilk/shorted.com.au/services/gen/proto/go/shorts/v1alpha1"
	stocksv1alpha1 "github.com/castlemilk/shorted.com.au/services/gen/proto/go/stocks/v1alpha1"
	shortsstore "github.com/castlemilk/shorted.com.au/services/shorts/internal/store/shorts"
)

//go:generate mockgen -source=interfaces.go -destination=mocks/mock_interfaces.go -package=mocks

// ShortsStore defines the interface for shorts data operations
type ShortsStore interface {
	GetTopShorts(period string, limit int32, offset int32) ([]*stocksv1alpha1.TimeSeriesData, int, error)
	GetStock(productCode string) (*stocksv1alpha1.Stock, error)
	GetStockData(productCode, period string) (*stocksv1alpha1.TimeSeriesData, error)
	GetStockDetails(productCode string) (*stocksv1alpha1.StockDetails, error)
	GetIndustryTreeMap(limit int32, period, viewMode string) (*stocksv1alpha1.IndustryTreeMap, error)
	SearchStocks(query string, limit int32) ([]*stocksv1alpha1.Stock, error)
	GetSyncStatus(filter shortsstore.SyncStatusFilter) ([]*shortsv1alpha1.SyncRun, error)
	CleanupStuckSyncRuns() (int, error)

	// Key metrics sync methods
	GetAllStockCodes() ([]string, error)
	StockExists(stockCode string) (bool, error)
	UpdateKeyMetrics(stockCode string, metrics map[string]interface{}) error

	// Enrichment (v2) review workflow methods
	GetTopStocksForEnrichment(limit int32, priority shortsv1alpha1.EnrichmentPriority) ([]*shortsv1alpha1.StockEnrichmentCandidate, error)
	SavePendingEnrichment(enrichmentID, stockCode string, status shortsv1alpha1.EnrichmentStatus, data *shortsv1alpha1.EnrichmentData, quality *shortsv1alpha1.QualityScore) (string, error)
	ListPendingEnrichments(limit int32, offset int32) ([]*shortsv1alpha1.PendingEnrichmentSummary, error)
	GetPendingEnrichment(enrichmentID string) (*shortsv1alpha1.PendingEnrichment, error)
	GetPendingEnrichmentByStockCode(stockCode string) (*shortsv1alpha1.PendingEnrichmentSummary, error)
	ReviewEnrichment(enrichmentID string, approve bool, reviewedBy, reviewNotes string) error
	ApplyEnrichment(stockCode string, data *shortsv1alpha1.EnrichmentData) error

	// Enrichment job methods (async processing)
	CreateEnrichmentJob(stockCode string, force bool) (string, error)
	GetEnrichmentJob(jobID string) (*shortsv1alpha1.EnrichmentJob, error)
	GetActiveEnrichmentJobByStockCode(stockCode string) (*shortsv1alpha1.EnrichmentJob, error)
	UpdateEnrichmentJobStatus(jobID string, status shortsv1alpha1.EnrichmentJobStatus, enrichmentID *string, errorMsg *string) error
	ListEnrichmentJobs(limit, offset int32, status *shortsv1alpha1.EnrichmentJobStatus) ([]*shortsv1alpha1.EnrichmentJob, int32, error)

	// Logo methods
	UpdateLogoURLs(stockCode, logoGCSURL, logoIconGCSURL string) error
	UpdateLogoURLsWithSVG(stockCode, logoGCSURL, logoIconGCSURL, logoSVGGCSURL, logoSourceURL, logoFormat string) error

	// API Subscription methods
	GetAPISubscription(userID string) (*shortsstore.APISubscription, error)
	GetAPISubscriptionByCustomer(stripeCustomerID string) (*shortsstore.APISubscription, error)
	UpsertAPISubscription(sub *shortsstore.APISubscription) error
	UpdateAPISubscriptionByCustomer(stripeCustomerID string, update *shortsstore.APISubscriptionUpdate) error
}

// Cache defines the interface for caching operations
type Cache interface {
	Get(key string) (interface{}, bool)
	Set(key string, value interface{})
	GetOrSet(key string, computeFn func() (interface{}, error)) (interface{}, error)
	Delete(key string)
	Clear()
	Size() int

	// Cache key generators
	GetTopShortsKey(period string, limit int32, offset int32) string
	GetStockKey(productCode string) string
	GetStockDataKey(productCode, period string) string
	GetStockDetailsKey(productCode string) string
	GetIndustryTreeMapKey(limit int32, period, viewMode string) string
	GetSearchStocksKey(query string, limit int32) string
}

// Logger defines the interface for logging operations
type Logger interface {
	Debugf(format string, args ...interface{})
	Infof(format string, args ...interface{})
	Warnf(format string, args ...interface{})
	Errorf(format string, args ...interface{})
}
