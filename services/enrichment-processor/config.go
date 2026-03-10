package main

import "time"

const (
	// DefaultStuckJobThreshold is how long a job can be in "processing" before it's considered stuck
	DefaultStuckJobThreshold = 5 * time.Minute

	// DefaultJobTimeout is the maximum time a single enrichment job is allowed to run
	DefaultJobTimeout = 10 * time.Minute

	// DefaultQualityThreshold is the minimum overall quality score warning threshold
	DefaultQualityThreshold = 0.7

	// DefaultAutoApproveThreshold is the minimum quality score for automatic approval
	// Enrichments with quality scores above this threshold are automatically approved
	// and applied without manual review. Set to 0 to disable auto-approval.
	DefaultAutoApproveThreshold = 0.8

	// GCSCacheControl is the Cache-Control header for uploaded logos
	GCSCacheControl = "public, max-age=86400"

	// MaxLogoSizeBytes is the maximum allowed size for a logo image (10MB)
	MaxLogoSizeBytes = 10 * 1024 * 1024
)

