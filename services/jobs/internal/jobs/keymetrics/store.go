package keymetrics

import (
	"context"
	"encoding/json"
	"fmt"

	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/castlemilk/shorted.com.au/services/pkg/keymetrics"
)

// pgStore is the Postgres Store. Its one write is a single UPDATE per stock.
type pgStore struct {
	pool *pgxpool.Pool
}

// Universe implements Store. The ORDER BY is the refresh order (order() sorts
// the same way, so the job does not depend on it).
func (s *pgStore) Universe(ctx context.Context) ([]Stock, error) {
	rows, err := s.pool.Query(ctx, `
		SELECT stock_code, key_metrics_updated_at
		FROM "company-metadata"
		WHERE stock_code IS NOT NULL
		ORDER BY key_metrics_updated_at ASC NULLS FIRST, stock_code`)
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

// WriteKeyMetrics implements Store. The map is sanitised exactly as the API's
// guard sanitised it: ±Inf and NaN keys are dropped before they reach JSONB.
func (s *pgStore) WriteKeyMetrics(ctx context.Context, code string, metrics map[string]any) error {
	// The JSON goes as a string: under simple protocol (buildDBPoolConfig) a
	// []byte parameter is sent as bytea, which the jsonb cast refuses.
	body, err := json.Marshal(keymetrics.Sanitise(metrics))
	if err != nil {
		return fmt.Errorf("key-metrics: marshal %s: %w", code, err)
	}
	tag, err := s.pool.Exec(ctx, `
		UPDATE "company-metadata"
		SET key_metrics = $2::jsonb,
		    key_metrics_updated_at = CURRENT_TIMESTAMP
		WHERE stock_code = $1`, code, string(body))
	if err != nil {
		return fmt.Errorf("key-metrics: update %s: %w", code, err)
	}
	if tag.RowsAffected() == 0 {
		return fmt.Errorf("key-metrics: stock not found: %s", code)
	}
	return nil
}
