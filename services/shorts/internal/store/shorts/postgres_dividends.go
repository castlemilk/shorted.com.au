package shorts

import (
	"context"
	"fmt"
	"time"
)

// GetDividendHistory retrieves dividend history for a specific stock
func (s *postgresStore) GetDividendHistory(stockCode string, years int32) ([]*DividendRecord, int, error) {
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()

	query := `SELECT id, stock_code, ex_date, payment_date, amount_per_share, franking_percentage, dividend_type
		FROM dividend_history
		WHERE stock_code = $1
		AND ex_date >= CURRENT_DATE - INTERVAL '1 year' * $2
		ORDER BY ex_date DESC`

	rows, err := s.db.Query(ctx, query, stockCode, years)
	if err != nil {
		return nil, 0, fmt.Errorf("failed to query dividend history: %w", err)
	}
	defer rows.Close()

	var dividends []*DividendRecord
	for rows.Next() {
		d := &DividendRecord{}
		if err := rows.Scan(
			&d.ID, &d.StockCode, &d.ExDate, &d.PaymentDate,
			&d.AmountPerShare, &d.FrankingPercentage, &d.DividendType,
		); err != nil {
			return nil, 0, fmt.Errorf("failed to scan dividend record: %w", err)
		}
		dividends = append(dividends, d)
	}

	if err := rows.Err(); err != nil {
		return nil, 0, fmt.Errorf("error iterating dividend rows: %w", err)
	}

	return dividends, len(dividends), nil
}
