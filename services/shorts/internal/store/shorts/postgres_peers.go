package shorts

import (
	"context"
	"fmt"
	"time"
)

// GetPeerComparison retrieves peer stocks in the same industry for comparison
func (s *postgresStore) GetPeerComparison(stockCode string, limit int32) (*PeerComparisonResult, error) {
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()

	// First, get the subject stock's industry and data
	subjectQuery := `
		SELECT
			cm.stock_code,
			COALESCE(cm.company_name, '') as company_name,
			COALESCE(cm.industry, '') as industry,
			COALESCE(s.latest_pct, 0) as short_position_percent,
			COALESCE((cm.key_metrics->>'market_cap')::double precision, 0) as market_cap,
			COALESCE((cm.key_metrics->>'pe_ratio')::double precision, 0) as pe_ratio,
			COALESCE((cm.key_metrics->>'dividend_yield')::double precision, 0) as dividend_yield
		FROM "company-metadata" cm
		LEFT JOIN LATERAL (
			SELECT "PERCENT_OF_TOTAL_PRODUCT_IN_ISSUE_REPORTED_AS_SHORT_POSITIONS" as latest_pct
			FROM shorts
			WHERE "PRODUCT_CODE" = cm.stock_code
			ORDER BY "DATE" DESC
			LIMIT 1
		) s ON true
		WHERE cm.stock_code = $1
		LIMIT 1`

	subject := &PeerStock{}
	err := s.db.QueryRow(ctx, subjectQuery, stockCode).Scan(
		&subject.StockCode, &subject.CompanyName, &subject.Industry,
		&subject.ShortPositionPercent, &subject.MarketCap,
		&subject.PERatio, &subject.DividendYield,
	)
	if err != nil {
		return nil, fmt.Errorf("failed to get subject stock for peer comparison: %w", err)
	}

	if subject.Industry == "" {
		return &PeerComparisonResult{
			Subject:  subject,
			Peers:    []*PeerStock{},
			Industry: "",
		}, nil
	}

	// Get peers in the same industry
	peersQuery := `
		SELECT
			cm.stock_code,
			COALESCE(cm.company_name, '') as company_name,
			COALESCE(cm.industry, '') as industry,
			COALESCE(s.latest_pct, 0) as short_position_percent,
			COALESCE((cm.key_metrics->>'market_cap')::double precision, 0) as market_cap,
			COALESCE((cm.key_metrics->>'pe_ratio')::double precision, 0) as pe_ratio,
			COALESCE((cm.key_metrics->>'dividend_yield')::double precision, 0) as dividend_yield
		FROM "company-metadata" cm
		LEFT JOIN LATERAL (
			SELECT "PERCENT_OF_TOTAL_PRODUCT_IN_ISSUE_REPORTED_AS_SHORT_POSITIONS" as latest_pct
			FROM shorts
			WHERE "PRODUCT_CODE" = cm.stock_code
			ORDER BY "DATE" DESC
			LIMIT 1
		) s ON true
		WHERE cm.industry = $1
		AND cm.stock_code != $2
		ORDER BY COALESCE((cm.key_metrics->>'market_cap')::double precision, 0) DESC
		LIMIT $3`

	rows, err := s.db.Query(ctx, peersQuery, subject.Industry, stockCode, limit)
	if err != nil {
		return nil, fmt.Errorf("failed to query peer stocks: %w", err)
	}
	defer rows.Close()

	var peers []*PeerStock
	for rows.Next() {
		p := &PeerStock{}
		if err := rows.Scan(
			&p.StockCode, &p.CompanyName, &p.Industry,
			&p.ShortPositionPercent, &p.MarketCap,
			&p.PERatio, &p.DividendYield,
		); err != nil {
			return nil, fmt.Errorf("failed to scan peer stock: %w", err)
		}
		peers = append(peers, p)
	}

	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("error iterating peer rows: %w", err)
	}

	return &PeerComparisonResult{
		Subject:  subject,
		Peers:    peers,
		Industry: subject.Industry,
	}, nil
}
