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

	// 2. Initialize DB pool
	pool, err := pgxpool.New(ctx, cfg.DatabaseURL)
	if err != nil {
		log.Fatalf("❌ Failed to connect to DB: %v", err)
	}
	defer pool.Close()

	if err := pool.Ping(ctx); err != nil {
		log.Fatalf("❌ Failed to ping DB: %v", err)
	}
	log.Printf("✅ Connected to database")

	// 3. Initialize GCS client (optional if LOCAL_ASX_CSV is set)
	var gcsClient *storage.Client
	if os.Getenv("LOCAL_ASX_CSV") == "" {
		// Only initialize GCS if not using local CSV
		var gcsOpts []option.ClientOption
		if creds := os.Getenv("GOOGLE_APPLICATION_CREDENTIALS"); creds != "" {
			gcsOpts = append(gcsOpts, option.WithCredentialsFile(creds))
		}
		var err error
		gcsClient, err = storage.NewClient(ctx, gcsOpts...)
		if err != nil {
			log.Fatalf("❌ Failed to create GCS client: %v", err)
		}
		defer gcsClient.Close()
		log.Printf("✅ Connected to GCS")
	} else {
		log.Printf("ℹ️ Using local ASX CSV file, skipping GCS initialization")
	}

	// 4. Initialize data providers
	// Order: Yahoo Finance first (free, unlimited), then Alpha Vantage as fallback (rate limited)
	var dataProviders []providers.DataProvider
	dataProviders = append(dataProviders, providers.NewYahooFinanceProvider())
	log.Printf("✅ Yahoo Finance provider initialized")
	if cfg.HasAlphaVantage() {
		dataProviders = append(dataProviders, providers.NewAlphaVantageProvider(cfg.AlphaVantageAPIKey))
		log.Printf("✅ Alpha Vantage provider initialized (fallback)")
	}

	// 5. Initialize SyncManager
	// Note: gcsClient can be nil if LOCAL_ASX_CSV is set
	syncManager := sync.NewSyncManager(pool, gcsClient, cfg, dataProviders)
	checkpointStore := checkpoint.NewStore(pool)

	// 6. Run in CLI mode or API server mode
	if *cliMode {
		log.Printf("🚀 Starting Market Data Sync (CLI mode)")
		if err := syncManager.Run(ctx); err != nil {
			if ctx.Err() != nil {
				log.Printf("⏹️ Sync interrupted: %v", err)
				os.Exit(130) // Standard exit code for SIGINT
			}
			log.Fatalf("❌ Sync failed: %v", err)
		}
		log.Printf("🎉 Market Data Sync completed successfully")
	} else {
		// API Server mode
		server := api.NewServer(syncManager, checkpointStore, pool, cfg.Port)
		log.Printf("🌐 Starting Market Data Sync API Server")
		if err := server.Start(ctx); err != nil {
			log.Fatalf("❌ Server failed: %v", err)
		}
	}
}
