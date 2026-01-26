package main

import (
	"context"
	"log"
	"time"

	"github.com/castlemilk/shorted.com.au/services/market-data-sync/config"
	"github.com/castlemilk/shorted.com.au/services/market-data-sync/providers"
	"github.com/jackc/pgx/v5/pgxpool"
)

func main() {
	cfg := config.Load()
	if err := cfg.Validate(); err != nil {
		log.Fatalf("❌ Configuration error: %v", err)
	}

	ctx := context.Background()
	pool, err := pgxpool.New(ctx, cfg.DatabaseURL)
	if err != nil {
		log.Fatalf("❌ Failed to connect to database: %v", err)
	}
	defer pool.Close()

	symbol := "DMP"
	years := 10

	log.Printf("🔍 Testing full fetch for %s...", symbol)

	// Calculate date range (same as backfill)
	endDate := time.Now()
	startDate := endDate.AddDate(-years, 0, 0)

	log.Printf("📅 Date range: %s to %s", startDate.Format("2006-01-02"), endDate.Format("2006-01-02"))

	// Initialize provider
	provider := providers.NewYahooFinanceDirectProvider()

	// Fetch data
	log.Printf("📥 Fetching historical data...")
	records, err := provider.FetchHistoricalData(ctx, symbol, startDate, endDate)
	if err != nil {
		log.Fatalf("❌ Failed to fetch: %v", err)
	}

	log.Printf("✅ Fetched %d records", len(records))
	if len(records) > 0 {
		log.Printf("   Date range: %s to %s", 
			records[0].Date.Format("2006-01-02"), 
			records[len(records)-1].Date.Format("2006-01-02"))
		
		// Check for daily vs monthly pattern
		if len(records) > 10 {
			log.Printf("\n📊 Sample dates (first 10):")
			for i := 0; i < 10 && i < len(records); i++ {
				log.Printf("   %s", records[i].Date.Format("2006-01-02"))
			}
			
			// Check gap pattern
			if len(records) > 1 {
				firstGap := records[1].Date.Sub(records[0].Date).Hours() / 24
				log.Printf("\n📊 Gap analysis:")
				log.Printf("   First gap: %.0f days", firstGap)
				if firstGap > 7 {
					log.Printf("   ⚠️  WARNING: Large gap detected - might be monthly data!")
				} else if firstGap <= 3 {
					log.Printf("   ✅ Looks like daily data")
				}
			}
		}
	}

	// Check what would be inserted
	log.Printf("\n💾 Database impact:")
	var currentCount int
	pool.QueryRow(ctx, "SELECT COUNT(*) FROM stock_prices WHERE stock_code = $1", symbol).Scan(&currentCount)
	log.Printf("   Current records: %d", currentCount)
	log.Printf("   New records to insert: %d", len(records))
	log.Printf("   Expected final count: ~%d (some duplicates)", len(records))
}
