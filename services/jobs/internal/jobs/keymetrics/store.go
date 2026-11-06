package keymetrics

import (
	"context"
	"encoding/json"
	"fmt"

	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/castlemilk/shorted.com.au/services/pkg/keymetrics"
)

// quotedWithinDays is how recently a stock must have a price row to stay in the
// universe. Yahoo answers a delisted ASX code with no quote, and such a code
// never gets a stamp, so it would sort first on every run and eat the budget.
// Ninety days is wide enough that a stalled price sweep does not empty the
// universe, and narrow enough that the ~2,100 codes with no price at all (the
// dead block) are never requested. It is served by idx_stock_prices_stock_date.
const quotedWithinDays = 90

// pgStore is the Postgres Store. Its one write is a single UPDATE per stock.
type pgStore struct {
	pool *pgxpool.Pool
}

// Universe implements Store. The codes come back as stored (a padded code is
// kept padded, so its own row is the one UPDATE stamps). The ORDER BY is the
// refresh order: never written first, then the oldest, then code.
func (s *pgStore) Universe(ctx context.Context) ([]Stock, error) {
	rows, err := s.pool.Query(ctx, `
		SELECT cm.stock_code, cm.key_metrics_updated_at
		FROM "company-metadata" cm
		WHERE cm.stock_code IS NOT NULL
		  AND EXISTS (
		      SELECT 1 FROM stock_prices sp
		      WHERE sp.stock_code = cm.stock_code
		        AND sp.date >= CURRENT_DATE - $1::int)
		ORDER BY cm.key_metrics_updated_at ASC NULLS FIRST, cm.stock_code`, quotedWithinDays)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var out []Stock
	for rows.Next() {
		var st Stock
		if err := rows.Scan(&st.Code, &st.UpdatedAt); err != nil {
			return nil, err
		}
		out = append(out, st)
	}
	return out, rows.Err()
}

// WriteKeyMetrics implements Store. The metric keys are sanitised exactly as the
// API's guard sanitised them (±Inf and NaN dropped before they reach JSONB).
// stock_code is not a metric and is kept whatever its value: a code spelled
// NAN or INF is still the stock's code, not a non-finite number.
func (s *pgStore) WriteKeyMetrics(ctx context.Context, code string, metrics map[string]any) error {
	stockCode, hasCode := metrics["stock_code"]
	metricsOnly := make(map[string]any, len(metrics))
	for k, v := range metrics {
		if k != "stock_code" {
			metricsOnly[k] = v
		}
	}
	body := keymetrics.Sanitise(metricsOnly)
	if body == nil {
		body = map[string]any{}
	}
	if hasCode {
		body["stock_code"] = stockCode
	}
	// The JSON goes as a string: under simple protocol (buildDBPoolConfig) a
	// []byte parameter is sent as bytea, which the jsonb cast refuses.
	encoded, err := json.Marshal(body)
	if err != nil {
		return fmt.Errorf("key-metrics: marshal %s: %w", code, err)
	}
	tag, err := s.pool.Exec(ctx, `
		UPDATE "company-metadata"
		SET key_metrics = $2::jsonb,
		    key_metrics_updated_at = CURRENT_TIMESTAMP
		WHERE stock_code = $1`, code, string(encoded))
	if err != nil {
		return fmt.Errorf("key-metrics: update %s: %w", code, err)
	}
	if tag.RowsAffected() == 0 {
		return fmt.Errorf("key-metrics: stock not found: %s", code)
	}
	return nil
}
