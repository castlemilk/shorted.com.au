package signals

import (
	"context"
	"fmt"
	"strconv"
	"strings"

	"github.com/jackc/pgx/v5/pgxpool"
)

// stock is one selected sweep target.
type stock struct {
	Code        string
	CompanyName string
}

// pgStore is the Postgres implementation of the signal read/write paths.
type pgStore struct {
	pool *pgxpool.Pool
}

// selectStocksSQL builds collect.py's select_stocks query.
//
// Both variants skip stocks swept inside the max-age window and require a
// company name (brandbrain resolves by name, not ticker):
//
//   - top-shorted: joined to mv_top_shorts, most-shorted first.
//   - enriched:    all companies, enriched (enhanced_summary) first, then by code.
//
// The interval is parameterised, never interpolated.
func selectStocksSQL(priority string) string {
	join, order := "", "ORDER BY (cm.enhanced_summary IS NOT NULL) DESC, cm.stock_code"
	if priority == priorityTopShorted {
		join = "JOIN mv_top_shorts t ON t.product_code = cm.stock_code"
		order = "ORDER BY t.current_percent DESC NULLS LAST"
	}
	return fmt.Sprintf(`
        SELECT cm.stock_code, cm.company_name
        FROM "company-metadata" cm
        %s
        WHERE COALESCE(cm.company_name,'') <> ''
          AND NOT EXISTS (
            SELECT 1 FROM stock_signals_runs r
            WHERE r.stock_code = cm.stock_code
              AND r.last_fetched_at > now() - ($1 || ' days')::interval
          )
        %s
        LIMIT $2
    `, join, order)
}

// SelectStocks returns the sweep targets in priority order.
func (s *pgStore) SelectStocks(ctx context.Context, priority string, limit, maxAgeDays int) ([]stock, error) {
	rows, err := s.pool.Query(ctx, selectStocksSQL(priority), strconv.Itoa(maxAgeDays), limit)
	if err != nil {
		return nil, fmt.Errorf("query: %w", err)
	}
	defer rows.Close()

	var out []stock
	for rows.Next() {
		var st stock
		if err := rows.Scan(&st.Code, &st.CompanyName); err != nil {
			return nil, fmt.Errorf("scan: %w", err)
		}
		out = append(out, st)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("iterate: %w", err)
	}
	return out, nil
}

// Store upserts a stock's signals and stamps its sweep row, in one transaction
// (collect.py held a lock around both statements and committed once). A stock
// with zero signals still gets its stock_signals_runs row stamped, so an issuer
// with nothing to report is not re-swept every run.
func (s *pgStore) Store(ctx context.Context, stockCode string, rows []signalRow) error {
	adverse, positive := countPolarities(rows)

	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return fmt.Errorf("begin: %w", err)
	}
	defer func() { _ = tx.Rollback(ctx) }() // no-op once committed

	// A payload can repeat a headline within one polarity, which collapses to
	// one content_hash. Postgres rejects a multi-row upsert that touches the
	// same conflict target twice ("cannot affect row a second time"), which in
	// collect.py failed the whole stock; keeping the LAST occurrence gives the
	// same end state as sequential upserts.
	rows = dedupeByHash(rows)
	if len(rows) > 0 {
		sql, args := insertSignalsSQL(rows)
		if _, err := tx.Exec(ctx, sql, args...); err != nil {
			return fmt.Errorf("insert signals for %s: %w", stockCode, err)
		}
	}

	if _, err := tx.Exec(ctx, `
        INSERT INTO stock_signals_runs (stock_code, last_fetched_at, adverse_count, positive_count)
        VALUES ($1, now(), $2, $3)
        ON CONFLICT (stock_code) DO UPDATE SET
          last_fetched_at = now(), adverse_count = EXCLUDED.adverse_count,
          positive_count = EXCLUDED.positive_count`,
		stockCode, adverse, positive); err != nil {
		return fmt.Errorf("stamp run for %s: %w", stockCode, err)
	}

	if err := tx.Commit(ctx); err != nil {
		return fmt.Errorf("commit %s: %w", stockCode, err)
	}
	return nil
}

// signalInsertColumns is the column list (and therefore the per-row placeholder
// order) of the stock_signals upsert.
const signalInsertColumns = `stock_code, polarity, kind, headline, detail, event_date, severity,
                    citations, confidence, content_hash`

// insertSignalsSQL builds the multi-row upsert psycopg2's execute_values built
// from the same template. Every value is a bind parameter; only the placeholder
// text is generated.
func insertSignalsSQL(rows []signalRow) (string, []any) {
	const cols = 10
	var (
		values = make([]string, 0, len(rows))
		args   = make([]any, 0, len(rows)*cols)
	)
	for i, r := range rows {
		b := i * cols
		values = append(values, fmt.Sprintf("($%d,$%d,$%d,$%d,$%d,$%d,$%d,$%d::jsonb,$%d,$%d)",
			b+1, b+2, b+3, b+4, b+5, b+6, b+7, b+8, b+9, b+10))
		args = append(args,
			r.StockCode, r.Polarity, r.Kind, r.Headline, r.Detail,
			r.EventDate, r.Severity, r.Citations, r.Confidence, r.ContentHash)
	}
	sql := `INSERT INTO stock_signals
                   (` + signalInsertColumns + `)
                   VALUES ` + strings.Join(values, ",") + `
                   ON CONFLICT (stock_code, content_hash) DO UPDATE SET
                     detail = EXCLUDED.detail, severity = EXCLUDED.severity,
                     citations = EXCLUDED.citations, confidence = EXCLUDED.confidence,
                     fetched_at = now()`
	return sql, args
}

// dedupeByHash keeps the last row per content_hash, preserving first-seen order.
func dedupeByHash(rows []signalRow) []signalRow {
	if len(rows) < 2 {
		return rows
	}
	pos := make(map[string]int, len(rows))
	out := make([]signalRow, 0, len(rows))
	for _, r := range rows {
		if i, seen := pos[r.ContentHash]; seen {
			out[i] = r
			continue
		}
		pos[r.ContentHash] = len(out)
		out = append(out, r)
	}
	return out
}
