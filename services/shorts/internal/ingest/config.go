// Package ingest is the shorts side of the fleet-managed housing crawl: the
// CrawlIngestService that receives raw listing sweeps from rigs and applies them
// through services/pkg/housingcrawl.
//
// It runs in one of two places:
//
//   - the dedicated ingest service: SHORTS_SERVE_MODE=ingest. Mounts only
//     CrawlIngestService and health, on its own small database pool. This is the
//     production shape: S-SRV deploys it as a separate Cloud Run service from the
//     same image, so the public API's pool and routes are not shared with rigs.
//   - in-process, inside the public API, behind HOUSING_INGEST_ENABLED. This is a
//     development convenience. The public API logs a warning when it is on.
//
// Either way it has its own interceptor chain: workload-identity auth, a per-rig
// enable flag and a per-rig rate limit. It does not use the public API's chain
// (Firebase, user agents, user rate limits, CORS). See docs/superpowers/specs/
// 2026-10-27-fleet-managed-housing-crawl-design.md, "Ingest API" and "Workload
// identity".
package ingest

import (
	"fmt"
	"math"
	"strconv"
	"strings"
	"time"
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
	EnvQuarantineMinMoves       = "HOUSING_INGEST_QUARANTINE_MIN_MOVES"
	EnvQuarantineDelistFraction = "HOUSING_INGEST_QUARANTINE_DELIST_FRACTION"
	EnvQuarantineDelistCap      = "HOUSING_INGEST_QUARANTINE_DELIST_CAP"
	EnvQuarantineMinDelists     = "HOUSING_INGEST_QUARANTINE_MIN_DELISTS"
	EnvDispatchTTL              = "HOUSING_INGEST_DISPATCH_TTL"
	EnvDBMaxConns               = "HOUSING_INGEST_DB_MAX_CONNS"
	// EnvDatabaseURL is the ingest's own database. It falls back to DATABASE_URL.
	EnvDatabaseURL      = "HOUSING_INGEST_DATABASE_URL"
	EnvDatabaseFallback = "DATABASE_URL"
	// EnvServeMode selects the dedicated ingest service ("ingest"). Anything else,
	// or unset, is the public API.
	EnvServeMode    = "SHORTS_SERVE_MODE"
	ServeModeIngest = "ingest"
)

// Defaults. The issuer and audience are the values BrandBrain signs for and the
// values this service verifies against; they are constants of the contract.
const (
	DefaultIssuer                   = "https://api.brandbrain.dev/workload"
	DefaultAudience                 = "https://api.shorted.com.au/housing-ingest"
	DefaultMinContractVersion int32 = 1
	DefaultPriceFraction            = 0.25
	DefaultQuarantineMinMoves       = 3
	DefaultDelistFraction           = 0.25
	DefaultDelistCap                = 20
	DefaultMinDelists               = 3
	DefaultDispatchTTL              = 72 * time.Hour
	DefaultDBMaxConns               = 4
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
	// PriceFraction and QuarantineMinMoves are the quarantine's first trip: more
	// than max(PriceFraction × existing listings, QuarantineMinMoves) of the
	// existing listings moved more than 10% in one sweep.
	PriceFraction      float64
	QuarantineMinMoves int
	// The second trip: a sweep that would delist more than
	//   max(MinDelists, min(DelistFraction × active listings, DelistCap))
	// is held. The minimum protects a small suburb from two empty COMPLETE pushes
	// withdrawing it, and the cap stops a large suburb from ever needing more than
	// DelistCap delists to trip.
	DelistFraction float64
	DelistCap      int
	MinDelists     int
	// DispatchTTL is how long a dispatch row stays open. S-SRV's enqueue writes
	// crawl_dispatch.expires_at = created + DispatchTTL. The ingest reads it back
	// only through expires_at, so a job past its expiry is refused.
	DispatchTTL time.Duration
	// DBMaxConns caps the ingest's own pool.
	DBMaxConns int32
}

// ConfigFromEnv reads the ingest configuration. getenv is os.Getenv in production
// and a map lookup in tests.
//
// A config error never fails the server. Enabled with missing or invalid required
// settings, the service stays mounted and answers every call with Unavailable, and
// the reason is logged once at startup. That keeps the public API up, and it is
// still fail-closed: nothing is accepted. A rig then sees a retryable outage.
//
// The second return is the reason the config is unusable, or "" when it is usable.
// An unparseable HOUSING_INGEST_ENABLED is reported and the service is not mounted.
func ConfigFromEnv(getenv func(string) string) (Config, string) {
	cfg := Config{
		Issuer:             orDefault(strings.TrimSpace(getenv(EnvIssuer)), DefaultIssuer),
		Audience:           orDefault(strings.TrimSpace(getenv(EnvAudience)), DefaultAudience),
		Org:                strings.TrimSpace(getenv(EnvOrg)),
		AllowSubjects:      splitList(getenv(EnvAllowSubjects)),
		DenyKIDs:           splitList(getenv(EnvDenyKIDs)),
		MinContractVersion: DefaultMinContractVersion,
		PriceFraction:      DefaultPriceFraction,
		QuarantineMinMoves: DefaultQuarantineMinMoves,
		DelistFraction:     DefaultDelistFraction,
		DelistCap:          DefaultDelistCap,
		MinDelists:         DefaultMinDelists,
		DispatchTTL:        DefaultDispatchTTL,
		DBMaxConns:         DefaultDBMaxConns,
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
	if raw := strings.TrimSpace(getenv(EnvQuarantineMinMoves)); raw != "" {
		v, err := strconv.Atoi(raw)
		if err != nil || v < 0 {
			problems = append(problems, EnvQuarantineMinMoves+" must be an integer >= 0")
		} else {
			cfg.QuarantineMinMoves = v
		}
	}
	if raw := strings.TrimSpace(getenv(EnvQuarantineDelistFraction)); raw != "" {
		if f, ok := parseFraction(raw); ok {
			cfg.DelistFraction = f
		} else {
			problems = append(problems, EnvQuarantineDelistFraction+" must be in (0, 1]")
		}
	}
	if raw := strings.TrimSpace(getenv(EnvQuarantineMinDelists)); raw != "" {
		v, err := strconv.Atoi(raw)
		if err != nil || v < 0 {
			problems = append(problems, EnvQuarantineMinDelists+" must be an integer >= 0")
		} else {
			cfg.MinDelists = v
		}
	}
	if raw := strings.TrimSpace(getenv(EnvQuarantineDelistCap)); raw != "" {
		v, err := strconv.Atoi(raw)
		if err != nil || v < 0 {
			problems = append(problems, EnvQuarantineDelistCap+" must be an integer >= 0")
		} else {
			cfg.DelistCap = v
		}
	}
	if raw := strings.TrimSpace(getenv(EnvDispatchTTL)); raw != "" {
		d, err := time.ParseDuration(raw)
		if err != nil || d <= 0 {
			problems = append(problems, EnvDispatchTTL+" must be a positive duration, such as 72h")
		} else {
			cfg.DispatchTTL = d
		}
	}
	if raw := strings.TrimSpace(getenv(EnvDBMaxConns)); raw != "" {
		v, err := strconv.Atoi(raw)
		if err != nil || v < 1 || v > 100 {
			problems = append(problems, EnvDBMaxConns+" must be an integer from 1 to 100")
		} else {
			cfg.DBMaxConns = int32(v)
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
