package shorts

import (
	"context"
	"time"
)

// validStateSlugs are the 8 Australian state/territory region codes accepted
// by ListStateCompanies. 'international' is a valid region in
// mv_company_state_exposure but is not a "state" a caller can list.
var validStateSlugs = map[string]bool{
	"nsw": true, "vic": true, "qld": true, "sa": true,
	"wa": true, "tas": true, "nt": true, "act": true,
}

// IsValidStateSlug reports whether state is one of the 8 Australian
// state/territory slugs (lowercase).
func IsValidStateSlug(state string) bool {
	return validStateSlugs[state]
}

// StateCompanyRow is one company's operations-weighted exposure to a state.
type StateCompanyRow struct {
	StockCode    string
	CompanyName  string
	Industry     string
	Weight       float64
	Basis        string
	MarketCap    float64
	ShortPercent float64
	LogoURL      string
	Source       string
}

// ListStateCompanies returns companies exposed to state, ordered by
// exposure-weighted market cap descending. Caller must have already
// validated state via IsValidStateSlug.
func (s *postgresStore) ListStateCompanies(state string, limit int32) ([]*StateCompanyRow, error) {
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()

	if limit <= 0 {
		limit = 10
	}
	if limit > 50 {
		limit = 50
	}

	const query = `
		SELECT stock_code, company_name, industry, weight, basis,
		       COALESCE(market_cap, 0), COALESCE(short_percent, 0),
		       COALESCE(logo_icon_gcs_url, ''), source
		FROM mv_company_state_exposure
		WHERE region = $1
		ORDER BY weight * COALESCE(market_cap, 0) DESC
		LIMIT $2`

	rows, err := s.db.Query(ctx, query, state, limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var out []*StateCompanyRow
	for rows.Next() {
		var r StateCompanyRow
		if err := rows.Scan(&r.StockCode, &r.CompanyName, &r.Industry, &r.Weight, &r.Basis,
			&r.MarketCap, &r.ShortPercent, &r.LogoURL, &r.Source); err != nil {
			return nil, err
		}
		out = append(out, &r)
	}
	return out, rows.Err()
}

// StateCompanyAggregateRow is one region's exposure-weighted aggregate.
type StateCompanyAggregateRow struct {
	State                        string
	CompanyCount                 int32
	ExposureWeightedMarketCap    float64
	ExposureWeightedShortPercent float64
}

// GetStateCompanyAggregates returns exposure-weighted market cap and short
// interest aggregates for every region present in mv_company_state_exposure,
// excluding region='international'.
func (s *postgresStore) GetStateCompanyAggregates() ([]*StateCompanyAggregateRow, error) {
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()

	// company_count counts weight >= 0.2 rows.
	// exposure_weighted_market_cap sums weight*market_cap over rows with a
	// known market_cap.
	// exposure_weighted_short_percent is computed ONLY over rows that also
	// have a non-null short_percent, for both numerator and denominator, so
	// companies with no current short data don't dilute the average.
	const query = `
		SELECT
			region,
			count(*) FILTER (WHERE weight >= 0.2) AS company_count,
			COALESCE(sum(weight * market_cap) FILTER (WHERE market_cap IS NOT NULL), 0) AS exposure_weighted_market_cap,
			COALESCE(
				sum(weight * market_cap * short_percent) FILTER (WHERE market_cap IS NOT NULL AND short_percent IS NOT NULL)
				/ NULLIF(sum(weight * market_cap) FILTER (WHERE market_cap IS NOT NULL AND short_percent IS NOT NULL), 0),
				0
			) AS exposure_weighted_short_percent
		FROM mv_company_state_exposure
		WHERE region <> 'international'
		GROUP BY region
		ORDER BY exposure_weighted_market_cap DESC`

	rows, err := s.db.Query(ctx, query)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var out []*StateCompanyAggregateRow
	for rows.Next() {
		var r StateCompanyAggregateRow
		if err := rows.Scan(&r.State, &r.CompanyCount, &r.ExposureWeightedMarketCap, &r.ExposureWeightedShortPercent); err != nil {
			return nil, err
		}
		out = append(out, &r)
	}
	return out, rows.Err()
}
