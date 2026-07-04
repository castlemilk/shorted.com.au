package shorts

import (
	"context"
	"fmt"
	"time"

	shortsv1alpha1 "github.com/castlemilk/shorted.com.au/services/gen/proto/go/shorts/v1alpha1"
)

// BattlegroundStock represents a single row from the squeeze-radar / battlegrounds ranking
type BattlegroundStock struct {
	StockCode        string
	CompanyName      string
	Industry         string
	LogoURL          string
	ShortPct         float64
	ShortPctChange4w float64
	LatestPrice      float64
	PriceChange1m    float64
	DaysToCover      float64
	SqueezeScore     float64
	DivergenceScore  float64
	MarketCap        float64
}

// GetBattlegroundStocks ranks stocks from the screener materialized view by either
// squeeze risk (days-to-cover + short interest + momentum + crowding) or divergence
// (price rising while shorts build). The view enum maps to fixed SQL fragments only —
// no user input is interpolated into the query.
func (s *postgresStore) GetBattlegroundStocks(view shortsv1alpha1.BattlegroundView, limit, offset int32) ([]*BattlegroundStock, int, error) {
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()

	// Fixed per-view SQL fragments (never derived from user input)
	whereClause := ""
	orderClause := "ORDER BY squeeze_score DESC"
	if view == shortsv1alpha1.BattlegroundView_BATTLEGROUND_VIEW_DIVERGENCE {
		whereClause = "WHERE divergence_score > 0"
		orderClause = "ORDER BY divergence_score DESC"
	}

	query := fmt.Sprintf(`
		WITH scored AS (
			SELECT
				stock_code, company_name, industry, logo_url,
				short_pct, short_pct_change_4w, latest_price, price_change_1m,
				COALESCE(days_to_cover, 0) AS days_to_cover,
				market_cap,
				ROUND((100 * (
					  0.35 * LEAST(COALESCE(days_to_cover, 0) / 10.0, 1.0)
					+ 0.30 * LEAST(short_pct / 15.0, 1.0)
					+ 0.20 * LEAST(GREATEST(price_change_1m, 0) / 20.0, 1.0)
					+ 0.15 * LEAST(GREATEST(short_pct_change_4w, 0) / 3.0, 1.0)
				))::numeric, 1)::double precision AS squeeze_score,
				CASE
					WHEN price_change_1m > 0 AND short_pct_change_4w > 0 THEN
						ROUND((100 * LEAST(price_change_1m / 20.0, 1.0)
								   * LEAST(short_pct_change_4w / 3.0, 1.0))::numeric, 1)::double precision
					ELSE 0
				END AS divergence_score
			FROM mv_screener_data
			WHERE short_pct >= 1.0
		)
		SELECT
			stock_code, company_name, industry, logo_url,
			short_pct, short_pct_change_4w, latest_price, price_change_1m,
			days_to_cover, market_cap, squeeze_score, divergence_score,
			COUNT(*) OVER() AS total_count
		FROM scored
		%s
		%s
		LIMIT $1 OFFSET $2
	`, whereClause, orderClause)

	rows, err := s.db.Query(ctx, query, limit, offset)
	if err != nil {
		return nil, 0, fmt.Errorf("failed to query battleground stocks: %w", err)
	}
	defer rows.Close()

	var totalCount int
	var stocks []*BattlegroundStock
	for rows.Next() {
		stock := &BattlegroundStock{}
		if err := rows.Scan(
			&stock.StockCode, &stock.CompanyName, &stock.Industry, &stock.LogoURL,
			&stock.ShortPct, &stock.ShortPctChange4w, &stock.LatestPrice, &stock.PriceChange1m,
			&stock.DaysToCover, &stock.MarketCap, &stock.SqueezeScore, &stock.DivergenceScore,
			&totalCount,
		); err != nil {
			return nil, 0, fmt.Errorf("failed to scan battleground stock: %w", err)
		}
		stocks = append(stocks, stock)
	}

	if err := rows.Err(); err != nil {
		return nil, 0, fmt.Errorf("error iterating battleground rows: %w", err)
	}

	return stocks, totalCount, nil
}
