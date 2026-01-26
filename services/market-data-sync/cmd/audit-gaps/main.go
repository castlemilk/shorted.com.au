package main

import (
	"context"
	"flag"
	"log"
	"os"
	"sort"
	"strings"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/castlemilk/shorted.com.au/services/market-data-sync/config"
)

type StockGapSummary struct {
	StockCode      string
	TotalRecords   int
	EarliestDate   time.Time
	LatestDate     time.Time
	DataSpanDays   int
	GapCount       int
	TotalGapDays   int
	Gaps           []GapInfo
}

type GapInfo struct {
	StartDate time.Time
	EndDate   time.Time
	Days      int
}

func main() {
	minGapDays := flag.Int("minGapDays", 4, "Minimum gap size in days to report (default: 4)")
	years := flag.Int("years", 10, "Expected years of history (default: 10)")
	showDetails := flag.Bool("details", false, "Show detailed gap information for each stock")
	flag.Parse()

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

	log.Printf("✅ Connected to database")
	log.Printf("📊 Auditing all stocks for gaps (minGapDays=%d, expectedYears=%d)...", *minGapDays, *years)

	// Get all stocks
	rows, err := pool.Query(ctx, `
		SELECT DISTINCT stock_code 
		FROM stock_prices 
		ORDER BY stock_code
	`)
	if err != nil {
		log.Fatalf("❌ Failed to get stock list: %v", err)
	}
	defer rows.Close()

	var stocks []string
	for rows.Next() {
		var symbol string
		if err := rows.Scan(&symbol); err != nil {
			log.Fatalf("❌ Failed to scan stock: %v", err)
		}
		stocks = append(stocks, symbol)
	}

	log.Printf("📋 Found %d stocks to audit", len(stocks))

	// Audit each stock
	var summaries []StockGapSummary
	var totalStocksWithGaps int
	var totalGaps int
	var totalGapDays int

	for i, symbol := range stocks {
		if (i+1)%100 == 0 {
			log.Printf("📊 Progress: %d/%d stocks audited...", i+1, len(stocks))
		}

		summary := auditStock(ctx, pool, symbol, *minGapDays, *years)
		summaries = append(summaries, summary)

		if summary.GapCount > 0 {
			totalStocksWithGaps++
			totalGaps += summary.GapCount
			totalGapDays += summary.TotalGapDays
		}
	}

	// Sort by gap count (descending)
	sort.Slice(summaries, func(i, j int) bool {
		if summaries[i].GapCount != summaries[j].GapCount {
			return summaries[i].GapCount > summaries[j].GapCount
		}
		return summaries[i].TotalGapDays > summaries[j].TotalGapDays
	})

	// Print summary
	log.Printf("\n" + strings.Repeat("=", 80))
	log.Printf("📊 AUDIT SUMMARY")
	log.Printf(strings.Repeat("=", 80))
	log.Printf("Total stocks audited: %d", len(stocks))
	log.Printf("Stocks with gaps: %d (%.1f%%)", totalStocksWithGaps, float64(totalStocksWithGaps)/float64(len(stocks))*100)
	log.Printf("Total gaps found: %d", totalGaps)
	log.Printf("Total missing days: %d", totalGapDays)
	log.Printf(strings.Repeat("=", 80))

	// Show stocks with gaps
	if totalStocksWithGaps > 0 {
		log.Printf("\n📋 STOCKS WITH GAPS (showing top 20):")
		log.Printf(strings.Repeat("-", 80))
		shown := 0
		for _, s := range summaries {
			if s.GapCount > 0 && shown < 20 {
				log.Printf("  %s: %d gap(s), %d missing days, %d records, span: %d days",
					s.StockCode, s.GapCount, s.TotalGapDays, s.TotalRecords, s.DataSpanDays)
				if *showDetails && len(s.Gaps) > 0 {
					for _, gap := range s.Gaps {
						log.Printf("    - Gap: %s to %s (%d days)",
							gap.StartDate.Format("2006-01-02"),
							gap.EndDate.Format("2006-01-02"),
							gap.Days)
					}
				}
				shown++
			}
		}
		if totalStocksWithGaps > 20 {
			log.Printf("  ... and %d more stocks with gaps", totalStocksWithGaps-20)
		}
	} else {
		log.Printf("\n✅ No gaps found! All stocks have complete data.")
	}

	// Check data completeness
	log.Printf("\n📊 DATA COMPLETENESS:")
	requiredDays := *years * 365
	completeStocks := 0
	incompleteStocks := 0
	for _, s := range summaries {
		if s.DataSpanDays >= requiredDays && s.GapCount == 0 {
			completeStocks++
		} else {
			incompleteStocks++
		}
	}
	log.Printf("  Complete stocks (%d+ years, no gaps): %d (%.1f%%)",
		*years, completeStocks, float64(completeStocks)/float64(len(stocks))*100)
	log.Printf("  Incomplete stocks: %d (%.1f%%)",
		incompleteStocks, float64(incompleteStocks)/float64(len(stocks))*100)

	// Exit with error if gaps found
	if totalStocksWithGaps > 0 {
		log.Printf("\n⚠️  Audit complete: Found gaps in %d stocks", totalStocksWithGaps)
		os.Exit(1)
	} else {
		log.Printf("\n✅ Audit complete: All stocks have complete data!")
		os.Exit(0)
	}
}

func auditStock(ctx context.Context, pool *pgxpool.Pool, symbol string, minGapDays int, expectedYears int) StockGapSummary {
	summary := StockGapSummary{
		StockCode: symbol,
	}

	// Get basic stats
	var earliestDate, latestDate time.Time
	var recordCount int
	err := pool.QueryRow(ctx, `
		SELECT MIN(date), MAX(date), COUNT(*) 
		FROM stock_prices 
		WHERE stock_code = $1
	`, symbol).Scan(&earliestDate, &latestDate, &recordCount)

	if err != nil || recordCount == 0 || earliestDate.IsZero() || latestDate.IsZero() {
		return summary // No data
	}

	summary.TotalRecords = recordCount
	summary.EarliestDate = earliestDate
	summary.LatestDate = latestDate
	summary.DataSpanDays = int(latestDate.Sub(earliestDate).Hours() / 24)

	// Detect gaps
	gaps := detectGaps(ctx, pool, symbol, minGapDays)
	summary.GapCount = len(gaps)
	summary.Gaps = gaps

	for _, gap := range gaps {
		summary.TotalGapDays += gap.Days
	}

	return summary
}

func detectGaps(ctx context.Context, pool *pgxpool.Pool, stockCode string, minGapDays int) []GapInfo {
	query := `
		WITH date_series AS (
			SELECT 
				date,
				LAG(date) OVER (ORDER BY date) as prev_date
			FROM stock_prices
			WHERE stock_code = $1
			ORDER BY date
		),
		gaps AS (
			SELECT 
				prev_date as gap_start,
				date as gap_end,
				(date - prev_date) as gap_days
			FROM date_series
			WHERE prev_date IS NOT NULL
			  AND (date - prev_date) > $2
		)
		SELECT gap_start, gap_end, gap_days
		FROM gaps
		ORDER BY gap_start
	`

	rows, err := pool.Query(ctx, query, stockCode, minGapDays)
	if err != nil {
		return nil
	}
	defer rows.Close()

	var gaps []GapInfo
	for rows.Next() {
		var gapStart, gapEnd time.Time
		var gapDays int

		if err := rows.Scan(&gapStart, &gapEnd, &gapDays); err != nil {
			continue
		}

		gaps = append(gaps, GapInfo{
			StartDate: gapStart.AddDate(0, 0, 1), // Day after last data point
			EndDate:   gapEnd.AddDate(0, 0, -1),  // Day before next data point
			Days:      gapDays - 1,               // Actual missing days
		})
	}

	return gaps
}
