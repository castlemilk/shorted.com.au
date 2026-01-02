package enrichment

import (
	shortsv1alpha1 "github.com/castlemilk/shorted.com.au/services/gen/proto/go/shorts/v1alpha1"
	stockv1alpha1 "github.com/castlemilk/shorted.com.au/services/gen/proto/go/stocks/v1alpha1"
)

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

	// Update logo URLs
	UpdateLogoURLs(stockCode, logoGCSURL, logoIconGCSURL string) error
	UpdateLogoURLsWithSVG(stockCode, logoGCSURL, logoIconGCSURL, logoSVGGCSURL, logoSourceURL, logoFormat string) error
}

