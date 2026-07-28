package marketdata

import (
	"context"
	"errors"
	"flag"
	"fmt"
	"log"
	"sort"
	"strings"
	"time"

	"github.com/castlemilk/shorted.com.au/services/jobs/internal/runner"
	"github.com/jackc/pgx/v5/pgxpool"
)

// auditGapsConfig is the parsed flag set. Flags are byte-identical to the
// standalone cmd/audit-gaps binary.
type auditGapsConfig struct {
	minGapDays  int
	years       int
	showDetails bool
}

// stockGapSummary is one stock's audit result.
type stockGapSummary struct {
	StockCode    string
	TotalRecords int
	EarliestDate time.Time
	LatestDate   time.Time
	DataSpanDays int
	GapCount     int
	TotalGapDays int
	Gaps         []gapInfo
}

// gapInfo is one missing-days window.
type gapInfo struct {
	StartDate time.Time
	EndDate   time.Time
	Days      int
}

// errGapsFound reports a non-clean audit. The standalone binary signalled this
// with os.Exit(1) after printing the summary; a sentinel error keeps the same
// non-zero exit while letting the deferred pool close run.
var errGapsFound = errors.New("audit found gaps")

// auditGapsJob returns `shorted market-data audit-gaps` (was cmd/audit-gaps):
// a READ-ONLY sweep that reports per-stock price gaps and exits non-zero when
// any are found.
//
// DryRun is false — but only because the job never writes at all, so a
// -dry-run would be meaningless rather than dangerous. Declaring it would
// imply a suppressed write path that doesn't exist.
func auditGapsJob() runner.Job {
	return runner.Func{
		JobName: "audit-gaps",
		Desc:    "read-only: report price-history gaps across every stock (exit 1 if any found)",
		Fn:      runAuditGaps,
	}
}

func runAuditGaps(ctx context.Context, args []string) error {
	fs := flag.NewFlagSet("market-data audit-gaps", flag.ContinueOnError)
	cfgFlags := auditGapsConfig{}
	fs.IntVar(&cfgFlags.minGapDays, "minGapDays", 4, "Minimum gap size in days to report (default: 4)")
	fs.IntVar(&cfgFlags.years, "years", 10, "Expected years of history (default: 10)")
	fs.BoolVar(&cfgFlags.showDetails, "details", false, "Show detailed gap information for each stock")
	if err := fs.Parse(args); err != nil {
		if errors.Is(err, flag.ErrHelp) {
			return runner.ErrUsage
		}
		return err
	}
	if fs.NArg() > 0 {
		return fmt.Errorf("unexpected argument %q", fs.Arg(0))
	}

	cfg, err := loadConfig()
	if err != nil {
		return err
	}

	// The standalone binary used a bare pgxpool.New (default pool, extended
	// protocol). It runs the same shape of query as everything else against the
	// same Supabase pooler, so it goes through the shared pool config here —
	// which additionally sets simple protocol, the mode the transaction pooler
	// actually needs.
	poolConfig, err := buildDBPoolConfig(cfg)
	if err != nil {
		return fmt.Errorf("parse DB config: %w", err)
	}
	pool, err := pgxpool.NewWithConfig(ctx, poolConfig)
	if err != nil {
		return fmt.Errorf("failed to connect to database: %w", err)
	}
	defer pool.Close()

	log.Printf("✅ Connected to database")
	log.Printf("📊 Auditing all stocks for gaps (minGapDays=%d, expectedYears=%d)...", cfgFlags.minGapDays, cfgFlags.years)

	stocks, err := auditStockList(ctx, pool)
	if err != nil {
		return err
	}
	log.Printf("📋 Found %d stocks to audit", len(stocks))
	if len(stocks) == 0 {
		// Guard the percentage divisions below; the standalone binary divided
		// by len(stocks) unconditionally and printed NaN% on an empty database.
		log.Printf("✅ Audit complete: no stocks with price data to audit")
		return nil
	}

	summaries := make([]stockGapSummary, 0, len(stocks))
	var totalStocksWithGaps, totalGaps, totalGapDays int

	for i, symbol := range stocks {
		// A full audit is thousands of queries; stop promptly on SIGTERM.
		if err := ctx.Err(); err != nil {
			return fmt.Errorf("audit cancelled after %d/%d stocks: %w", i, len(stocks), err)
		}
		if (i+1)%100 == 0 {
			log.Printf("📊 Progress: %d/%d stocks audited...", i+1, len(stocks))
		}

		summary := auditStock(ctx, pool, symbol, cfgFlags.minGapDays)
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

	reportAudit(summaries, cfgFlags, len(stocks), totalStocksWithGaps, totalGaps, totalGapDays)

	if totalStocksWithGaps > 0 {
		return fmt.Errorf("%w: %d stocks affected", errGapsFound, totalStocksWithGaps)
	}
	log.Printf("\n✅ Audit complete: All stocks have complete data!")
	return nil
}

// auditStockList returns every stock code with price data, preferring
// mv_stock_price_coverage and falling back for older/local databases.
func auditStockList(ctx context.Context, pool *pgxpool.Pool) ([]string, error) {
	rows, err := pool.Query(ctx, `
		SELECT stock_code
		FROM mv_stock_price_coverage
		ORDER BY stock_code
	`)
	if err != nil {
		log.Printf("⚠️ mv_stock_price_coverage unavailable (%v); falling back to stock_prices scan", err)
		rows, err = pool.Query(ctx, `
			SELECT DISTINCT stock_code
			FROM stock_prices
			ORDER BY stock_code
		`)
	}
	if err != nil {
		return nil, fmt.Errorf("failed to get stock list: %w", err)
	}
	defer rows.Close()

	var stocks []string
	for rows.Next() {
		var symbol string
		if err := rows.Scan(&symbol); err != nil {
			return nil, fmt.Errorf("failed to scan stock: %w", err)
		}
		stocks = append(stocks, symbol)
	}
	// The standalone binary never checked rows.Err(), so a mid-iteration
	// connection drop silently produced a SHORT stock list and a clean audit.
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("failed to read stock list: %w", err)
	}
	return stocks, nil
}

func auditStock(ctx context.Context, pool *pgxpool.Pool, symbol string, minGapDays int) stockGapSummary {
	summary := stockGapSummary{StockCode: symbol}

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

	gaps := detectGaps(ctx, pool, symbol, minGapDays)
	summary.GapCount = len(gaps)
	summary.Gaps = gaps

	for _, gap := range gaps {
		summary.TotalGapDays += gap.Days
	}

	return summary
}

func detectGaps(ctx context.Context, pool *pgxpool.Pool, stockCode string, minGapDays int) []gapInfo {
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

	var gaps []gapInfo
	for rows.Next() {
		var gapStart, gapEnd time.Time
		var gapDays int

		if err := rows.Scan(&gapStart, &gapEnd, &gapDays); err != nil {
			continue
		}

		gaps = append(gaps, gapInfo{
			StartDate: gapStart.AddDate(0, 0, 1), // Day after last data point
			EndDate:   gapEnd.AddDate(0, 0, -1),  // Day before next data point
			Days:      gapDays - 1,               // Actual missing days
		})
	}

	return gaps
}

// reportAudit prints the summary block, unchanged in content from the
// standalone binary.
func reportAudit(summaries []stockGapSummary, cfg auditGapsConfig, totalStocks, stocksWithGaps, totalGaps, totalGapDays int) {
	pct := func(n int) float64 { return float64(n) / float64(totalStocks) * 100 }

	log.Print("\n" + strings.Repeat("=", 80))
	log.Printf("📊 AUDIT SUMMARY")
	log.Print(strings.Repeat("=", 80))
	log.Printf("Total stocks audited: %d", totalStocks)
	log.Printf("Stocks with gaps: %d (%.1f%%)", stocksWithGaps, pct(stocksWithGaps))
	log.Printf("Total gaps found: %d", totalGaps)
	log.Printf("Total missing days: %d", totalGapDays)
	log.Print(strings.Repeat("=", 80))

	if stocksWithGaps > 0 {
		log.Printf("\n📋 STOCKS WITH GAPS (showing top 20):")
		log.Print(strings.Repeat("-", 80))
		shown := 0
		for _, s := range summaries {
			if s.GapCount > 0 && shown < 20 {
				log.Printf("  %s: %d gap(s), %d missing days, %d records, span: %d days",
					s.StockCode, s.GapCount, s.TotalGapDays, s.TotalRecords, s.DataSpanDays)
				if cfg.showDetails {
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
		if stocksWithGaps > 20 {
			log.Printf("  ... and %d more stocks with gaps", stocksWithGaps-20)
		}
	} else {
		log.Printf("\n✅ No gaps found! All stocks have complete data.")
	}

	log.Printf("\n📊 DATA COMPLETENESS:")
	requiredDays := cfg.years * 365
	complete := 0
	for _, s := range summaries {
		if s.DataSpanDays >= requiredDays && s.GapCount == 0 {
			complete++
		}
	}
	incomplete := totalStocks - complete
	log.Printf("  Complete stocks (%d+ years, no gaps): %d (%.1f%%)", cfg.years, complete, pct(complete))
	log.Printf("  Incomplete stocks: %d (%.1f%%)", incomplete, pct(incomplete))

	if stocksWithGaps > 0 {
		log.Printf("\n⚠️  Audit complete: Found gaps in %d stocks", stocksWithGaps)
	}
}
