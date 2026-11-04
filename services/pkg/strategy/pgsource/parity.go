package pgsource

import (
	"context"
	"errors"
	"fmt"
	"time"

	"github.com/jackc/pgx/v5"

	"cloud.google.com/go/civil"

	"github.com/castlemilk/shorted.com.au/services/pkg/strategy/features"
)

// The readers below are the shadow parity's view side: the materialised views
// the picks refresh writes, read as the views hold them. They are not used by
// the engine, which reads bars and computes features itself.

// BarCodes lists the stock codes with a stored bar dated in [from, to], sorted.
// A code with no bar in the range is absent, so the parity universe is the set
// of codes the Go port could feature.
func BarCodes(ctx context.Context, db DB, from, to civil.Date) ([]string, error) {
	ctx, cancel := context.WithTimeout(ctx, strategiesQueryTimeout)
	defer cancel()

	rows, err := db.Query(ctx, `
		SELECT DISTINCT stock_code::text
		FROM stock_prices
		WHERE date BETWEEN $1::date AND $2::date
		ORDER BY 1`, from.String(), to.String())
	if err != nil {
		return nil, fmt.Errorf("query bar codes: %w", err)
	}
	defer rows.Close()
	var out []string
	for rows.Next() {
		var code string
		if err := rows.Scan(&code); err != nil {
			return nil, fmt.Errorf("scan bar code: %w", err)
		}
		out = append(out, code)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("iterate bar codes: %w", err)
	}
	return out, nil
}

// PriceView reads every row of mv_price_features, keyed by stock code. Unlike
// the picker reads, a missing view is an error: the parity check cannot say
// anything about a view that is not there.
func PriceView(ctx context.Context, db DB) (map[string]features.ViewPrice, error) {
	ctx, cancel := context.WithTimeout(ctx, strategiesQueryTimeout)
	defer cancel()

	rows, err := db.Query(ctx, `
		SELECT stock_code::text, as_of, close::float8, prev_close::float8, sma10::float8, sma20::float8,
		       sma50::float8, sma150::float8, sma200::float8, sma200_1m_ago::float8, high_52w::float8,
		       low_52w::float8, pct_off_52w_high::float8, pct_above_52w_low::float8, volume::int8,
		       avg_volume_50d::float8, volume_ratio_50d::float8, dollar_volume_20d::float8,
		       base_high::float8, base_low::float8, base_depth_pct::float8, base_length_days::int4,
		       breakout_recent, breakout_date, ret_1m_pct::float8, ret_3m_pct::float8, ret_6m_pct::float8,
		       ret_12m_pct::float8, rs_3m_pct::float8, rs_6m_pct::float8, sessions_available::int4
		FROM mv_price_features`)
	if err != nil {
		return nil, fmt.Errorf("query mv_price_features: %w", err)
	}
	defer rows.Close()
	out := map[string]features.ViewPrice{}
	for rows.Next() {
		var (
			code string
			v    features.ViewPrice
		)
		if err := rows.Scan(&code, &v.AsOf, &v.Close, &v.PrevClose, &v.SMA10, &v.SMA20,
			&v.SMA50, &v.SMA150, &v.SMA200, &v.SMA200Lag, &v.High52, &v.Low52, &v.PctOff, &v.PctAbove, &v.Volume,
			&v.AvgVolume, &v.VolumeRatio, &v.DollarVolume, &v.BaseHigh, &v.BaseLow, &v.BaseDepth, &v.BaseLength,
			&v.BreakoutRecent, &v.BreakoutDate, &v.Ret1, &v.Ret3, &v.Ret6, &v.Ret12, &v.RS3, &v.RS6,
			&v.SessionsAvail); err != nil {
			return nil, fmt.Errorf("scan mv_price_features row: %w", err)
		}
		out[code] = v
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("iterate mv_price_features: %w", err)
	}
	return out, nil
}

// RegimeView reads the XJO row of mv_market_regime. ok is false when the view
// has no XJO row, which the parity check reports rather than reads as a match.
func RegimeView(ctx context.Context, db DB) (v features.ViewRegime, ok bool, err error) {
	ctx, cancel := context.WithTimeout(ctx, strategiesQueryTimeout)
	defer cancel()

	var asOf *time.Time
	err = db.QueryRow(ctx, `
		SELECT as_of, close::float8, sma50::float8, sma200::float8, pct_off_52w_high::float8,
		       ret_1m_pct::float8, ret_3m_pct::float8, regime
		FROM mv_market_regime WHERE index_code = 'XJO'`).Scan(
		&asOf, &v.Close, &v.SMA50, &v.SMA200, &v.PctOff, &v.Ret1, &v.Ret3, &v.Label)
	if errors.Is(err, pgx.ErrNoRows) {
		return features.ViewRegime{}, false, nil
	}
	if err != nil {
		return features.ViewRegime{}, false, fmt.Errorf("query mv_market_regime: %w", err)
	}
	v.AsOf = asOf
	return v, true, nil
}
