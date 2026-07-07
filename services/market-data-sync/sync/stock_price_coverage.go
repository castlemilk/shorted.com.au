package sync

import (
	"context"
	"fmt"
	"log"
	"time"
)

const latestPriceDatesQuery = `
	SELECT stock_code, latest_date
	FROM mv_stock_price_coverage
	ORDER BY stock_code`

const latestPriceDatesFallbackQuery = `
	SELECT stock_code, MAX(date)
	FROM stock_prices
	GROUP BY stock_code`

const stockCodesWithPriceDataQuery = `
	SELECT stock_code
	FROM mv_stock_price_coverage
	ORDER BY stock_code`

const stockCodesWithPriceDataFallbackQuery = `
	SELECT DISTINCT stock_code
	FROM stock_prices
	ORDER BY stock_code`

const refreshStockPriceCoverageQuery = `REFRESH MATERIALIZED VIEW CONCURRENTLY mv_stock_price_coverage`

func scanLatestPriceDates(rows interface {
	Next() bool
	Scan(...any) error
	Err() error
	Close()
}) (map[string]time.Time, error) {
	defer rows.Close()

	result := make(map[string]time.Time, 4096)
	for rows.Next() {
		var code string
		var d time.Time
		if err := rows.Scan(&code, &d); err != nil {
			return nil, err
		}
		result[code] = d
	}
	return result, rows.Err()
}

func (m *SyncManager) refreshStockPriceCoverage(ctx context.Context) error {
	if _, err := m.db.Exec(ctx, refreshStockPriceCoverageQuery); err != nil {
		return fmt.Errorf("refresh stock price coverage: %w", err)
	}
	return nil
}

func logCoverageFallback(err error) {
	log.Printf("⚠️ mv_stock_price_coverage unavailable (%v); falling back to stock_prices scan", err)
}
