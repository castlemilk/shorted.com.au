// Package marketdata is the `shorted market-data` job group, migrated from
// services/market-data-sync (docs/jobs-consolidation-plan.md Phase 2, step 6).
//
// market-data-sync is the one source service that is a Cloud Run SERVICE rather
// than a Job: a weekday scheduler POSTs its HTTP endpoints. That surface is
// preserved verbatim as `serve`, so the scheduler keeps working across the
// cutover; the standalone binary's `-cli` one-shot path becomes `sync`; and the
// two real side CLIs under cmd/ become subcommands of their own:
//
//	shorted market-data serve               HTTP surface (/api/sync/*, /api/gaps/*, /healthz, /readyz)
//	shorted market-data sync                one-shot full prioritised sync, then exit (was -cli)
//	shorted market-data audit-gaps          read-only gap audit across every stock (was cmd/audit-gaps)
//	shorted market-data historical-backfill multi-year backfill / gap repair (was cmd/historical-backfill)
//
// Environment is unchanged from the standalone service — DATABASE_URL,
// GCS_BUCKET_NAME, PRIORITY_STOCK_COUNT, DB_MAX_CONNS/DB_MIN_CONNS,
// ALPHA_VANTAGE_API_KEY, ALGOLIA_*, SYNC_ALGOLIA, PORT, LOCAL_ASX_CSV,
// GOOGLE_APPLICATION_CREDENTIALS — see the config subpackage.
package marketdata

import (
	"context"
	"fmt"
	"log"
	"os"
	"time"

	"cloud.google.com/go/storage"
	"github.com/castlemilk/shorted.com.au/services/jobs/internal/jobs/marketdata/config"
	"github.com/castlemilk/shorted.com.au/services/jobs/internal/jobs/marketdata/providers"
	"github.com/castlemilk/shorted.com.au/services/jobs/internal/runner"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"google.golang.org/api/option"
)

// otelServiceName is preserved from the standalone binary ("shorted-market-data-sync")
// so existing traces/dashboards keep resolving. Note the sync_job METRIC
// attribute is the shorter "market-data-sync" — also unchanged; the two
// identities differed in the original and are carried over as-is.
const otelServiceName = "shorted-market-data-sync"

// syncJobAttr is the sync_job metric attribute value from the standalone binary.
const syncJobAttr = "market-data-sync"

// Group returns the `shorted market-data <subcommand>` job group.
func Group() runner.Job {
	return runner.NewGroup(
		"market-data",
		"ASX price sync: HTTP service (serve), one-shot sync, gap audit and historical backfill",
		serveJob(),
		syncJob(),
		auditGapsJob(),
		backfillJob(),
	)
}

// loadConfig loads + validates the service config. Kept as one helper so every
// subcommand fails identically on a missing DATABASE_URL.
func loadConfig() (*config.Config, error) {
	cfg := config.Load()
	if err := cfg.Validate(); err != nil {
		return nil, fmt.Errorf("configuration error: %w", err)
	}
	return cfg, nil
}

// deps are the collaborators the serve and sync paths share.
type deps struct {
	pool      *pgxpool.Pool
	gcs       *storage.Client
	providers []providers.DataProvider
}

// close releases the pool and GCS client. Safe on a partially-built deps.
func (d *deps) close() {
	if d.pool != nil {
		d.pool.Close()
	}
	if d.gcs != nil {
		if err := d.gcs.Close(); err != nil {
			log.Printf("⚠️ closing GCS client: %v", err)
		}
	}
}

// initDependencies opens the database pool, the GCS client and the provider
// chain. It returns an error (never fatals) so the serve path can retry.
func initDependencies(ctx context.Context, cfg *config.Config) (*deps, error) {
	// Use a timeout so we don't hang forever on network issues
	initCtx, cancel := context.WithTimeout(ctx, 30*time.Second)
	defer cancel()

	poolConfig, err := buildDBPoolConfig(cfg)
	if err != nil {
		return nil, fmt.Errorf("parse DB config: %w", err)
	}

	pool, err := pgxpool.NewWithConfig(initCtx, poolConfig)
	if err != nil {
		return nil, fmt.Errorf("connect to DB: %w", err)
	}
	if err := pool.Ping(initCtx); err != nil {
		pool.Close()
		return nil, fmt.Errorf("ping DB: %w", err)
	}
	log.Printf("✅ Connected to database")

	d := &deps{pool: pool}

	// GCS (optional if LOCAL_ASX_CSV is set)
	if os.Getenv("LOCAL_ASX_CSV") == "" {
		gcsClient, err := newGCSClient(initCtx)
		if err != nil {
			pool.Close()
			return nil, fmt.Errorf("create GCS client: %w", err)
		}
		d.gcs = gcsClient
		log.Printf("✅ Connected to GCS")
	} else {
		log.Printf("ℹ️ Using local ASX CSV file, skipping GCS initialization")
	}

	d.providers = buildProviders(cfg)
	return d, nil
}

// newGCSClient builds a storage client, honouring an explicit
// GOOGLE_APPLICATION_CREDENTIALS path when one is set (ADC otherwise).
func newGCSClient(ctx context.Context) (*storage.Client, error) {
	var opts []option.ClientOption
	if creds := os.Getenv("GOOGLE_APPLICATION_CREDENTIALS"); creds != "" {
		//nolint:staticcheck // TODO: migrate GOOGLE_APPLICATION_CREDENTIALS to Workload Identity
		// Federation. Every service in this repo still keys off the file path.
		opts = append(opts, option.WithCredentialsFile(creds))
	}
	return storage.NewClient(ctx, opts...)
}

// buildProviders returns the provider chain: Yahoo Finance Direct first, Alpha
// Vantage as a fallback when a key is configured.
func buildProviders(cfg *config.Config) []providers.DataProvider {
	out := []providers.DataProvider{providers.NewYahooFinanceDirectProvider()}
	log.Printf("✅ Yahoo Finance Direct provider initialized")
	if cfg.HasAlphaVantage() {
		out = append(out, providers.NewAlphaVantageProvider(cfg.AlphaVantageAPIKey))
		log.Printf("✅ Alpha Vantage provider initialized (fallback)")
	}
	return out
}

// buildDBPoolConfig reproduces the standalone service's pool posture exactly.
//
// This deliberately does NOT go through platform.ConnectFromEnv: that helper
// fixes MaxConns and sets nothing else, whereas market-data runs long
// multi-hour sweeps and needs the connection lifetime/idle/health-check and
// connect-timeout tuning below, plus configurable DB_MAX_CONNS/DB_MIN_CONNS.
// The one thing both share — QueryExecModeSimpleProtocol for the Supabase
// transaction pooler — is preserved here.
func buildDBPoolConfig(cfg *config.Config) (*pgxpool.Config, error) {
	poolConfig, err := pgxpool.ParseConfig(cfg.DatabaseURL)
	if err != nil {
		return nil, err
	}

	maxConns := cfg.DBMaxConns
	if maxConns < 1 {
		maxConns = 3
	}
	minConns := cfg.DBMinConns
	if minConns < 0 {
		minConns = 0
	}
	if minConns > maxConns {
		minConns = maxConns
	}

	poolConfig.MaxConns = int32(maxConns)
	poolConfig.MinConns = int32(minConns)
	poolConfig.MaxConnLifetime = 30 * time.Minute
	poolConfig.MaxConnIdleTime = 5 * time.Minute
	poolConfig.HealthCheckPeriod = time.Minute
	poolConfig.ConnConfig.ConnectTimeout = 10 * time.Second
	poolConfig.ConnConfig.DefaultQueryExecMode = pgx.QueryExecModeSimpleProtocol

	return poolConfig, nil
}

// logConfig prints the startup configuration banner the standalone binary
// emitted before every run.
func logConfig(cfg *config.Config) {
	log.Printf("📋 Configuration:")
	log.Printf("   GCS Bucket: %s", cfg.GCSBucketName)
	log.Printf("   Priority Stock Count: %d", cfg.PriorityStockCount)
	log.Printf("   Algolia Sync: %v", cfg.SyncAlgolia)
	log.Printf("   Port: %d", cfg.Port)
	if cfg.HasAlphaVantage() {
		log.Printf("   Alpha Vantage: enabled")
	}
}
