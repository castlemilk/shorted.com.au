package shorts

import (
	"context"
	"fmt"
	"strings"
	"time"
)

// GetStockGraph returns the people connected to a stock (with their other company roles)
// and semantically similar companies, sourced from the entities/entity_edges tables.
//
// Two independent queries are executed:
//  1. People: persons with officer_of/directs edges to this company, plus their OTHER
//     company connections aggregated into an array.
//  2. Similar companies: company→company similar_to edges ordered by weight DESC.
//
// Both queries use a 10-second context timeout. An empty similar-companies result is
// normal when those edges have not yet been backfilled.
func (s *postgresStore) GetStockGraph(stockCode string, limit int32) (*StockGraphResult, error) {
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()

	if limit <= 0 {
		limit = 12
	}
	stockCode = strings.ToUpper(strings.TrimSpace(stockCode))

	result := &StockGraphResult{}

	// ---- Query 1: People ----
	const peopleQuery = `
		WITH co AS (SELECT id FROM entities WHERE type='company' AND stock_code=$1)
		SELECT p.canonical_name,
		       COALESCE(e.attrs->>'role',''),
		       COALESCE(p.attrs->>'image_url',''),
		       COALESCE(p.attrs->>'linkedin_url',''),
		       COALESCE(array_agg(DISTINCT oc.stock_code) FILTER (WHERE oc.stock_code IS NOT NULL AND oc.stock_code<>$1), '{}')
		FROM entity_edges e
		JOIN entities p ON p.id=e.src_id AND p.type='person'
		JOIN co ON co.id=e.dst_id
		LEFT JOIN entity_edges oe ON oe.src_id=p.id
		LEFT JOIN entities oc ON oc.id=oe.dst_id AND oc.type='company'
		GROUP BY p.id, p.canonical_name, e.attrs->>'role', p.attrs->>'image_url', p.attrs->>'linkedin_url'
		ORDER BY p.canonical_name
		LIMIT $2`

	rows, err := s.db.Query(ctx, peopleQuery, stockCode, limit)
	if err != nil {
		return nil, fmt.Errorf("GetStockGraph: people query failed: %w", err)
	}
	defer rows.Close()

	for rows.Next() {
		p := &GraphPersonRow{}
		if err := rows.Scan(
			&p.Name,
			&p.Role,
			&p.ImageURL,
			&p.LinkedInURL,
			&p.AlsoAt,
		); err != nil {
			return nil, fmt.Errorf("GetStockGraph: scan people row: %w", err)
		}
		result.People = append(result.People, p)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("GetStockGraph: iterate people rows: %w", err)
	}

	// ---- Query 2: Similar companies ----
	const similarQuery = `
		SELECT c2.stock_code, c2.canonical_name, COALESCE(cm.industry,''), ee.weight
		FROM entities c1
		JOIN entity_edges ee ON ee.src_id=c1.id AND ee.edge_type='similar_to'
		JOIN entities c2 ON c2.id=ee.dst_id AND c2.type='company'
		LEFT JOIN "company-metadata" cm ON cm.stock_code=c2.stock_code
		WHERE c1.type='company' AND c1.stock_code=$1
		ORDER BY ee.weight DESC LIMIT $2`

	simRows, err := s.db.Query(ctx, similarQuery, stockCode, limit)
	if err != nil {
		return nil, fmt.Errorf("GetStockGraph: similar companies query failed: %w", err)
	}
	defer simRows.Close()

	for simRows.Next() {
		peer := &GraphPeerRow{}
		if err := simRows.Scan(
			&peer.StockCode,
			&peer.CompanyName,
			&peer.Industry,
			&peer.Similarity,
		); err != nil {
			return nil, fmt.Errorf("GetStockGraph: scan similar row: %w", err)
		}
		result.SimilarCompanies = append(result.SimilarCompanies, peer)
	}
	if err := simRows.Err(); err != nil {
		return nil, fmt.Errorf("GetStockGraph: iterate similar rows: %w", err)
	}

	return result, nil
}
