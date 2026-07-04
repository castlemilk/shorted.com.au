package shorts

import (
	"context"
	"errors"
	"fmt"
	"time"

	"github.com/jackc/pgx/v5"
)

// ErrVerdictStockNotFound signals that the requested stock has no row in the
// screener materialized view (unknown code or filtered non-equity instrument).
var ErrVerdictStockNotFound = errors.New("stock not found in screener data")

// VerdictInputs holds the raw screener-view columns the verdict composite is
// computed from. Normalization and weighting happen in the service layer.
type VerdictInputs struct {
	StockCode           string
	ShortPct            float64
	ShortPctChange4w    float64
	NetDirectorBuyValue float64
	AvgSentiment        float64
	DaysToCover         float64
}

// GetStockVerdictInputs fetches the raw verdict inputs for a single stock from
// mv_screener_data. Returns ErrVerdictStockNotFound when the stock isn't in the view.
func (s *postgresStore) GetStockVerdictInputs(productCode string) (*VerdictInputs, error) {
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()

	query := `
		SELECT
			stock_code,
			COALESCE(short_pct, 0),
			COALESCE(short_pct_change_4w, 0),
			COALESCE(net_director_buy_value, 0),
			COALESCE(avg_sentiment, 0),
			COALESCE(days_to_cover, 0)
		FROM mv_screener_data
		WHERE stock_code = $1
	`

	inputs := &VerdictInputs{}
	if err := s.db.QueryRow(ctx, query, productCode).Scan(
		&inputs.StockCode,
		&inputs.ShortPct,
		&inputs.ShortPctChange4w,
		&inputs.NetDirectorBuyValue,
		&inputs.AvgSentiment,
		&inputs.DaysToCover,
	); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return nil, ErrVerdictStockNotFound
		}
		return nil, fmt.Errorf("failed to query verdict inputs: %w", err)
	}

	return inputs, nil
}
