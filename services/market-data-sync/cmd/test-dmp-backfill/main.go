package main

import (
	"context"
	"log"
	"time"

	"github.com/castlemilk/shorted.com.au/services/market-data-sync/config"
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

	log.Printf("🔍 Simulating backfill logic for %s...", symbol)

	// Step 1: Check database state (same as backfill)
	var earliestDate, latestDate time.Time
	var recordCount int
	err = pool.QueryRow(ctx, `
		SELECT MIN(date), MAX(date), COUNT(*) 
		FROM stock_prices 
		WHERE stock_code = $1
	`, symbol).Scan(&earliestDate, &latestDate, &recordCount)

	if err != nil {
		log.Fatalf("❌ Failed to query: %v", err)
	}

	log.Printf("📊 Current state:")
	log.Printf("   Records: %d", recordCount)
	log.Printf("   Earliest: %s", earliestDate.Format("2006-01-02"))
	log.Printf("   Latest: %s", latestDate.Format("2006-01-02"))

	// Calculate span
	dataSpanDays := int(latestDate.Sub(earliestDate).Hours() / 24)
	requiredDays := years * 365
	log.Printf("   Span: %d days (required: %d)", dataSpanDays, requiredDays)

	// Step 2: Detect gaps
	type GapPeriod struct {
		Start time.Time
		End   time.Time
	}
	var gaps []GapPeriod

	rows, gapErr := pool.Query(ctx, `
		WITH date_series AS (
			SELECT date, LAG(date) OVER (ORDER BY date) as prev_date
			FROM stock_prices WHERE stock_code = $1
		)
		SELECT prev_date, date FROM date_series 
		WHERE prev_date IS NOT NULL AND (date - prev_date) > 4
		ORDER BY prev_date
	`, symbol)

	if gapErr != nil {
		log.Fatalf("❌ Failed to query gaps: %v", gapErr)
	}
	defer rows.Close()

	for rows.Next() {
		var gapStart, gapEnd time.Time
		if err := rows.Scan(&gapStart, &gapEnd); err == nil {
			gaps = append(gaps, GapPeriod{Start: gapStart, End: gapEnd})
		}
	}

	log.Printf("\n📊 Gap Analysis:")
	log.Printf("   Gaps found: %d", len(gaps))
	if len(gaps) > 0 {
		log.Printf("   First 5 gaps:")
		for i, gap := range gaps {
			if i >= 5 {
				break
			}
			gapDays := int(gap.End.Sub(gap.Start).Hours() / 24)
			log.Printf("     Gap %d: %s to %s (%d days)", i+1,
				gap.Start.Format("2006-01-02"),
				gap.End.Format("2006-01-02"),
				gapDays)
		}
	}

	// Step 3: Decision logic (same as backfill)
	hasGaps := len(gaps) > 0
	log.Printf("\n🤔 Backfill Decision Logic:")
	log.Printf("   dataSpanDays >= requiredDays: %t (%d >= %d)", dataSpanDays >= requiredDays, dataSpanDays, requiredDays)
	log.Printf("   hasGaps: %t (%d gaps)", hasGaps, len(gaps))

	if dataSpanDays >= requiredDays && !hasGaps {
		log.Printf("\n✅ DECISION: SKIP - Stock appears complete")
		log.Printf("   Reason: Span sufficient AND no gaps")
	} else if hasGaps && dataSpanDays >= requiredDays {
		log.Printf("\n🔄 DECISION: FETCH GAPS ONLY")
		log.Printf("   Reason: Span sufficient BUT has gaps")
		if len(gaps) > 10 {
			log.Printf("   Action: Fetch full range (too many gaps: %d)", len(gaps))
		} else {
			log.Printf("   Action: Fetch individual gaps (%d gaps)", len(gaps))
		}
	} else {
		log.Printf("\n📥 DECISION: FETCH FULL RANGE")
		log.Printf("   Reason: Insufficient span OR missing data")
	}
}
