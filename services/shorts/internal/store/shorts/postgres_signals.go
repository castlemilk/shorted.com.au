package shorts

import (
	"context"
	"encoding/json"
	"strings"
	"time"
)

// parseCitations unmarshals a JSONB string array into []string (nil on failure).
func parseCitations(b []byte) []string {
	if len(b) == 0 {
		return nil
	}
	var out []string
	if err := json.Unmarshal(b, &out); err != nil {
		return nil
	}
	return out
}

// GetStockSignals returns a stock's reputation/risk signals (adverse + positive)
// from the stock_signals table (populated by the brandbrain-backed collector).
// Adverse signals are ordered by severity (high→low) then confidence; positive by
// confidence. An empty result is normal for stocks not yet swept.
func (s *postgresStore) GetStockSignals(stockCode string, limit int32) (*StockSignalsResult, error) {
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()

	if limit <= 0 {
		limit = 10
	}
	stockCode = strings.ToUpper(strings.TrimSpace(stockCode))

	const query = `
		SELECT polarity, COALESCE(kind,''), headline, COALESCE(detail,''),
		       COALESCE(event_date,''), COALESCE(severity,''), COALESCE(confidence,0),
		       COALESCE(citations, '[]'::jsonb)
		FROM (
			SELECT *, row_number() OVER (
				PARTITION BY polarity
				ORDER BY CASE severity WHEN 'high' THEN 0 WHEN 'medium' THEN 1 WHEN 'low' THEN 2 ELSE 3 END,
				         confidence DESC, fetched_at DESC
			) AS rn
			FROM stock_signals
			WHERE stock_code = $1
		) ranked
		WHERE rn <= $2
		ORDER BY polarity, rn`

	rows, err := s.db.Query(ctx, query, stockCode, limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	result := &StockSignalsResult{}
	for rows.Next() {
		var r StockSignalRow
		var citationsJSON []byte
		if err := rows.Scan(&r.Polarity, &r.Kind, &r.Headline, &r.Detail,
			&r.EventDate, &r.Severity, &r.Confidence, &citationsJSON); err != nil {
			return nil, err
		}
		r.Citations = parseCitations(citationsJSON)
		if r.Polarity == "adverse" {
			result.Adverse = append(result.Adverse, &r)
		} else {
			result.Positive = append(result.Positive, &r)
		}
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	return result, nil
}
