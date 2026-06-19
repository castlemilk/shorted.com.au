package shorts

import (
	"context"
	"fmt"
	"sort"
	"strings"
	"time"
)

// GetEventTimeline merges events from ASX announcements, director trades, price-sensitive
// news, and short-position spikes into a single chronological feed for the given stock.
//
// daysBack controls the lookback window (default 90). limit caps the returned events
// (default 50). The result is sorted by date DESC and truncated to limit.
func (s *postgresStore) GetEventTimeline(stockCode string, daysBack, limit int32) ([]*TimelineEventRow, error) {
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()

	stockCode = strings.ToUpper(strings.TrimSpace(stockCode))
	if daysBack <= 0 {
		daysBack = 90
	}
	if limit <= 0 {
		limit = 50
	}

	var events []*TimelineEventRow

	// ---- Query 1: ASX Announcements ----
	const announcementsQuery = `
		SELECT
			announcement_date::text,
			COALESCE(announcement_type, ''),
			COALESCE(headline, ''),
			COALESCE(pdf_url, ''),
			is_price_sensitive
		FROM asx_announcements
		WHERE stock_code = $1
		  AND announcement_date >= CURRENT_DATE - ($2::int * interval '1 day')
		ORDER BY announcement_date DESC`

	annRows, err := s.db.Query(ctx, announcementsQuery, stockCode, daysBack)
	if err != nil {
		return nil, fmt.Errorf("GetEventTimeline: announcements query failed: %w", err)
	}
	defer annRows.Close()

	for annRows.Next() {
		var date, annType, headline, pdfURL string
		var isPriceSensitive bool
		if err := annRows.Scan(&date, &annType, &headline, &pdfURL, &isPriceSensitive); err != nil {
			return nil, fmt.Errorf("GetEventTimeline: scan announcement row: %w", err)
		}
		events = append(events, &TimelineEventRow{
			Date:             date,
			Type:             "announcement",
			Title:            annType,
			Detail:           headline,
			URL:              pdfURL,
			Sentiment:        "",
			IsPriceSensitive: isPriceSensitive,
		})
	}
	if err := annRows.Err(); err != nil {
		return nil, fmt.Errorf("GetEventTimeline: iterate announcement rows: %w", err)
	}

	// ---- Query 2: Director Trades ----
	const directorTradesQuery = `
		SELECT
			trade_date::text,
			COALESCE(director_name, ''),
			COALESCE(trade_type, ''),
			COALESCE(total_value, 0),
			COALESCE(announcement_url, '')
		FROM director_trades
		WHERE stock_code = $1
		  AND trade_date >= CURRENT_DATE - ($2::int * interval '1 day')
		ORDER BY trade_date DESC`

	tradeRows, err := s.db.Query(ctx, directorTradesQuery, stockCode, daysBack)
	if err != nil {
		return nil, fmt.Errorf("GetEventTimeline: director trades query failed: %w", err)
	}
	defer tradeRows.Close()

	for tradeRows.Next() {
		var date, directorName, tradeType, annURL string
		var totalValue float64
		if err := tradeRows.Scan(&date, &directorName, &tradeType, &totalValue, &annURL); err != nil {
			return nil, fmt.Errorf("GetEventTimeline: scan director trade row: %w", err)
		}
		events = append(events, &TimelineEventRow{
			Date:             date,
			Type:             "director_trade",
			Title:            directorName + " " + tradeType,
			Detail:           formatCurrency(totalValue),
			URL:              annURL,
			Sentiment:        "",
			IsPriceSensitive: false,
		})
	}
	if err := tradeRows.Err(); err != nil {
		return nil, fmt.Errorf("GetEventTimeline: iterate director trade rows: %w", err)
	}

	// ---- Query 3: Price-sensitive news ----
	const newsQuery = `
		SELECT
			published_at::date::text,
			COALESCE(headline, ''),
			COALESCE(url, ''),
			COALESCE(sentiment, ''),
			COALESCE(summary, '')
		FROM news_articles
		WHERE stock_code = $1
		  AND is_price_sensitive = TRUE
		  AND published_at >= CURRENT_TIMESTAMP - ($2::int * interval '1 day')
		  AND (cluster_id IS NULL OR cluster_is_primary = TRUE)
		ORDER BY published_at DESC`

	newsRows, err := s.db.Query(ctx, newsQuery, stockCode, daysBack)
	if err != nil {
		return nil, fmt.Errorf("GetEventTimeline: news query failed: %w", err)
	}
	defer newsRows.Close()

	for newsRows.Next() {
		var date, headline, newsURL, sentiment, summary string
		if err := newsRows.Scan(&date, &headline, &newsURL, &sentiment, &summary); err != nil {
			return nil, fmt.Errorf("GetEventTimeline: scan news row: %w", err)
		}
		events = append(events, &TimelineEventRow{
			Date:             date,
			Type:             "news",
			Title:            headline,
			Detail:           summary,
			URL:              newsURL,
			Sentiment:        sentiment,
			IsPriceSensitive: true,
		})
	}
	if err := newsRows.Err(); err != nil {
		return nil, fmt.Errorf("GetEventTimeline: iterate news rows: %w", err)
	}

	// ---- Query 4: Short-position spikes (WoW delta >= 1.0 pp) ----
	const shortSpikesQuery = `
		WITH lagged AS (
			SELECT
				"DATE",
				"PERCENT_OF_TOTAL_PRODUCT_IN_ISSUE_REPORTED_AS_SHORT_POSITIONS" AS pct,
				"PERCENT_OF_TOTAL_PRODUCT_IN_ISSUE_REPORTED_AS_SHORT_POSITIONS"
					- LAG("PERCENT_OF_TOTAL_PRODUCT_IN_ISSUE_REPORTED_AS_SHORT_POSITIONS")
					  OVER (ORDER BY "DATE") AS delta
			FROM shorts
			WHERE "PRODUCT_CODE" = $1
			  AND "DATE" >= CURRENT_DATE - ($2::int * interval '1 day')
		)
		SELECT
			"DATE"::text,
			pct,
			delta
		FROM lagged
		WHERE delta >= 1.0
		ORDER BY "DATE" DESC`

	spikeRows, err := s.db.Query(ctx, shortSpikesQuery, stockCode, daysBack)
	if err != nil {
		return nil, fmt.Errorf("GetEventTimeline: short spikes query failed: %w", err)
	}
	defer spikeRows.Close()

	for spikeRows.Next() {
		var date string
		var pct, delta float64
		if err := spikeRows.Scan(&date, &pct, &delta); err != nil {
			return nil, fmt.Errorf("GetEventTimeline: scan short spike row: %w", err)
		}
		events = append(events, &TimelineEventRow{
			Date:             date,
			Type:             "short_spike",
			Title:            fmt.Sprintf("Short interest +%.1fpp", delta),
			Detail:           fmt.Sprintf("Short position reached %.2f%%", pct),
			URL:              "",
			Sentiment:        "",
			IsPriceSensitive: false,
		})
	}
	if err := spikeRows.Err(); err != nil {
		return nil, fmt.Errorf("GetEventTimeline: iterate short spike rows: %w", err)
	}

	// Sort all events by date DESC (lexicographic on YYYY-MM-DD is correct)
	sort.Slice(events, func(i, j int) bool {
		return events[i].Date > events[j].Date
	})

	// Truncate to limit
	if int32(len(events)) > limit {
		events = events[:limit]
	}

	return events, nil
}

// formatCurrency formats a float64 dollar amount as a human-readable string (e.g. "$1.2M").
func formatCurrency(value float64) string {
	if value < 0 {
		return fmt.Sprintf("-$%.2f", -value)
	}
	switch {
	case value >= 1_000_000_000:
		return fmt.Sprintf("$%.1fB", value/1_000_000_000)
	case value >= 1_000_000:
		return fmt.Sprintf("$%.1fM", value/1_000_000)
	case value >= 1_000:
		return fmt.Sprintf("$%.1fK", value/1_000)
	default:
		return fmt.Sprintf("$%.2f", value)
	}
}
