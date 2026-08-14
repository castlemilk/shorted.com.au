package enrichment

import (
	shortsv1alpha1 "github.com/castlemilk/shorted.com.au/services/gen/proto/go/shorts/v1alpha1"
	stockv1alpha1 "github.com/castlemilk/shorted.com.au/services/gen/proto/go/stocks/v1alpha1"
)

// StockPeopleData contains a stock's key people data for backfill processing
type StockPeopleData struct {
	StockCode   string
	CompanyName string
	KeyPeople   []byte // Raw JSONB from the database
}

// StateExposureCandidate contains the company context needed to generate an
// operations-weighted state exposure breakdown.
type StateExposureCandidate struct {
	StockCode   string
	CompanyName string
	Industry    string
	Sector      string
	Summary     string
	Description string
}

// EnrichmentStats holds enrichment coverage statistics
type EnrichmentStats struct {
	TotalStocks    int     `json:"total_stocks"`
	Enriched       int     `json:"enriched"`
	PendingReview  int     `json:"pending_review"`
	Failed         int     `json:"failed"`
	Unenriched     int     `json:"unenriched"`
	CoveragePercent float64 `json:"coverage_percent"`
}

// EnrichmentStore defines the minimal interface needed for enrichment processing
type EnrichmentStore interface {
	// Get stock details for enrichment
	GetStockDetails(stockCode string) (*stockv1alpha1.StockDetails, error)

	// Enrichment job management
	GetEnrichmentJob(jobID string) (*shortsv1alpha1.EnrichmentJob, error)
	UpdateEnrichmentJobStatus(jobID string, status shortsv1alpha1.EnrichmentJobStatus, enrichmentID *string, errorMsg *string) error
	ListEnrichmentJobs(limit, offset int32, status *shortsv1alpha1.EnrichmentJobStatus) ([]*shortsv1alpha1.EnrichmentJob, int32, error)
	ResetStuckJobs(stuckThresholdMinutes int) (int, error) // Reset jobs stuck in processing for > threshold minutes
	CleanupOldCompletedJobs(keepPerStock int) (int, error) // Clean up old completed jobs, keeping only keepPerStock most recent per stock

	// Save pending enrichment - returns the actual enrichment ID used (may differ if existing pending review is updated)
	SavePendingEnrichment(enrichmentID, stockCode string, status shortsv1alpha1.EnrichmentStatus, data *shortsv1alpha1.EnrichmentData, quality *shortsv1alpha1.QualityScore) (string, error)

	// Batch enrichment methods
	GetTopStocksForEnrichment(limit int32, priority shortsv1alpha1.EnrichmentPriority) ([]*shortsv1alpha1.StockEnrichmentCandidate, error)
	CreateEnrichmentJob(stockCode string, force bool) (string, error)
	GetActiveEnrichmentJobByStockCode(stockCode string) (*shortsv1alpha1.EnrichmentJob, error)

	// Review and apply enrichment
	ReviewEnrichment(enrichmentID string, approve bool, reviewedBy, reviewNotes string) error
	ApplyEnrichment(stockCode string, data *shortsv1alpha1.EnrichmentData) error
	GetPendingEnrichment(enrichmentID string) (*shortsv1alpha1.PendingEnrichment, error)

	// Enrichment statistics
	GetEnrichmentStats() (*EnrichmentStats, error)

	// Update logo URLs
	UpdateLogoURLs(stockCode, logoGCSURL, logoIconGCSURL string) error
	UpdateLogoURLsWithSVG(stockCode, logoGCSURL, logoIconGCSURL, logoSVGGCSURL, logoSourceURL, logoFormat string) error

	// Person enrichment backfill methods
	GetStocksForPeopleEnrichment(limit int) ([]StockPeopleData, error)
	GetStocksForPeopleReenrichment(limit int, afterStockCode string) ([]StockPeopleData, error)
	GetStocksForImageBackfill(limit int, afterStockCode string) ([]StockPeopleData, error)
	UpdateKeyPeopleEnriched(stockCode string, keyPeopleJSON []byte) error
	// UpdateKeyPeopleIfEmpty writes key_people ONLY when the served row currently has
	// none (§6.5 additive people-only write, used when the whole-company quality score
	// is below the auto-approve gate). Returns true when a row was actually written.
	UpdateKeyPeopleIfEmpty(stockCode string, keyPeopleJSON []byte) (bool, error)

	// State exposure backfill methods
	GetStocksForStateExposure(limit int) ([]StateExposureCandidate, error)
	UpdateStateExposure(stockCode string, exposureJSON []byte) error
}
