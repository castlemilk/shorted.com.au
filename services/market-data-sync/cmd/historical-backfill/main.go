package main

import (
	"context"
	"flag"
	"log"
	"os"
	"strings"
	"time"

	"cloud.google.com/go/storage"
	"github.com/castlemilk/shorted.com.au/services/market-data-sync/checkpoint"
	"github.com/castlemilk/shorted.com.au/services/market-data-sync/config"
	"github.com/castlemilk/shorted.com.au/services/market-data-sync/providers"
	"github.com/castlemilk/shorted.com.au/services/market-data-sync/stocklist"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"google.golang.org/api/option"
)

func main() {
	var (
		years        = flag.Int("years", 10, "Number of years of historical data to fetch")
		limit        = flag.Int("limit", 0, "Limit number of stocks to process (0 = all)")
		priorityOnly = flag.Bool("priority-only", false, "Only sync priority (top shorted) stocks")
		forceRefetch = flag.Bool("force", false, "Force re-fetch even if data exists (ignores database state)")
	)
	flag.Parse()

	ctx := context.Background()

	// Load configuration
	cfg := config.Load()
	if err := cfg.Validate(); err != nil {
		log.Fatalf("❌ Configuration error: %v", err)
	}

	// Check if using Supabase Session mode (port 5432) - warn user
	dbURL := cfg.DatabaseURL
	if strings.Contains(dbURL, "pooler.supabase.com") && strings.Contains(dbURL, ":5432") {
		log.Printf("⚠️  WARNING: Using Supabase Session mode (port 5432)")
		log.Printf("⚠️  This has very limited connections and will cause errors!")
		log.Printf("⚠️  Please use Transaction mode (port 6543) instead:")
		log.Printf("⚠️  Change :5432 to :6543 in your DATABASE_URL")
		log.Printf("")
	}

	// Configure connection pool for Supabase compatibility
	// Supabase Transaction mode has limited connections, so we use a small pool
	poolConfig, err := pgxpool.ParseConfig(dbURL)
	if err != nil {
		log.Fatalf("❌ Failed to parse database URL: %v", err)
	}
	
	// Limit pool size to avoid exhausting Supabase connections
	// Transaction mode typically allows ~15-20 connections
	poolConfig.MaxConns = 3                          // Very conservative for backfill
	poolConfig.MinConns = 1                          // Keep 1 connection ready
	poolConfig.MaxConnLifetime = 30 * time.Minute    // Rotate connections
	poolConfig.MaxConnIdleTime = 5 * time.Minute     // Release idle connections
	poolConfig.HealthCheckPeriod = 1 * time.Minute   // Check connection health
	
	// CRITICAL: Use simple protocol to avoid prepared statement issues with Supabase pooler
	// Transaction mode pooler can switch backend connections, breaking prepared statements
	poolConfig.ConnConfig.DefaultQueryExecMode = pgx.QueryExecModeSimpleProtocol
	
	// Create pool with config
	pool, err := pgxpool.NewWithConfig(ctx, poolConfig)
	if err != nil {
		log.Fatalf("❌ Failed to connect to database: %v", err)
	}
	defer pool.Close()
	
	// Test connection
	if err := pool.Ping(ctx); err != nil {
		log.Fatalf("❌ Failed to ping database: %v", err)
	}
	log.Printf("✅ Connected to database (pool: max=%d, min=%d)", poolConfig.MaxConns, poolConfig.MinConns)

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
	if *forceRefetch {
		log.Printf("⚠️  Force mode: will re-fetch ALL data regardless of existing records")
	} else {
		log.Printf("📋 Smart mode: checking database state for each stock (skip if complete, fetch if gaps/missing)")
	}

	// Initialize checkpoint system (for progress tracking only)
	checkpointStore := checkpoint.NewStore(pool)
	
	// Always create a new run - we use database state, not checkpoints, for skip decisions
	runID := uuid.New().String()
	var successful, failed int
	
	// Mark any incomplete runs as superseded
	if incompleteRun, err := checkpointStore.GetIncompleteRun(ctx); err == nil && incompleteRun != nil {
		log.Printf("📋 Found old incomplete run %s - marking as superseded", incompleteRun.RunID)
		if markErr := checkpointStore.FailRun(ctx, incompleteRun.RunID, "Superseded - using database state"); markErr != nil {
			log.Printf("⚠️ Failed to mark old run: %v", markErr)
		}
	}
	
	log.Printf("🆕 Starting run: %s", runID)
	if err := checkpointStore.StartRun(ctx, runID, len(stocks), 0); err != nil {
		log.Printf("⚠️ Failed to create checkpoint: %v (continuing anyway)", err)
	}

	// Calculate date range
	endDate := time.Now()
	startDate := endDate.AddDate(-*years, 0, 0)

	var totalRecords int

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

		// Check database state - this is the source of truth (unless -force is set)
		type GapPeriod struct {
			Start time.Time
			End   time.Time
		}
		var gaps []GapPeriod
		var needsFullFetch bool
		var needsIncrementalFetch bool
		var incrementalStart, incrementalEnd time.Time

		if !*forceRefetch {
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

				// Query ACTUAL gap periods (not just count) for targeted fetching
				rows, gapErr := pool.Query(ctx, `
					WITH date_series AS (
						SELECT date, LAG(date) OVER (ORDER BY date) as prev_date
						FROM stock_prices WHERE stock_code = $1
					)
					SELECT prev_date, date FROM date_series 
					WHERE prev_date IS NOT NULL AND (date - prev_date) > 4
					ORDER BY prev_date
				`, symbol)

				if gapErr == nil {
					defer rows.Close()
					for rows.Next() {
						var gapStart, gapEnd time.Time
						if err := rows.Scan(&gapStart, &gapEnd); err == nil {
							gaps = append(gaps, GapPeriod{Start: gapStart, End: gapEnd})
						}
					}
				}

				hasGaps := len(gaps) > 0

				// If we have enough historical data span AND no significant gaps, skip
				if dataSpanDays >= requiredDays && !hasGaps {
					log.Printf("✅ [%d/%d] %s: complete (%d records, %d days, no gaps)",
						i+1, len(stocks), symbol, recordCount, dataSpanDays)
					successful++
					if (i+1)%50 == 0 {
						if err := checkpointStore.UpdateProgress(ctx, runID, i+1, successful, failed, 0); err != nil {
							log.Printf("⚠️ Failed to update checkpoint: %v", err)
						}
					}
					continue
				}

				// Decide what to fetch based on data state
				if hasGaps && dataSpanDays >= requiredDays {
					// Span is sufficient, ONLY fetch gaps
					log.Printf("🔧 [%d/%d] %s: has %d gap(s) to repair (span OK)", i+1, len(stocks), symbol, len(gaps))
				} else if dataSpanDays < requiredDays {
					// Need more historical data - fetch from start to earliest OR latest to now
					if earliestDate.After(startDate) {
						// Need earlier data
						needsIncrementalFetch = true
						incrementalStart = startDate
						incrementalEnd = earliestDate.AddDate(0, 0, -1)
						log.Printf("📊 [%d/%d] %s: need earlier data (%s to %s)",
							i+1, len(stocks), symbol, incrementalStart.Format("2006-01-02"), incrementalEnd.Format("2006-01-02"))
					}
					if latestDate.Before(endDate.AddDate(0, 0, -1)) {
						// Need newer data - but we'll let the regular sync handle this
						log.Printf("📊 [%d/%d] %s: also needs newer data (latest: %s)",
							i+1, len(stocks), symbol, latestDate.Format("2006-01-02"))
					}
				}
			} else {
				// No data at all - need full fetch
				needsFullFetch = true
				log.Printf("🆕 [%d/%d] %s: no data, fetching full history...", i+1, len(stocks), symbol)
			}
		} else {
			needsFullFetch = true
		}

		var allRecords []providers.PriceRecord

		// Helper function to fetch from providers
		fetchData := func(fetchStart, fetchEnd time.Time) ([]providers.PriceRecord, error) {
			for _, p := range dataProviders {
				select {
				case <-ctx.Done():
					return nil, ctx.Err()
				case <-time.After(p.GetRateLimit()):
				}

				records, err := p.FetchHistoricalData(ctx, symbol, fetchStart, fetchEnd)
				if err == nil && len(records) > 0 {
					return records, nil
				}
			}
			return nil, nil
		}

		// Fetch based on what's needed
		if needsFullFetch {
			log.Printf("📥 [%d/%d] Fetching %s full history (%s to %s)...",
				i+1, len(stocks), symbol, startDate.Format("2006-01-02"), endDate.Format("2006-01-02"))
			records, _ := fetchData(startDate, endDate)
			if len(records) > 0 {
				log.Printf("✅ %s: Fetched %d records", symbol, len(records))
				allRecords = append(allRecords, records...)
			}
		} else {
			// Fetch only gaps
			if len(gaps) > 0 {
				for gi, gap := range gaps {
					// Add 1 day buffer on each side of gap
					gapStart := gap.Start.AddDate(0, 0, 1)
					gapEnd := gap.End.AddDate(0, 0, -1)
					if gapStart.After(gapEnd) {
						continue
					}
					log.Printf("🔧 [%d/%d] %s: fetching gap %d/%d (%s to %s)",
						i+1, len(stocks), symbol, gi+1, len(gaps), gapStart.Format("2006-01-02"), gapEnd.Format("2006-01-02"))
					records, _ := fetchData(gapStart, gapEnd)
					if len(records) > 0 {
						log.Printf("   ✅ Got %d records for gap", len(records))
						allRecords = append(allRecords, records...)
					}
				}
			}

			// Fetch incremental data if needed
			if needsIncrementalFetch {
				log.Printf("📥 [%d/%d] %s: fetching earlier history (%s to %s)...",
					i+1, len(stocks), symbol, incrementalStart.Format("2006-01-02"), incrementalEnd.Format("2006-01-02"))
				records, _ := fetchData(incrementalStart, incrementalEnd)
				if len(records) > 0 {
					log.Printf("✅ %s: Fetched %d earlier records", symbol, len(records))
					allRecords = append(allRecords, records...)
				}
			}
		}

		if len(allRecords) == 0 {
			if needsFullFetch {
				log.Printf("❌ [%d/%d] Failed to fetch data for %s", i+1, len(stocks), symbol)
				failed++
			} else {
				log.Printf("⏭️ [%d/%d] %s: no new records needed", i+1, len(stocks), symbol)
				successful++
			}
			if err := checkpointStore.UpdateProgress(ctx, runID, i+1, successful, failed, 0); err != nil {
				log.Printf("⚠️ Failed to update checkpoint: %v", err)
			}
			continue
		}

		// Insert records into database
		inserted := 0
		for _, record := range allRecords {
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
