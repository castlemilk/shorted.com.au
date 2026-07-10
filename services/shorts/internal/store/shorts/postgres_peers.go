package shorts

import (
	"context"
	"errors"
	"fmt"
	"time"

	"github.com/castlemilk/shorted.com.au/services/pkg/log"
	"github.com/jackc/pgx/v5"
)

// mvPeerColumns is the shared projection for peer rows from mv_screener_data.
const mvPeerColumns = `
	stock_code,
	COALESCE(company_name, '') AS company_name,
	COALESCE(industry, '') AS industry,
	COALESCE(short_pct, 0) AS short_position_percent,
	COALESCE(market_cap, 0) AS market_cap,
	COALESCE(pe_ratio, 0) AS pe_ratio,
	COALESCE(dividend_yield, 0) AS dividend_yield,
	COALESCE(price_change_1m, 0) AS price_change_1m,
	COALESCE(logo_url, '') AS logo_url`

// GetPeerComparison retrieves peer stocks in the same industry for comparison.
//
// Fast path: mv_screener_data (pre-joined latest short %, price change, logo,
// key metrics; indexed on industry) — one indexed lookup for the subject and
// one indexed scan for peers, ~ms. The MV only contains stocks with a non-zero
// short position, so a subject missing from the MV falls back to a raw
// "company-metadata" lookup (single stock — the lateral probe is cheap).
// If the MV itself is unavailable (dev/test without materialized views), the
// whole call falls back to the original raw-table path.
func (s *postgresStore) GetPeerComparison(stockCode string, limit int32) (*PeerComparisonResult, error) {
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()

	subjectQuery := `
		SELECT` + mvPeerColumns + `
		FROM mv_screener_data
		WHERE stock_code = $1
		LIMIT 1`

	subject := &PeerStock{}
	err := s.db.QueryRow(ctx, subjectQuery, stockCode).Scan(
		&subject.StockCode, &subject.CompanyName, &subject.Industry,
		&subject.ShortPositionPercent, &subject.MarketCap,
		&subject.PERatio, &subject.DividendYield,
		&subject.PriceChange1M, &subject.LogoUrl,
	)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			// Subject not in the MV (e.g. zero short position) — raw lookup
			// against "company-metadata" for this one stock.
			subject, err = s.getPeerSubjectRaw(ctx, stockCode)
			if err != nil {
				return nil, fmt.Errorf("failed to get subject stock for peer comparison: %w", err)
			}
		} else {
			// MV unavailable (dev/test environments) — full raw fallback.
			log.Infof("mv_screener_data not available for peer comparison, using fallback: %v", err)
			return s.getPeerComparisonRaw(ctx, stockCode, limit)
		}
	}

	if subject.Industry == "" {
		return &PeerComparisonResult{
			Subject:  subject,
			Peers:    []*PeerStock{},
			Industry: "",
		}, nil
	}

	peersQuery := `
		SELECT` + mvPeerColumns + `
		FROM mv_screener_data
		WHERE industry = $1
		AND stock_code != $2
		ORDER BY market_cap DESC NULLS LAST
		LIMIT $3`

	rows, err := s.db.Query(ctx, peersQuery, subject.Industry, stockCode, limit)
	if err != nil {
		log.Infof("mv_screener_data peers query failed, using fallback: %v", err)
		return s.getPeerComparisonRaw(ctx, stockCode, limit)
	}
	defer rows.Close()

	var peers []*PeerStock
	for rows.Next() {
		p := &PeerStock{}
		if err := rows.Scan(
			&p.StockCode, &p.CompanyName, &p.Industry,
			&p.ShortPositionPercent, &p.MarketCap,
			&p.PERatio, &p.DividendYield,
			&p.PriceChange1M, &p.LogoUrl,
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

// rawSubjectQuery looks up a single stock in "company-metadata" with a lateral
// probe into shorts for the latest short percentage. Cheap for one stock; used
// when the subject is absent from mv_screener_data and by the full raw fallback.
const rawSubjectQuery = `
	SELECT
		cm.stock_code,
		COALESCE(cm.company_name, '') as company_name,
		COALESCE(cm.industry, '') as industry,
		COALESCE(s.latest_pct, 0) as short_position_percent,
		COALESCE((cm.key_metrics->>'market_cap')::double precision, 0) as market_cap,
		COALESCE((cm.key_metrics->>'pe_ratio')::double precision, 0) as pe_ratio,
		COALESCE((cm.key_metrics->>'dividend_yield')::double precision, 0) as dividend_yield,
		COALESCE(cm.logo_gcs_url, '') as logo_url
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

// getPeerSubjectRaw fetches the subject stock directly from "company-metadata".
// PriceChange1M is left at 0 on this path (rendered as absent by the frontend).
func (s *postgresStore) getPeerSubjectRaw(ctx context.Context, stockCode string) (*PeerStock, error) {
	subject := &PeerStock{}
	err := s.db.QueryRow(ctx, rawSubjectQuery, stockCode).Scan(
		&subject.StockCode, &subject.CompanyName, &subject.Industry,
		&subject.ShortPositionPercent, &subject.MarketCap,
		&subject.PERatio, &subject.DividendYield,
		&subject.LogoUrl,
	)
	if err != nil {
		return nil, err
	}
	return subject, nil
}

// getPeerComparisonRaw is the original raw-table path: per-company lateral
// probes into the ~2.1M-row shorts table. Slow (seconds for large industries)
// but has no MV dependency — kept for dev/test environments without
// materialized views.
func (s *postgresStore) getPeerComparisonRaw(ctx context.Context, stockCode string, limit int32) (*PeerComparisonResult, error) {
	subject, err := s.getPeerSubjectRaw(ctx, stockCode)
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
			COALESCE((cm.key_metrics->>'dividend_yield')::double precision, 0) as dividend_yield,
			COALESCE(cm.logo_gcs_url, '') as logo_url
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
			&p.LogoUrl,
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
