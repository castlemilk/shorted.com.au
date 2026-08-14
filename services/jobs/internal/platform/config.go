// Package platform holds the primitives every job needs — a pgx pool, the web
// revalidation ping, env config — extracted from the ~12 hand-rolled copies in
// services/*. See docs/jobs-consolidation-plan.md.
package platform

import (
	"fmt"
	"os"
	"strconv"
	"strings"
	"time"
)

// GetEnv returns the env var, or def when unset/blank.
func GetEnv(key, def string) string {
	if v := strings.TrimSpace(os.Getenv(key)); v != "" {
		return v
	}
	return def
}

// RequireEnv returns the env var or an error when unset/blank.
func RequireEnv(key string) (string, error) {
	if v := strings.TrimSpace(os.Getenv(key)); v != "" {
		return v, nil
	}
	return "", fmt.Errorf("%s is required", key)
}

// GetEnvBool parses truthy env values ("1", "true", "yes", "on"); def on unset
// or unparseable.
func GetEnvBool(key string, def bool) bool {
	v := strings.ToLower(strings.TrimSpace(os.Getenv(key)))
	if v == "" {
		return def
	}
	switch v {
	case "1", "true", "yes", "on":
		return true
	case "0", "false", "no", "off":
		return false
	}
	return def
}

// GetEnvInt parses an int env var, falling back to def.
func GetEnvInt(key string, def int) int {
	v := strings.TrimSpace(os.Getenv(key))
	if v == "" {
		return def
	}
	n, err := strconv.Atoi(v)
	if err != nil {
		return def
	}
	return n
}

// GetEnvDuration parses a Go duration env var, falling back to def.
func GetEnvDuration(key string, def time.Duration) time.Duration {
	v := strings.TrimSpace(os.Getenv(key))
	if v == "" {
		return def
	}
	d, err := time.ParseDuration(v)
	if err != nil {
		return def
	}
	return d
}
