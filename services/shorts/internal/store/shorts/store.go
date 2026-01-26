package shorts

import (
	shortsv1alpha1 "github.com/castlemilk/shorted.com.au/services/gen/proto/go/shorts/v1alpha1"
	stockv1alpha1 "github.com/castlemilk/shorted.com.au/services/gen/proto/go/stocks/v1alpha1"
)

// SyncStatusFilter defines filtering options for sync status queries
type SyncStatusFilter struct {
	Limit       int
	Environment string // "production", "development", or empty for all
	ExcludeLocal bool   // if true, exclude runs from local hostnames
}

type Store interface {
	GetStock(string) (*stockv1alpha1.Stock, error)
	GetTopShorts(string, int32, int32) ([]*stockv1alpha1.TimeSeriesData, int, error)
	GetStockDetails(string) (*stockv1alpha1.StockDetails, error)
	GetStockData(string, string) (*stockv1alpha1.TimeSeriesData, error)
	GetIndustryTreeMap(int32, string, string) (*stockv1alpha1.IndustryTreeMap, error)
	RegisterEmail(string) error
	SearchStocks(string, int32) ([]*stockv1alpha1.Stock, error)
	GetSyncStatus(filter SyncStatusFilter) ([]*shortsv1alpha1.SyncRun, error)
	
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
	ResetStuckJobs(stuckThresholdMinutes int) (int, error) // Reset jobs stuck in processing for > threshold minutes
	CleanupOldCompletedJobs(keepPerStock int) (int, error) // Clean up old completed jobs, keeping only keepPerStock most recent per stock
	UpdateLogoURLs(stockCode, logoGCSURL, logoIconGCSURL string) error
	UpdateLogoURLsWithSVG(stockCode, logoGCSURL, logoIconGCSURL, logoSVGGCSURL, logoSourceURL, logoFormat string) error

	// API Subscription methods
	GetAPISubscription(userID string) (*APISubscription, error)
	GetAPISubscriptionByCustomer(stripeCustomerID string) (*APISubscription, error)
	UpsertAPISubscription(sub *APISubscription) error
	UpdateAPISubscriptionByCustomer(stripeCustomerID string, update *APISubscriptionUpdate) error
}

// APISubscription represents a user's API subscription status
type APISubscription struct {
	UserID               string
	UserEmail            string
	StripeCustomerID     string
	StripeSubscriptionID string
	Status               string  // active, canceled, past_due, inactive, trialing
	Tier                 string  // free, pro, enterprise
	CurrentPeriodStart   *string
	CurrentPeriodEnd     *string
	CancelAtPeriodEnd    bool
}

// APISubscriptionUpdate represents fields to update on a subscription
type APISubscriptionUpdate struct {
	Status             *string
	Tier               *string
	CurrentPeriodStart *string
	CurrentPeriodEnd   *string
	CancelAtPeriodEnd  *bool
}

func NewStore(config Config) Store {
	switch config.StorageBackend {
	case PostgresStore:
		return newPostgresStore(config)
	default:
		return nil
	}
}
