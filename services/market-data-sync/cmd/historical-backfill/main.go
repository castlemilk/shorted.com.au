package main

import (
	"context"
	"flag"
	"log"
	"os"
	"time"

	"cloud.google.com/go/storage"
	"github.com/castlemilk/shorted.com.au/services/market-data-sync/checkpoint"
	"github.com/castlemilk/shorted.com.au/services/market-data-sync/config"
	"github.com/castlemilk/shorted.com.au/services/market-data-sync/providers"
	"github.com/castlemilk/shorted.com.au/services/market-data-sync/stocklist"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"
	"google.golang.org/api/option"
)

func main() {
	var (
		years        = flag.Int("years", 10, "Number of years of historical data to fetch")
		limit        = flag.Int("limit", 0, "Limit number of stocks to process (0 = all)")
		priorityOnly = flag.Bool("priority-only", false, "Only sync priority (top shorted) stocks")
		skipExisting = flag.Bool("skip-existing", true, "Skip stocks that already have sufficient data and no gaps")
		freshStart   = flag.Bool("fresh", true, "Ignore incomplete runs and start fresh (still checks existing data)")
		resumeRun    = flag.Bool("resume", false, "Resume from incomplete checkpoint instead of starting fresh")
	)
	flag.Parse()
	
	// -resume overrides -fresh
	if *resumeRun {
		*freshStart = false
	}

	ctx := context.Background()

	// Load configuration
	cfg := config.Load()
	if err := cfg.Validate(); err != nil {
		log.Fatalf("❌ Configuration error: %v", err)
	}

	// Connect to database
	pool, err := pgxpool.New(ctx, cfg.DatabaseURL)
	if err != nil {
		log.Fatalf("❌ Failed to connect to database: %v", err)
	}
	defer pool.Close()
	log.Printf("✅ Connected to database")

	// Connect to GCS (optional - can use local CSV)
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
		defer gcsClient.Close()
		log.Printf("✅ Connected to GCS")
	} else {
		log.Printf("ℹ️ Using local ASX CSV file, skipping GCS initialization")
	}

	// Initialize data providers
	var dataProviders []providers.DataProvider
	dataProviders = append(dataProviders, providers.NewYahooFinanceDirectProvider())
	log.Printf("✅ Yahoo Finance Direct provider initialized")
	if cfg.HasAlphaVantage() {
		dataProviders = append(dataProviders, providers.NewAlphaVantageProvider(cfg.AlphaVantageAPIKey))
		log.Printf("✅ Alpha Vantage provider initialized (fallback)")
	}

	// Create stocklist service to get stock codes
	stocklistService := stocklist.New(pool, gcsClient)

	// Get stock list
	var allStocks []stocklist.Stock
	if os.Getenv("LOCAL_ASX_CSV") != "" {
		log.Printf("📋 Fetching stock list from local CSV file...")
	} else {
		log.Printf("📋 Fetching stock list from GCS...")
	}
	
	allStocks, stockListErr := stocklistService.GetPrioritizedStocks(ctx, cfg.GCSBucketName, cfg.PriorityStockCount)
	if stockListErr != nil {
		log.Printf("⚠️ Failed to get stock list from GCS/local CSV: %v", stockListErr)
		log.Printf("💡 Tip: Set LOCAL_ASX_CSV environment variable to use a local CSV file")
		log.Printf("💡 Example: export LOCAL_ASX_CSV=../../analysis/data/ASX_Listed_Companies_07-04-2024_11-03-45_AEST.csv")
		log.Printf("💡 Falling back to database...")
		
		// Fallback: Get stocks from database
		log.Printf("📋 Fetching stock codes from database...")
		rows, dbErr := pool.Query(ctx, `SELECT DISTINCT stock_code FROM stock_prices ORDER BY stock_code`)
		if dbErr != nil {
			log.Fatalf("❌ Failed to get stocks from database: %v", dbErr)
		}
		defer rows.Close()
		
		var dbStocks []string
		for rows.Next() {
			var code string
			if scanErr := rows.Scan(&code); scanErr != nil {
				log.Printf("⚠️ Warning: error scanning stock code: %v", scanErr)
				continue
			}
			dbStocks = append(dbStocks, code)
		}
		if rowsErr := rows.Err(); rowsErr != nil {
			log.Fatalf("❌ Error reading stock codes: %v", rowsErr)
		}
		
		if len(dbStocks) == 0 {
			log.Fatalf("❌ No stocks found in database. Please provide stock list via:")
			log.Fatalf("   1. Set LOCAL_ASX_CSV environment variable")
			log.Fatalf("   2. Ensure GCS bucket has asx-stocks/latest.csv")
			log.Fatalf("   3. Or populate database with some stocks first")
		}
		
		log.Printf("✅ Found %d stocks in database (using as fallback)", len(dbStocks))
		// Convert to Stock format
		allStocks = make([]stocklist.Stock, len(dbStocks))
		for i, code := range dbStocks {
			allStocks[i] = stocklist.Stock{Code: code, IsPriority: false}
		}
	} else {
		source := "GCS"
		if os.Getenv("LOCAL_ASX_CSV") != "" {
			source = "local CSV"
		}
		log.Printf("✅ Fetched %d stocks from %s", len(allStocks), source)
	}

	// Extract stock codes
	stocks := make([]string, 0, len(allStocks))
	for _, stock := range allStocks {
		if *priorityOnly && !stock.IsPriority {
			continue
		}
		stocks = append(stocks, stock.Code)
	}

	if *limit > 0 && *limit < len(stocks) {
		stocks = stocks[:*limit]
		log.Printf("📊 Limited to %d stocks", len(stocks))
	}

	log.Printf("🚀 Starting historical backfill for %d stocks (%d years)", len(stocks), *years)

	// Initialize checkpoint system
	checkpointStore := checkpoint.NewStore(pool)
	
	// Check for incomplete run to resume from
	var runID string
	var processedStocks map[string]bool
	var resumeFrom int
	var successful, failed int
	
	incompleteRun, err := checkpointStore.GetIncompleteRun(ctx)
	if err == nil && incompleteRun != nil && !*freshStart {
		log.Printf("🔄 Found incomplete run: %s (processed %d/%d stocks)", incompleteRun.RunID, incompleteRun.StocksProcessed, incompleteRun.StocksTotal)
		log.Printf("📋 Resuming from checkpoint (use -fresh to ignore checkpoints)")
		runID = incompleteRun.RunID
		resumeFrom = incompleteRun.StocksProcessed
		successful = incompleteRun.StocksSuccessful
		failed = incompleteRun.StocksFailed
		
		// Mark stocks as processed up to the resume point
		// This assumes the stock list order is stable between runs
		processedStocks = make(map[string]bool)
		if resumeFrom > 0 && resumeFrom <= len(stocks) {
			for j := 0; j < resumeFrom; j++ {
				processedStocks[stocks[j]] = true
			}
			log.Printf("✅ Skipping first %d stocks (already processed in checkpoint)", resumeFrom)
		}
	} else {
		// Create new run (either no incomplete run, or fresh start requested)
		if *freshStart && incompleteRun != nil {
			log.Printf("🔄 Found incomplete run %s but -fresh flag set, ignoring checkpoint", incompleteRun.RunID)
			// Mark incomplete run as failed so it doesn't keep getting picked up
			if markErr := checkpointStore.FailRun(ctx, incompleteRun.RunID, "Superseded by fresh run"); markErr != nil {
				log.Printf("⚠️ Failed to mark old run as failed: %v", markErr)
			}
		}
		runID = uuid.New().String()
		log.Printf("🆕 Creating new checkpoint run: %s", runID)
		if err := checkpointStore.StartRun(ctx, runID, len(stocks), 0); err != nil {
			log.Printf("⚠️ Failed to create checkpoint: %v (continuing anyway)", err)
		}
		processedStocks = make(map[string]bool)
		resumeFrom = 0
		successful = 0
		failed = 0
	}

	// Calculate date range
	endDate := time.Now()
	startDate := endDate.AddDate(-*years, 0, 0)

	// Get total records from checkpoint if resuming
	var totalRecords int
	if incompleteRun != nil {
		runDetails, err := checkpointStore.GetRun(ctx, runID)
		if err == nil && runDetails != nil {
			totalRecords = runDetails.PricesRecordsUpdated
			log.Printf("📊 Resuming with %d total records from previous run", totalRecords)
		}
	}

	for i, symbol := range stocks {
		select {
		case <-ctx.Done():
			log.Printf("⏹️ Backfill interrupted at %d/%d", i, len(stocks))
			// Update checkpoint before exiting
			if err := checkpointStore.UpdateProgress(ctx, runID, i, successful, failed, 0); err != nil {
				log.Printf("⚠️ Failed to update checkpoint: %v", err)
			}
			return
		default:
		}

		// Skip stocks already processed in this run (from checkpoint)
		if processedStocks[symbol] {
			log.Printf("⏭️ [%d/%d] Skipping %s - already processed in this run", i+1, len(stocks), symbol)
			continue
		}

		// Check if we should skip existing stocks based on actual data in DB
		if *skipExisting {
			var earliestDate, latestDate time.Time
			var recordCount int
			err := pool.QueryRow(ctx, `
				SELECT MIN(date), MAX(date), COUNT(*) 
				FROM stock_prices 
				WHERE stock_code = $1
			`, symbol).Scan(&earliestDate, &latestDate, &recordCount)
			
			if err == nil && recordCount > 0 && !earliestDate.IsZero() && !latestDate.IsZero() {
				// Calculate the span of historical data we have
				dataSpanDays := int(latestDate.Sub(earliestDate).Hours() / 24)
				requiredDays := *years * 365
				
				// Check for gaps in the data using window function
				var gapCount int
				gapErr := pool.QueryRow(ctx, `
					WITH date_series AS (
						SELECT date, LAG(date) OVER (ORDER BY date) as prev_date
						FROM stock_prices WHERE stock_code = $1
					)
					SELECT COUNT(*) FROM date_series 
					WHERE prev_date IS NOT NULL AND (date - prev_date) > 4
				`, symbol).Scan(&gapCount)
				
				hasGaps := gapErr == nil && gapCount > 0
				
				// If we have enough historical data span AND no significant gaps, skip
				if dataSpanDays >= requiredDays && !hasGaps {
					log.Printf("⏭️ [%d/%d] Skipping %s - has %d records spanning %d days (need %d), no gaps", 
						i+1, len(stocks), symbol, recordCount, dataSpanDays, requiredDays)
					successful++ // Count as successful since data exists
					continue
				}
				
				// Log why we're processing this stock
				if dataSpanDays < requiredDays {
					log.Printf("📊 [%d/%d] %s needs more data: has %d days, need %d", i+1, len(stocks), symbol, dataSpanDays, requiredDays)
				}
				if hasGaps {
					log.Printf("🔍 [%d/%d] %s has %d gap(s) to repair", i+1, len(stocks), symbol, gapCount)
				}
			}
		}

		log.Printf("📥 [%d/%d] Fetching historical data for %s (%s to %s)...", i+1, len(stocks), symbol, startDate.Format("2006-01-02"), endDate.Format("2006-01-02"))

		// Try providers in order
		var records []providers.PriceRecord
		var syncErr error
		for _, p := range dataProviders {
			// Rate limiting
			select {
			case <-ctx.Done():
				log.Printf("⏹️ Interrupted")
				return
			case <-time.After(p.GetRateLimit()):
			}

			records, syncErr = p.FetchHistoricalData(ctx, symbol, startDate, endDate)
			if syncErr == nil && len(records) > 0 {
				log.Printf("✅ %s: Fetched %d records from %s", symbol, len(records), p.Name())
				break
			}
			if syncErr != nil {
				log.Printf("⚠️ %s: Provider %s failed: %v", symbol, p.Name(), syncErr)
			}
		}

		if len(records) == 0 {
			log.Printf("❌ [%d/%d] Failed to fetch data for %s", i+1, len(stocks), symbol)
			failed++
			// Update checkpoint on failure
			if err := checkpointStore.UpdateProgress(ctx, runID, i+1, successful, failed, 0); err != nil {
				log.Printf("⚠️ Failed to update checkpoint: %v", err)
			}
			continue
		}

		// Insert records into database using sync manager's upsert method
		// We'll need to access the private method, so let's create a helper
		inserted := 0
		for _, record := range records {
			_, err := pool.Exec(ctx, `
				INSERT INTO stock_prices (stock_code, date, open, high, low, close, adjusted_close, volume)
				VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
				ON CONFLICT (stock_code, date) DO UPDATE SET
					open = EXCLUDED.open,
					high = EXCLUDED.high,
					low = EXCLUDED.low,
					close = EXCLUDED.close,
					adjusted_close = EXCLUDED.adjusted_close,
					volume = EXCLUDED.volume,
					updated_at = CURRENT_TIMESTAMP
			`, record.StockCode, record.Date, record.Open, record.High, record.Low, record.Close, record.AdjustedClose, record.Volume)
			if err != nil {
				log.Printf("⚠️ Failed to insert record for %s on %s: %v", symbol, record.Date.Format("2006-01-02"), err)
				continue
			}
			inserted++
		}

		successful++
		totalRecords += inserted
		processedStocks[symbol] = true // Mark as processed
		log.Printf("✅ [%d/%d] %s: Inserted %d records (total: %d)", i+1, len(stocks), symbol, inserted, totalRecords)

		// Update checkpoint after each successful stock
		if err := checkpointStore.UpdateProgress(ctx, runID, i+1, successful, failed, 0); err != nil {
			log.Printf("⚠️ Failed to update checkpoint: %v", err)
		}
		if err := checkpointStore.UpdatePricesCount(ctx, runID, totalRecords); err != nil {
			log.Printf("⚠️ Failed to update prices count: %v", err)
		}

		// Progress update every 10 stocks
		if (i+1)%10 == 0 {
			log.Printf("📊 Progress: %d/%d stocks, %d successful, %d failed, %d total records", i+1, len(stocks), successful, failed, totalRecords)
		}
	}

	// Mark run as complete
	if err := checkpointStore.CompleteRun(ctx, runID); err != nil {
		log.Printf("⚠️ Failed to mark run as complete: %v", err)
	}

	log.Printf("🎉 Historical backfill complete!")
	log.Printf("   Run ID: %s", runID)
	log.Printf("   Stocks processed: %d", len(stocks))
	log.Printf("   Successful: %d", successful)
	log.Printf("   Failed: %d", failed)
	log.Printf("   Total records: %d", totalRecords)
}
