package shorts

import (
	"context"
	"fmt"
	"time"
)

// ShortCampaign represents a single row from the short-seller scoreboard MV
type ShortCampaign struct {
	StockCode       string
	CompanyName     string
	Industry        string
	LogoURL         string
	PeakDate        string
	PeakShortPct    float64
	PriceAtPeak     float64
	Price3mAfter    float64
	Price6mAfter    float64
	Return3m        float64
	Return6m        float64
	Has3m           bool
	Has6m           bool
	ShortsWon3m     bool
	ShortsWon6m     bool
	CurrentShortPct float64
	LatestPrice     float64
}

// ScoreboardStats holds the overall win-rate aggregates across all campaigns
// matching the industry filter (not just the current page).
type ScoreboardStats struct {
	CampaignsTotal  int
	ShortsWinRate3m float64 // percent 0-100 of scored campaigns where price fell after 3 months
	ShortsWinRate6m float64 // percent 0-100 of scored campaigns where price fell after 6 months
}

// GetShortCampaignScoreboard pages through mv_short_campaigns ordered by peak
// short interest, optionally filtered by exact industry (parameterized — no
// user input in the query text). Win-rate stats are computed over the whole
// filtered set via window aggregates in the same query.
func (s *postgresStore) GetShortCampaignScoreboard(industry string, limit, offset int32) ([]*ShortCampaign, int, *ScoreboardStats, error) {
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()

	query := `
		SELECT
			stock_code,
			company_name,
			industry,
			logo_url,
			TO_CHAR(peak_date, 'YYYY-MM-DD') AS peak_date,
			peak_short_pct,
			COALESCE(price_at_peak, 0),
			COALESCE(price_3m_after, 0),
			COALESCE(price_6m_after, 0),
			COALESCE(return_3m, 0),
			COALESCE(return_6m, 0),
			(return_3m IS NOT NULL) AS has_3m,
			(return_6m IS NOT NULL) AS has_6m,
			COALESCE(shorts_won_3m, FALSE),
			COALESCE(shorts_won_6m, FALSE),
			COALESCE(current_short_pct, 0),
			COALESCE(latest_price, 0),
			COUNT(*) OVER() AS total_count,
			COALESCE(ROUND((100.0 * AVG(CASE WHEN shorts_won_3m THEN 1.0 ELSE 0.0 END)
				FILTER (WHERE shorts_won_3m IS NOT NULL) OVER())::numeric, 1), 0)::double precision AS win_rate_3m,
			COALESCE(ROUND((100.0 * AVG(CASE WHEN shorts_won_6m THEN 1.0 ELSE 0.0 END)
				FILTER (WHERE shorts_won_6m IS NOT NULL) OVER())::numeric, 1), 0)::double precision AS win_rate_6m
		FROM mv_short_campaigns
		WHERE ($1 = '' OR industry = $1)
		ORDER BY peak_short_pct DESC
		LIMIT $2 OFFSET $3
	`

	rows, err := s.db.Query(ctx, query, industry, limit, offset)
	if err != nil {
		return nil, 0, nil, fmt.Errorf("failed to query short campaign scoreboard: %w", err)
	}
	defer rows.Close()

	var totalCount int
	stats := &ScoreboardStats{}
	var campaigns []*ShortCampaign
	for rows.Next() {
		c := &ShortCampaign{}
		if err := rows.Scan(
			&c.StockCode, &c.CompanyName, &c.Industry, &c.LogoURL,
			&c.PeakDate, &c.PeakShortPct, &c.PriceAtPeak,
			&c.Price3mAfter, &c.Price6mAfter, &c.Return3m, &c.Return6m,
			&c.Has3m, &c.Has6m, &c.ShortsWon3m, &c.ShortsWon6m,
			&c.CurrentShortPct, &c.LatestPrice,
			&totalCount, &stats.ShortsWinRate3m, &stats.ShortsWinRate6m,
		); err != nil {
			return nil, 0, nil, fmt.Errorf("failed to scan short campaign: %w", err)
		}
		campaigns = append(campaigns, c)
	}

	if err := rows.Err(); err != nil {
		return nil, 0, nil, fmt.Errorf("error iterating short campaign rows: %w", err)
	}

	stats.CampaignsTotal = totalCount
	return campaigns, totalCount, stats, nil
}
