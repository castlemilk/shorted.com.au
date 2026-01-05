package sync

import (
	"context"
	"fmt"
	"log"
	"time"

	"github.com/castlemilk/shorted.com.au/services/market-data-sync/providers"
	"github.com/jackc/pgx/v5/pgxpool"
)

// Gap represents a missing data range for a stock
type Gap struct {
	StockCode string
	StartDate time.Time
	EndDate   time.Time
	Days      int
}

// GapDetector finds and repairs gaps in stock price data
type GapDetector struct {
	db        *pgxpool.Pool
	providers []providers.DataProvider
}

// NewGapDetector creates a new gap detector
func NewGapDetector(db *pgxpool.Pool, providers []providers.DataProvider) *GapDetector {
	return &GapDetector{
		db:        db,
		providers: providers,
	}
}

// DetectGaps finds gaps in stock price data for a given stock
// A gap is defined as more than 3 consecutive trading days missing
// (to account for weekends and holidays)
func (g *GapDetector) DetectGaps(ctx context.Context, stockCode string, minGapDays int) ([]Gap, error) {
	if minGapDays <= 0 {
		minGapDays = 4 // Default: gaps of 4+ calendar days (accounts for weekends)
	}

	// Query to find gaps in the data
	// This uses window functions to compare consecutive dates
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

	rows, err := g.db.Query(ctx, query, stockCode, minGapDays)
	if err != nil {
		return nil, fmt.Errorf("failed to detect gaps: %w", err)
	}
	defer rows.Close()

	var gaps []Gap
	for rows.Next() {
		var gapStart, gapEnd time.Time
		var gapDays int

		if err := rows.Scan(&gapStart, &gapEnd, &gapDays); err != nil {
			return nil, fmt.Errorf("failed to scan gap row: %w", err)
		}

		gaps = append(gaps, Gap{
			StockCode: stockCode,
			StartDate: gapStart.AddDate(0, 0, 1), // Day after last data point
			EndDate:   gapEnd.AddDate(0, 0, -1),  // Day before next data point
			Days:      gapDays - 1,               // Actual missing days
		})
	}

	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("error iterating gap rows: %w", err)
	}

	return gaps, nil
}

// DetectAllGaps finds gaps for all stocks with data
func (g *GapDetector) DetectAllGaps(ctx context.Context, minGapDays int) (map[string][]Gap, error) {
	// Get all stocks with price data
	rows, err := g.db.Query(ctx, "SELECT DISTINCT stock_code FROM stock_prices")
	if err != nil {
		return nil, fmt.Errorf("failed to get stock list: %w", err)
	}
	defer rows.Close()

	var stockCodes []string
	for rows.Next() {
		var code string
		if err := rows.Scan(&code); err != nil {
			continue
		}
		stockCodes = append(stockCodes, code)
	}

	allGaps := make(map[string][]Gap)
	for _, code := range stockCodes {
		gaps, err := g.DetectGaps(ctx, code, minGapDays)
		if err != nil {
			log.Printf("⚠️ Failed to detect gaps for %s: %v", code, err)
			continue
		}
		if len(gaps) > 0 {
			allGaps[code] = gaps
		}
	}

	return allGaps, nil
}

// RepairGap fetches missing data and fills a specific gap
func (g *GapDetector) RepairGap(ctx context.Context, gap Gap) (int, error) {
	log.Printf("🔧 Repairing gap for %s: %s to %s (%d days)",
		gap.StockCode,
		gap.StartDate.Format("2006-01-02"),
		gap.EndDate.Format("2006-01-02"),
		gap.Days)

	// Try providers in order
	var records []providers.PriceRecord
	var syncErr error

	for _, p := range g.providers {
		// Rate limiting
		select {
		case <-ctx.Done():
			return 0, ctx.Err()
		case <-time.After(p.GetRateLimit()):
		}

		records, syncErr = p.FetchHistoricalData(ctx, gap.StockCode, gap.StartDate, gap.EndDate)
		if syncErr == nil && len(records) > 0 {
			log.Printf("✅ %s: Fetched %d gap records from %s", gap.StockCode, len(records), p.Name())
			break
		}
		if syncErr != nil {
			log.Printf("⚠️ %s: Provider %s failed for gap repair: %v", gap.StockCode, p.Name(), syncErr)
		}
	}

	if len(records) == 0 {
		return 0, fmt.Errorf("no data available to fill gap for %s", gap.StockCode)
	}

	// Insert the records
	inserted := 0
	for _, r := range records {
		_, err := g.db.Exec(ctx, `
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
		`, r.StockCode, r.Date, r.Open, r.High, r.Low, r.Close, r.AdjustedClose, r.Volume)
		if err != nil {
			log.Printf("⚠️ Failed to insert gap record for %s on %s: %v", r.StockCode, r.Date, err)
			continue
		}
		inserted++
	}

	log.Printf("✅ Repaired gap for %s: inserted %d/%d records", gap.StockCode, inserted, len(records))
	return inserted, nil
}

// RepairAllGaps detects and repairs all gaps for a stock
func (g *GapDetector) RepairAllGaps(ctx context.Context, stockCode string, minGapDays int) (int, error) {
	gaps, err := g.DetectGaps(ctx, stockCode, minGapDays)
	if err != nil {
		return 0, fmt.Errorf("failed to detect gaps: %w", err)
	}

	if len(gaps) == 0 {
		log.Printf("✅ No gaps found for %s", stockCode)
		return 0, nil
	}

	log.Printf("🔍 Found %d gaps for %s", len(gaps), stockCode)

	totalRepaired := 0
	for _, gap := range gaps {
		repaired, err := g.RepairGap(ctx, gap)
		if err != nil {
			log.Printf("⚠️ Failed to repair gap for %s (%s to %s): %v",
				stockCode, gap.StartDate.Format("2006-01-02"), gap.EndDate.Format("2006-01-02"), err)
			continue
		}
		totalRepaired += repaired

		// Rate limiting between gap repairs
		select {
		case <-ctx.Done():
			return totalRepaired, ctx.Err()
		case <-time.After(4 * time.Second):
		}
	}

	return totalRepaired, nil
}

// GapReport provides a summary of data gaps
type GapReport struct {
	StockCode     string    `json:"stock_code"`
	TotalGaps     int       `json:"total_gaps"`
	TotalMissing  int       `json:"total_missing_days"`
	Gaps          []GapInfo `json:"gaps"`
	EarliestData  string    `json:"earliest_data"`
	LatestData    string    `json:"latest_data"`
	TotalRecords  int       `json:"total_records"`
}

type GapInfo struct {
	StartDate string `json:"start_date"`
	EndDate   string `json:"end_date"`
	Days      int    `json:"days"`
}

// GenerateReport creates a gap report for a stock
func (g *GapDetector) GenerateReport(ctx context.Context, stockCode string, minGapDays int) (*GapReport, error) {
	// Get gaps
	gaps, err := g.DetectGaps(ctx, stockCode, minGapDays)
	if err != nil {
		return nil, err
	}

	// Get data stats
	var earliest, latest time.Time
	var totalRecords int

	err = g.db.QueryRow(ctx, `
		SELECT MIN(date), MAX(date), COUNT(*)
		FROM stock_prices
		WHERE stock_code = $1
	`, stockCode).Scan(&earliest, &latest, &totalRecords)
	if err != nil {
		return nil, fmt.Errorf("failed to get data stats: %w", err)
	}

	report := &GapReport{
		StockCode:    stockCode,
		TotalGaps:    len(gaps),
		EarliestData: earliest.Format("2006-01-02"),
		LatestData:   latest.Format("2006-01-02"),
		TotalRecords: totalRecords,
	}

	for _, gap := range gaps {
		report.TotalMissing += gap.Days
		report.Gaps = append(report.Gaps, GapInfo{
			StartDate: gap.StartDate.Format("2006-01-02"),
			EndDate:   gap.EndDate.Format("2006-01-02"),
			Days:      gap.Days,
		})
	}

	return report, nil
}
