package main

import "time"

const (
	// DefaultJobTimeout is the maximum time a single enrichment job is allowed to run
	DefaultJobTimeout = 10 * time.Minute

	// DefaultQualityThreshold is the minimum overall quality score warning threshold
	DefaultQualityThreshold = 0.7

	// DefaultAutoApproveThreshold is the minimum quality score for automatic approval
	// Enrichments with quality scores above this threshold are automatically approved
	// and applied without manual review. Set to 0 to disable auto-approval.
	DefaultAutoApproveThreshold = 0.8

	// DefaultWritePeopleBelowGate controls §6.5: whether discovered key_people are
	// written to the served company-metadata even when the whole-company quality score
	// is below DefaultAutoApproveThreshold. Yahoo-officer leadership scores ~0.74
	// ("generic finance profile") and would otherwise never be served. The write is
	// additive (only fills rows that currently have no people) so it can't clobber a
	// better prior result. Override with env WRITE_PEOPLE_BELOW_GATE.
	DefaultWritePeopleBelowGate = true

	// DefaultMinPeopleWriteScore is a floor on the overall quality score below which
	// even the people-only write is suppressed (0 = always write any non-placeholder
	// people). Override with env MIN_PEOPLE_WRITE_SCORE.
	DefaultMinPeopleWriteScore = 0.0

	// GCSCacheControl is the Cache-Control header for uploaded logos
	GCSCacheControl = "public, max-age=86400"

	// MaxLogoSizeBytes is the maximum allowed size for a logo image (10MB)
	MaxLogoSizeBytes = 10 * 1024 * 1024
)

