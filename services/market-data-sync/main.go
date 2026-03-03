package main

import (
	"context"
	"flag"
	"fmt"
	"log"
	"os"
	"os/signal"
	"syscall"
	"time"

	"cloud.google.com/go/storage"
	"github.com/castlemilk/shorted.com.au/services/market-data-sync/api"
	"github.com/castlemilk/shorted.com.au/services/market-data-sync/checkpoint"
	"github.com/castlemilk/shorted.com.au/services/market-data-sync/config"
	"github.com/castlemilk/shorted.com.au/services/market-data-sync/providers"
	"github.com/castlemilk/shorted.com.au/services/market-data-sync/sync"
	shortedotel "github.com/castlemilk/shorted.com.au/services/pkg/otel"
	"github.com/jackc/pgx/v5/pgxpool"
	"go.opentelemetry.io/otel"
	"go.opentelemetry.io/otel/attribute"
	otelmetric "go.opentelemetry.io/otel/metric"
	"go.opentelemetry.io/otel/trace"
	"google.golang.org/api/option"
)

func main() {
	// Parse flags
	cliMode := flag.Bool("cli", false, "Run in CLI mode (full sync and exit)")
	flag.Parse()

	// Initialize OpenTelemetry early so spans/metrics are captured for the full run.
	// The shutdown function flushes all pending spans and metrics before exit —
	// critical for serverless/Cloud Run Jobs where the process exits after one run.
	otelShutdown, err := shortedotel.InitProvider(context.Background(), "shorted-market-data-sync")
	if err != nil {
		log.Printf("⚠️ Failed to initialize OTel: %v", err)
	}
	defer func() {
		if otelShutdown != nil {
			shutdownCtx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
			defer cancel()
			if err := otelShutdown(shutdownCtx); err != nil {
				log.Printf("⚠️ OTel shutdown error: %v", err)
			}
		}
	}()

	// 1. Load configuration
	cfg := config.Load()
	if err := cfg.Validate(); err != nil {
		log.Fatalf("❌ Configuration error: %v", err)
	}

	log.Printf("📋 Configuration:")
	log.Printf("   GCS Bucket: %s", cfg.GCSBucketName)
	log.Printf("   Priority Stock Count: %d", cfg.PriorityStockCount)
	log.Printf("   Algolia Sync: %v", cfg.SyncAlgolia)
	log.Printf("   Port: %d", cfg.Port)
	if cfg.HasAlphaVantage() {
		log.Printf("   Alpha Vantage: enabled")
	}

	// Set up context with signal handling
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()

	// Initialize OpenTelemetry (traces + metrics via OTLP).
	// No-op when OTEL_EXPORTER_OTLP_ENDPOINT is not set.
	otelShutdown, otelErr := initOTEL(ctx, "market-data-sync")
	if otelErr != nil {
		log.Printf("WARNING: Failed to initialize OpenTelemetry: %v", otelErr)
	} else {
		defer func() {
			shutdownCtx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
			defer cancel()
			if err := otelShutdown(shutdownCtx); err != nil {
				log.Printf("Error shutting down OpenTelemetry: %v", err)
			}
		}()
	}

	// 2. In API mode, start HTTP server immediately so health probes pass
	//    while we initialize heavy dependencies (DB, GCS, providers).
	if !*cliMode {
		server := api.NewServer(cfg.Port)
		if err := server.Start(); err != nil {
			log.Fatalf("❌ Failed to start HTTP server: %v", err)
		}

		// Initialize dependencies with retry — never crash the process so
		// the health endpoint stays alive for Cloud Run startup probes.
		var pool *pgxpool.Pool
		var gcsClient *storage.Client
		var dataProviders []providers.DataProvider
		var err error

		maxRetries := 10
		for attempt := 1; attempt <= maxRetries; attempt++ {
			pool, gcsClient, dataProviders, err = initDependencies(ctx, cfg)
			if err == nil {
				break
			}
			if ctx.Err() != nil {
				log.Fatalf("❌ Context cancelled during dependency init: %v", err)
			}
			backoff := time.Duration(attempt) * 2 * time.Second
			if backoff > 30*time.Second {
				backoff = 30 * time.Second
			}
			log.Printf("⚠️ Dependency init failed (attempt %d/%d): %v — retrying in %s", attempt, maxRetries, err, backoff)
			time.Sleep(backoff)
		}
		if err != nil {
			log.Fatalf("❌ Failed to initialize dependencies after %d attempts: %v", maxRetries, err)
		}

		defer pool.Close()
		if gcsClient != nil {
			defer gcsClient.Close()
		}

		syncManager := sync.NewSyncManager(pool, gcsClient, cfg, dataProviders)
		checkpointStore := checkpoint.NewStore(pool)

		// Mark server as ready — API endpoints now accept requests
		server.SetDependencies(syncManager, checkpointStore, pool, dataProviders)

		if err := server.AwaitShutdown(ctx); err != nil {
			log.Fatalf("❌ Server shutdown error: %v", err)
		}
		return
	}

	// CLI mode — synchronous initialization and run
	pool, gcsClient, dataProviders, err := initDependencies(ctx, cfg)
	if err != nil {
		log.Fatalf("❌ Failed to initialize dependencies: %v", err)
	}
	defer pool.Close()
	if gcsClient != nil {
		defer gcsClient.Close()
	}

	syncManager := sync.NewSyncManager(pool, gcsClient, cfg, dataProviders)
	log.Printf("🚀 Starting Market Data Sync (CLI mode)")

	// Wrap the sync run in an OTel span and record metrics
	tracer := otel.Tracer("shorted.sync")
	syncCtx, span := tracer.Start(ctx, "sync.run",
		trace.WithSpanKind(trace.SpanKindInternal),
		trace.WithAttributes(
			attribute.String("sync.type", "market-data-sync"),
		),
	)

	start := time.Now()
	syncErr := syncManager.Run(syncCtx)
	duration := time.Since(start).Seconds()
	span.End()

	// Record sync metrics
	attrs := otelmetric.WithAttributes(attribute.String("sync_job", "market-data-sync"))
	shortedotel.SyncDuration.Record(ctx, duration, attrs)
	if syncErr != nil {
		shortedotel.SyncStatus.Add(ctx, 1, otelmetric.WithAttributes(
			attribute.String("sync_job", "market-data-sync"),
			attribute.String("status", "failure"),
		))
		if ctx.Err() != nil {
			log.Printf("⏹️ Sync interrupted: %v", syncErr)
			os.Exit(130) // Standard exit code for SIGINT
		}
		log.Fatalf("❌ Sync failed: %v", syncErr)
	}

	shortedotel.SyncStatus.Add(ctx, 1, otelmetric.WithAttributes(
		attribute.String("sync_job", "market-data-sync"),
		attribute.String("status", "success"),
	))
	shortedotel.SyncLastSuccess.Record(ctx, time.Now().Unix(), otelmetric.WithAttributes(
		attribute.String("sync_job", "market-data-sync"),
	))

	log.Printf("🎉 Market Data Sync completed successfully")
}

// initDependencies initializes the database pool, GCS client, and data providers.
// Returns an error instead of calling log.Fatalf so callers can retry.
func initDependencies(ctx context.Context, cfg *config.Config) (*pgxpool.Pool, *storage.Client, []providers.DataProvider, error) {
	// Use a timeout so we don't hang forever on network issues
	initCtx, cancel := context.WithTimeout(ctx, 30*time.Second)
	defer cancel()

	// Database
	pool, err := pgxpool.New(initCtx, cfg.DatabaseURL)
	if err != nil {
		return nil, nil, nil, fmt.Errorf("connect to DB: %w", err)
	}
	if err := pool.Ping(initCtx); err != nil {
		pool.Close()
		return nil, nil, nil, fmt.Errorf("ping DB: %w", err)
	}
	log.Printf("✅ Connected to database")

	// GCS (optional if LOCAL_ASX_CSV is set)
	var gcsClient *storage.Client
	if os.Getenv("LOCAL_ASX_CSV") == "" {
		var gcsOpts []option.ClientOption
		if creds := os.Getenv("GOOGLE_APPLICATION_CREDENTIALS"); creds != "" {
			gcsOpts = append(gcsOpts, option.WithCredentialsFile(creds))
		}
		gcsClient, err = storage.NewClient(initCtx, gcsOpts...)
		if err != nil {
			pool.Close()
			return nil, nil, nil, fmt.Errorf("create GCS client: %w", err)
		}
		log.Printf("✅ Connected to GCS")
	} else {
		log.Printf("ℹ️ Using local ASX CSV file, skipping GCS initialization")
	}

	// Data providers: Yahoo Finance Direct first, Alpha Vantage as fallback
	var dataProviders []providers.DataProvider
	dataProviders = append(dataProviders, providers.NewYahooFinanceDirectProvider())
	log.Printf("✅ Yahoo Finance Direct provider initialized")
	if cfg.HasAlphaVantage() {
		dataProviders = append(dataProviders, providers.NewAlphaVantageProvider(cfg.AlphaVantageAPIKey))
		log.Printf("✅ Alpha Vantage provider initialized (fallback)")
	}

	return pool, gcsClient, dataProviders, nil
}
