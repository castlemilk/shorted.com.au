package main

import "time"

const (
	// DefaultPollingInterval is how often the local processor polls for new jobs
	DefaultPollingInterval = 10 * time.Second

	// DefaultStuckJobThreshold is how long a job can be in "processing" before it's considered stuck
	DefaultStuckJobThreshold = 5 * time.Minute

	// DefaultHeartbeatInterval is how often the processor logs a heartbeat message
	DefaultHeartbeatInterval = 30 * time.Second

	// DefaultCleanupInterval is how often the processor runs cleanup tasks
	DefaultCleanupInterval = 2 * time.Minute

	// DefaultJobTimeout is the maximum time a single enrichment job is allowed to run
	DefaultJobTimeout = 10 * time.Minute

	// DefaultQualityThreshold is the minimum overall quality score for auto-approval (not yet implemented)
	DefaultQualityThreshold = 0.7

	// GCSCacheControl is the Cache-Control header for uploaded logos
	GCSCacheControl = "public, max-age=86400"

	// MaxLogoSizeBytes is the maximum allowed size for a logo image (10MB)
	MaxLogoSizeBytes = 10 * 1024 * 1024
)

