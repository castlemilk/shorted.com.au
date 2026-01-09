package main

import (
	"context"
	"flag"
	"log"
	"time"

	"github.com/castlemilk/shorted.com.au/services/market-data-sync/config"
	"github.com/castlemilk/shorted.com.au/services/market-data-sync/providers"
	"github.com/jackc/pgx/v5/pgxpool"
)

func main() {
	var (
		symbol  = flag.String("symbol", "", "Stock symbol to fetch (e.g., DMP)")
		years   = flag.Int("years", 10, "Number of years of historical data")
	)
	flag.Parse()

	if *symbol == "" {
		log.Fatalf("❌ Please provide a stock symbol with -symbol flag (e.g., -symbol=DMP)")
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

	// Initialize provider
	provider := providers.NewYahooFinanceDirectProvider()
	log.Printf("✅ Yahoo Finance Direct provider initialized")

	// Calculate date range
	endDate := time.Now()
	startDate := endDate.AddDate(-*years, 0, 0)

	log.Printf("📥 Fetching historical data for %s (%s to %s)...", *symbol, startDate.Format("2006-01-02"), endDate.Format("2006-01-02"))

	// Fetch data
	records, err := provider.FetchHistoricalData(ctx, *symbol, startDate, endDate)
	if err != nil {
		log.Fatalf("❌ Failed to fetch data: %v", err)
	}

	if len(records) == 0 {
		log.Fatalf("❌ No records returned for %s", *symbol)
	}

	log.Printf("✅ Fetched %d records for %s", len(records), *symbol)

	// Insert records
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
			log.Printf("⚠️ Failed to insert record for %s on %s: %v", *symbol, record.Date.Format("2006-01-02"), err)
			continue
		}
		inserted++
	}

	log.Printf("🎉 Successfully inserted %d records for %s", inserted, *symbol)
	log.Printf("   Date range: %s to %s", records[0].Date.Format("2006-01-02"), records[len(records)-1].Date.Format("2006-01-02"))
}
