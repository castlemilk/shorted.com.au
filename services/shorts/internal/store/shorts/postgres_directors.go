package shorts

import (
	"context"
	"fmt"
	"time"
)

// GetDirectorTrades retrieves director trades for a specific stock
func (s *postgresStore) GetDirectorTrades(stockCode string, limit int32) ([]*DirectorTrade, int, error) {
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()

	query := `SELECT id, stock_code, director_name, trade_type, shares_traded, price_per_share, total_value, trade_date, announcement_url
		FROM director_trades
		WHERE stock_code = $1
		ORDER BY trade_date DESC`

	args := []interface{}{stockCode}
	if limit > 0 {
		query += " LIMIT $2"
		args = append(args, limit)
	}

	rows, err := s.db.Query(ctx, query, args...)
	if err != nil {
		return nil, 0, fmt.Errorf("failed to query director trades: %w", err)
	}
	defer rows.Close()

	var trades []*DirectorTrade
	for rows.Next() {
		t := &DirectorTrade{}
		if err := rows.Scan(
			&t.ID, &t.StockCode, &t.DirectorName, &t.TradeType,
			&t.SharesTraded, &t.PricePerShare, &t.TotalValue,
			&t.TradeDate, &t.AnnouncementURL,
		); err != nil {
			return nil, 0, fmt.Errorf("failed to scan director trade: %w", err)
		}
		trades = append(trades, t)
	}

	if err := rows.Err(); err != nil {
		return nil, 0, fmt.Errorf("error iterating director trade rows: %w", err)
	}

	return trades, len(trades), nil
}
