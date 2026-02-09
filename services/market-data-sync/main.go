package main

import (
	"context"
	"flag"
	"log"
	"os"
	"os/signal"
	"syscall"

	"cloud.google.com/go/storage"
	"github.com/castlemilk/shorted.com.au/services/market-data-sync/api"
	"github.com/castlemilk/shorted.com.au/services/market-data-sync/checkpoint"
	"github.com/castlemilk/shorted.com.au/services/market-data-sync/config"
	"github.com/castlemilk/shorted.com.au/services/market-data-sync/providers"
	"github.com/castlemilk/shorted.com.au/services/market-data-sync/sync"
	"github.com/jackc/pgx/v5/pgxpool"
	"google.golang.org/api/option"
)

func main() {
	// Parse flags
	cliMode := flag.Bool("cli", false, "Run in CLI mode (full sync and exit)")
	flag.Parse()

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

	// 2. In API mode, start HTTP server immediately so health probes pass
	//    while we initialize heavy dependencies (DB, GCS, providers).
	if !*cliMode {
		server := api.NewServer(cfg.Port)
		if err := server.Start(); err != nil {
			log.Fatalf("❌ Failed to start HTTP server: %v", err)
		}

		// Initialize dependencies (may take time due to DB/GCS connections)
		pool, gcsClient, dataProviders := initDependencies(ctx, cfg)
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
	pool, gcsClient, dataProviders := initDependencies(ctx, cfg)
	defer pool.Close()
	if gcsClient != nil {
		defer gcsClient.Close()
	}

	syncManager := sync.NewSyncManager(pool, gcsClient, cfg, dataProviders)
	log.Printf("🚀 Starting Market Data Sync (CLI mode)")
	if err := syncManager.Run(ctx); err != nil {
		if ctx.Err() != nil {
			log.Printf("⏹️ Sync interrupted: %v", err)
			os.Exit(130) // Standard exit code for SIGINT
		}
		log.Fatalf("❌ Sync failed: %v", err)
	}
	log.Printf("🎉 Market Data Sync completed successfully")
}

// initDependencies initializes the database pool, GCS client, and data providers.
func initDependencies(ctx context.Context, cfg *config.Config) (*pgxpool.Pool, *storage.Client, []providers.DataProvider) {
	// Database
	pool, err := pgxpool.New(ctx, cfg.DatabaseURL)
	if err != nil {
		log.Fatalf("❌ Failed to connect to DB: %v", err)
	}
	if err := pool.Ping(ctx); err != nil {
		log.Fatalf("❌ Failed to ping DB: %v", err)
	}
	log.Printf("✅ Connected to database")

	// GCS (optional if LOCAL_ASX_CSV is set)
	var gcsClient *storage.Client
	if os.Getenv("LOCAL_ASX_CSV") == "" {
		var gcsOpts []option.ClientOption
		if creds := os.Getenv("GOOGLE_APPLICATION_CREDENTIALS"); creds != "" {
			gcsOpts = append(gcsOpts, option.WithCredentialsFile(creds))
		}
		gcsClient, err = storage.NewClient(ctx, gcsOpts...)
		if err != nil {
			log.Fatalf("❌ Failed to create GCS client: %v", err)
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

	return pool, gcsClient, dataProviders
}
