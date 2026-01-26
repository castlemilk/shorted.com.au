package config

import "errors"

var (
	// ErrMissingDatabaseURL is returned when DATABASE_URL is not set
	ErrMissingDatabaseURL = errors.New("DATABASE_URL environment variable is required")
)
