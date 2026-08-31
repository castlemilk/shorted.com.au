package shorts

import (
	"context"
	"fmt"
	"math"
	"time"

	shortsv1alpha1 "github.com/castlemilk/shorted.com.au/services/gen/proto/go/shorts/v1alpha1"
)

// StockPricesQuery selects a window of daily price observations.
type StockPricesQuery struct {
	ProductCode string
	Period      string // Lookback shorthand, used only when From and To are empty.
	From        string // YYYY-MM-DD
	To          string // YYYY-MM-DD
	MaxPoints   int32  // 0 for no cap.
}

// GetStockPrices returns adjusted daily OHLCV for a stock.
//
// The prices live in the same database, keyed by the same ASX code, as the
// short-position series — which is the whole point. Joining short interest to
// returns outside the API meant reconciling two ticker conventions, two
// unauditable split/dividend adjustment methodologies and two universes that
// need not agree on any date; every result carried an error term from that
// seam that no care on the caller's side could remove.
func (s *postgresStore) GetStockPrices(q StockPricesQuery) (*shortsv1alpha1.GetStockPricesResponse, error) {
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()

	var where string
	args := []interface{}{q.ProductCode}
	switch {
	case q.From != "":
		where = " AND p.date >= $2::date"
		args = append(args, q.From)
		if q.To != "" {
			where += " AND p.date <= $3::date"
			args = append(args, q.To)
		}
	case q.To != "":
		where = " AND p.date <= $2::date"
		args = append(args, q.To)
	default:
		// Anchored on the newest stored price rather than CURRENT_DATE, so the
		// window behaves the same way against historical data as the short
		// series does.
		where = fmt.Sprintf(
			" AND p.date > (SELECT MAX(date) FROM stock_prices) - INTERVAL '%s'",
			periodToInterval(q.Period))
	}

	base := "FROM stock_prices p WHERE p.stock_code = $1" + where

	var total int
	if err := s.db.QueryRow(ctx, "SELECT COUNT(*) "+base, args...).Scan(&total); err != nil {
		return nil, fmt.Errorf("failed to count price observations for %s: %w", q.ProductCode, err)
	}

	rows, err := s.db.Query(ctx, `SELECT p.date, p.open, p.high, p.low, p.close, p.adjusted_close, p.volume
		`+base+`
		ORDER BY p.date ASC`, args...)
	if err != nil {
		return nil, fmt.Errorf("failed to query prices for %s: %w", q.ProductCode, err)
	}
	defer rows.Close()

	points := []*shortsv1alpha1.StockPricePoint{}
	for rows.Next() {
		var date time.Time
		var open, high, low, closePrice, adjClose *float64
		var volume *int64
		if err := rows.Scan(&date, &open, &high, &low, &closePrice, &adjClose, &volume); err != nil {
			return nil, fmt.Errorf("failed to scan price row: %w", err)
		}
		point := &shortsv1alpha1.StockPricePoint{Date: date.Format("2006-01-02")}
		// Each column is nullable and set independently: a session missing a
		// volume print is still a usable close, and zeroing the lot would turn
		// a gap into a plausible-looking price of zero.
		if open != nil {
			point.Open = finiteOrZero(*open)
		}
		if high != nil {
			point.High = finiteOrZero(*high)
		}
		if low != nil {
			point.Low = finiteOrZero(*low)
		}
		if closePrice != nil {
			point.Close = finiteOrZero(*closePrice)
		}
		if adjClose != nil {
			point.AdjustedClose = finiteOrZero(*adjClose)
		}
		if volume != nil {
			point.Volume = *volume
		}
		points = append(points, point)
	}
	if rows.Err() != nil {
		return nil, rows.Err()
	}

	downsampled := false
	if q.MaxPoints > 0 && len(points) > int(q.MaxPoints) {
		points = thinPricePoints(points, int(q.MaxPoints))
		downsampled = true
	}

	return &shortsv1alpha1.GetStockPricesResponse{
		ProductCode:       q.ProductCode,
		Points:            points,
		TotalObservations: int32(total),
		Downsampled:       downsampled,
		Currency:          "AUD",
	}, nil
}

// finiteOrZero keeps NaN and ±Inf out of the response. encoding/json refuses
// them outright while protojson emits them, so the same value serialises on
// one surface and kills the other — the defect that took MCP's screener down
// while the website's kept working.
func finiteOrZero(v float64) float64 {
	if math.IsNaN(v) || math.IsInf(v, 0) {
		return 0
	}
	return v
}

// thinPricePoints mirrors thinTimeSeries: evenly spaced, both endpoints kept.
func thinPricePoints(points []*shortsv1alpha1.StockPricePoint, max int) []*shortsv1alpha1.StockPricePoint {
	if max <= 0 || len(points) <= max {
		return points
	}
	if max == 1 {
		return points[len(points)-1:]
	}
	out := make([]*shortsv1alpha1.StockPricePoint, 0, max)
	step := float64(len(points)-1) / float64(max-1)
	for i := 0; i < max; i++ {
		out = append(out, points[int(math.Round(float64(i)*step))])
	}
	return out
}
