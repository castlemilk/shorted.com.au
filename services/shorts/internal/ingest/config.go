// Package ingest is the shorts side of the fleet-managed housing crawl: the
// CrawlIngestService that receives raw listing sweeps from rigs and applies them
// through services/pkg/housingcrawl.
//
// It is mounted only when HOUSING_INGEST_ENABLED is true, and it has its own
// interceptor chain: workload-identity auth, a per-rig enable flag and a per-rig
// push rate limit. It does not use the public API's chain (Firebase, user agents,
// user rate limits, CORS). See docs/superpowers/specs/2026-10-27-fleet-managed-
// housing-crawl-design.md, "Ingest API" and "Workload identity".
package ingest

import (
	"fmt"
	"math"
	"strconv"
	"strings"
)

// Environment variables. HOUSING_INGEST_ENABLED defaults to false.
const (
	EnvEnabled                  = "HOUSING_INGEST_ENABLED"
	EnvIssuer                   = "HOUSING_INGEST_ISSUER"
	EnvAudience                 = "HOUSING_INGEST_AUDIENCE"
	EnvOrg                      = "HOUSING_INGEST_ORG"
	EnvAllowSubjects            = "HOUSING_INGEST_ALLOW_SUBJECTS"
	EnvDenyKIDs                 = "HOUSING_INGEST_DENY_KIDS"
	EnvMinContractVersion       = "HOUSING_INGEST_MIN_CONTRACT_VERSION"
	EnvQuarantinePriceFraction  = "HOUSING_INGEST_QUARANTINE_PRICE_FRACTION"
	EnvQuarantineDelistFraction = "HOUSING_INGEST_QUARANTINE_DELIST_FRACTION"
	EnvQuarantineDelistFloor    = "HOUSING_INGEST_QUARANTINE_DELIST_FLOOR"
)

// Defaults. The issuer and audience are the values BrandBrain signs for and the
// values this service verifies against; they are constants of the contract.
const (
	DefaultIssuer                   = "https://api.brandbrain.dev/workload"
	DefaultAudience                 = "https://api.shorted.com.au/housing-ingest"
	DefaultMinContractVersion int32 = 1
	DefaultPriceFraction            = 0.25
	DefaultDelistFraction           = 0.25
	DefaultDelistFloor              = 20
)

// Config is the ingest service's configuration, read from the environment once at
// startup.
type Config struct {
	// Enabled is HOUSING_INGEST_ENABLED. When false nothing is mounted.
	Enabled bool
	// Issuer, Audience and Org are the exact values the workload verifier checks
	// (iss, aud and the org claim).
	Issuer   string
	Audience string
	Org      string
	// AllowSubjects lists the rig subjects ("rig:<id>") that may authenticate.
	AllowSubjects []string
	// DenyKIDs is an emergency kill list of signing key IDs.
	DenyKIDs []string
	// MinContractVersion is the lowest PushSweepRequest.contract_version accepted.
	MinContractVersion int32
	// PriceFraction is the quarantine's first trip: the fraction of existing
	// listings that moved more than 10% in one sweep.
	PriceFraction float64
	// DelistFraction and DelistFloor form the quarantine's second trip: the sweep
	// would delist more than max(DelistFraction × active listings, DelistFloor).
	DelistFraction float64
	DelistFloor    int
}

// ConfigFromEnv reads the ingest configuration. getenv is os.Getenv in production
// and a map lookup in tests.
//
// A config error never fails the server. Enabled with missing or invalid required
// settings, the service stays mounted and answers every call with Unavailable and
// the reason in the message, and the reason is logged once at startup. That keeps
// the public API up, and it is still fail-closed: nothing is accepted. A rig then
// sees a retryable outage, which is the operational signal it should produce.
//
// The second return is the reason the config is unusable, or "" when it is usable.
func ConfigFromEnv(getenv func(string) string) (Config, string) {
	cfg := Config{
		Issuer:             orDefault(strings.TrimSpace(getenv(EnvIssuer)), DefaultIssuer),
		Audience:           orDefault(strings.TrimSpace(getenv(EnvAudience)), DefaultAudience),
		Org:                strings.TrimSpace(getenv(EnvOrg)),
		AllowSubjects:      splitList(getenv(EnvAllowSubjects)),
		DenyKIDs:           splitList(getenv(EnvDenyKIDs)),
		MinContractVersion: DefaultMinContractVersion,
		PriceFraction:      DefaultPriceFraction,
		DelistFraction:     DefaultDelistFraction,
		DelistFloor:        DefaultDelistFloor,
	}
	enabled, err := parseBool(getenv(EnvEnabled))
	if err != nil {
		return cfg, fmt.Sprintf("%s: %v", EnvEnabled, err)
	}
	cfg.Enabled = enabled
	if !enabled {
		return cfg, ""
	}

	var problems []string
	if raw := strings.TrimSpace(getenv(EnvMinContractVersion)); raw != "" {
		v, err := strconv.ParseInt(raw, 10, 32)
		if err != nil || v < 1 {
			problems = append(problems, EnvMinContractVersion+" must be an integer >= 1")
		} else {
			cfg.MinContractVersion = int32(v)
		}
	}
	if raw := strings.TrimSpace(getenv(EnvQuarantinePriceFraction)); raw != "" {
		if f, ok := parseFraction(raw); ok {
			cfg.PriceFraction = f
		} else {
			problems = append(problems, EnvQuarantinePriceFraction+" must be in (0, 1]")
		}
	}
	if raw := strings.TrimSpace(getenv(EnvQuarantineDelistFraction)); raw != "" {
		if f, ok := parseFraction(raw); ok {
			cfg.DelistFraction = f
		} else {
			problems = append(problems, EnvQuarantineDelistFraction+" must be in (0, 1]")
		}
	}
	if raw := strings.TrimSpace(getenv(EnvQuarantineDelistFloor)); raw != "" {
		v, err := strconv.Atoi(raw)
		if err != nil || v < 0 {
			problems = append(problems, EnvQuarantineDelistFloor+" must be an integer >= 0")
		} else {
			cfg.DelistFloor = v
		}
	}
	if cfg.Org == "" {
		problems = append(problems, EnvOrg+" is required")
	}
	if len(cfg.AllowSubjects) == 0 {
		problems = append(problems, EnvAllowSubjects+" must list at least one rig subject")
	}
	if len(problems) > 0 {
		return cfg, strings.Join(problems, "; ")
	}
	return cfg, ""
}

func orDefault(v, def string) string {
	if v == "" {
		return def
	}
	return v
}

// splitList parses a comma-separated env value. Empty entries are kept, so the
// verifier rejects a stray comma instead of silently allowing or denying nothing.
func splitList(raw string) []string {
	raw = strings.TrimSpace(raw)
	if raw == "" {
		return nil
	}
	parts := strings.Split(raw, ",")
	out := make([]string, 0, len(parts))
	for _, p := range parts {
		out = append(out, strings.TrimSpace(p))
	}
	return out
}

func parseBool(raw string) (bool, error) {
	raw = strings.TrimSpace(raw)
	if raw == "" {
		return false, nil
	}
	return strconv.ParseBool(raw)
}

// parseFraction reads a fraction in (0, 1].
func parseFraction(raw string) (float64, bool) {
	f, err := strconv.ParseFloat(raw, 64)
	if err != nil || math.IsNaN(f) || f <= 0 || f > 1 {
		return 0, false
	}
	return f, true
}
