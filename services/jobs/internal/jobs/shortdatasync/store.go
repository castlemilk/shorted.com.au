package shortdatasync

import (
	"context"
	"errors"
	"fmt"
	"log"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
)

// database is the subset of *pgxpool.Pool this job uses. Narrowing it keeps the
// upsert/refresh semantics testable without a live Postgres.
type database interface {
	Exec(ctx context.Context, sql string, args ...any) (pgconn.CommandTag, error)
	Query(ctx context.Context, sql string, args ...any) (pgx.Rows, error)
	QueryRow(ctx context.Context, sql string, args ...any) pgx.Row
}

// pgStore is the Postgres side of the ASIC shorts pipeline.
type pgStore struct {
	db database
}

// upsertShortsSQL is the row write. The conflict target is the
// (DATE, PRODUCT_CODE) unique index, and the update list is EXACTLY the
// Python's: PRODUCT is deliberately NOT refreshed on conflict, so an existing
// row keeps the product name it was first ingested with.
const upsertShortsSQL = `
        INSERT INTO shorts (
            "DATE", "PRODUCT", "PRODUCT_CODE",
            "REPORTED_SHORT_POSITIONS", "TOTAL_PRODUCT_IN_ISSUE",
            "PERCENT_OF_TOTAL_PRODUCT_IN_ISSUE_REPORTED_AS_SHORT_POSITIONS"
        )
        VALUES ($1, $2, $3, $4, $5, $6)
        ON CONFLICT ("DATE", "PRODUCT_CODE") DO UPDATE SET
            "REPORTED_SHORT_POSITIONS" = EXCLUDED."REPORTED_SHORT_POSITIONS",
            "TOTAL_PRODUCT_IN_ISSUE" = EXCLUDED."TOTAL_PRODUCT_IN_ISSUE",
            "PERCENT_OF_TOTAL_PRODUCT_IN_ISSUE_REPORTED_AS_SHORT_POSITIONS" =
                EXCLUDED."PERCENT_OF_TOTAL_PRODUCT_IN_ISSUE_REPORTED_AS_SHORT_POSITIONS"`

// UpsertRows writes one file's rows and returns how many landed.
//
// Deliberately row-at-a-time in AUTOCOMMIT, like the Python: a row that trips a
// constraint is counted as a failure and the file keeps loading. A batch or an
// explicit transaction would abort every remaining row of the file on the first
// bad one — a behaviour change on the load-bearing table, so it is not made
// here. (pgx.Batch is additionally known to wedge on the Supabase transaction
// pooler.)
//
// Cancellation is respected between rows so a SIGTERM stops promptly with the
// already-written rows committed.
func (s *pgStore) UpsertRows(ctx context.Context, rows []shortsRow) (int, error) {
	written := 0
	failed := 0
	for _, r := range rows {
		if err := ctx.Err(); err != nil {
			return written, err
		}
		_, err := s.db.Exec(ctx, upsertShortsSQL,
			r.Date, r.Product, r.ProductCode,
			r.ReportedShortPositions, r.TotalProductInIssue, r.Percent,
		)
		if err != nil {
			if errors.Is(err, context.Canceled) || errors.Is(err, context.DeadlineExceeded) {
				return written, err
			}
			if failed == 0 {
				// Same posture as the Python: log the FIRST error of a file for
				// diagnosis, then stay quiet so a systemic failure cannot flood
				// the run log with one line per row.
				log.Printf("   insert error (first of file): %v", err)
			}
			failed++
			continue
		}
		written++
	}
	if failed > 0 {
		log.Printf("   ⚠️  %d row(s) failed to write", failed)
	}
	return written, nil
}

// LastShortsDate returns MAX("DATE") from shorts, and false when the table is
// empty (the Python's initial-load branch).
func (s *pgStore) LastShortsDate(ctx context.Context) (time.Time, bool, error) {
	var last *time.Time
	if err := s.db.QueryRow(ctx, `SELECT MAX("DATE") FROM shorts`).Scan(&last); err != nil {
		return time.Time{}, false, fmt.Errorf("last shorts date: %w", err)
	}
	if last == nil {
		return time.Time{}, false, nil
	}
	return truncateDay(*last), true, nil
}

// ExistingKeys returns the (date, product_code) pairs already present from
// `from` onwards, used by the shadow run to classify would-insert vs
// would-update WITHOUT writing anything.
func (s *pgStore) ExistingKeys(ctx context.Context, from time.Time) (map[string]struct{}, error) {
	rows, err := s.db.Query(ctx,
		`SELECT "DATE", "PRODUCT_CODE" FROM shorts WHERE "DATE" >= $1`, from)
	if err != nil {
		return nil, fmt.Errorf("existing keys: %w", err)
	}
	defer rows.Close()

	out := map[string]struct{}{}
	for rows.Next() {
		var d time.Time
		var code string
		if err := rows.Scan(&d, &code); err != nil {
			return nil, fmt.Errorf("existing keys: scan: %w", err)
		}
		out[rowKey(truncateDay(d), code)] = struct{}{}
	}
	return out, rows.Err()
}

// healthReport is check_data_health()'s payload.
type healthReport struct {
	TotalStocks int
	Incomplete  int
	Partial     int
	Complete    int
	HealthScore float64
	StaleStocks []staleStock
}

// staleStock is one stock whose price history stopped more than 7 days ago.
type staleStock struct {
	StockCode string
	LastDate  time.Time
}

const healthSummarySQL = `
            SELECT
                COUNT(*) as total_stocks,
                COUNT(CASE WHEN records < 500 THEN 1 END) as incomplete,
                COUNT(CASE WHEN records >= 500 AND records < 2000 THEN 1 END) as partial,
                COUNT(CASE WHEN records >= 2000 THEN 1 END) as complete
            FROM (
                SELECT stock_code, COUNT(*) as records
                FROM stock_prices
                GROUP BY stock_code
            ) sub`

const healthStaleSQL = `
            SELECT stock_code, MAX(date) as last_date
            FROM stock_prices
            GROUP BY stock_code
            HAVING MAX(date) < CURRENT_DATE - INTERVAL '7 days'
            ORDER BY MAX(date) ASC
            LIMIT 10`

// Health reproduces check_data_health(): a read-only completeness report over
// stock_prices. It is kept even though this job no longer syncs prices — the
// block is part of the run's log surface and costs two cheap aggregates.
func (s *pgStore) Health(ctx context.Context) (healthReport, error) {
	var h healthReport
	if err := s.db.QueryRow(ctx, healthSummarySQL).
		Scan(&h.TotalStocks, &h.Incomplete, &h.Partial, &h.Complete); err != nil {
		return healthReport{}, fmt.Errorf("health summary: %w", err)
	}
	rows, err := s.db.Query(ctx, healthStaleSQL)
	if err != nil {
		return healthReport{}, fmt.Errorf("health stale: %w", err)
	}
	defer rows.Close()
	for rows.Next() {
		var st staleStock
		if err := rows.Scan(&st.StockCode, &st.LastDate); err != nil {
			return healthReport{}, fmt.Errorf("health stale: scan: %w", err)
		}
		h.StaleStocks = append(h.StaleStocks, st)
	}
	if err := rows.Err(); err != nil {
		return healthReport{}, err
	}
	h.HealthScore = healthScore(h.Complete, h.TotalStocks)
	return h, nil
}

// healthScore is complete/total as a percentage rounded to 1dp, with the
// Python's max(total,1) guard against a divide-by-zero on an empty table.
func healthScore(complete, total int) float64 {
	denom := total
	if denom < 1 {
		denom = 1
	}
	return round1(float64(complete) / float64(denom) * 100)
}

func round1(f float64) float64 {
	return float64(int64(f*10+0.5)) / 10
}

// refreshAllSQL is ONE statement string on purpose.
//
// Supabase arms a session statement_timeout when the client command starts, so
// it must be cleared on THIS session — a SET inside
// refresh_all_materialized_views() cannot disarm it, and a cancelled refresh
// silently starves every MV after it in the chain (Jul 2026: /statistics and
// /scans served 19-day-old data). Sending the SET and the refresh as ONE
// simple-protocol command keeps them on ONE backend session even through a
// transaction pooler, where two separate Execs may land on different backends.
//
// platform.Connect sets QueryExecModeSimpleProtocol, which is what makes a
// multi-statement Exec legal here — do not "fix" this into two calls.
const refreshAllSQL = `SET statement_timeout = 0; SELECT refresh_all_materialized_views()`

// individualMVs is the fallback chain the Python tried when the aggregate
// function failed, in the same order.
var individualMVs = []string{"mv_treemap_data", "mv_top_shorts", "mv_watchlist_defaults"}

// RefreshMaterializedViews refreshes the read-path MVs, falling back to the
// three individual REFRESH statements when the aggregate function errors.
// Best-effort: a refresh failure is logged and never fails the run (the data is
// already committed; the MVs self-heal on the next cycle).
func (s *pgStore) RefreshMaterializedViews(ctx context.Context) {
	_, err := s.db.Exec(ctx, refreshAllSQL)
	if err == nil {
		for _, mv := range individualMVs {
			log.Printf("   ✅ %s refreshed", mv)
		}
		return
	}
	log.Printf("⚠️ Could not refresh materialized views: %v", err)
	for _, mv := range individualMVs {
		// The same timeout argument applies to each fallback statement.
		if _, err := s.db.Exec(ctx, fmt.Sprintf("SET statement_timeout = 0; REFRESH MATERIALIZED VIEW %s", mv)); err != nil {
			continue
		}
		log.Printf("   ✅ %s refreshed (fallback)", mv)
	}
}

const cleanupStuckSQL = `
        UPDATE sync_status
        SET status = 'failed',
            completed_at = CURRENT_TIMESTAMP,
            error_message = 'Job timed out (cleaned up by next run)'
        WHERE status = 'running'
          AND started_at < NOW() - INTERVAL '5 hours'`

// CleanupStuckRuns marks runs that have been 'running' for over 5 hours as
// failed, so the admin jobs dashboard is not pinned by an abandoned execution.
func (s *pgStore) CleanupStuckRuns(ctx context.Context) (int64, error) {
	tag, err := s.db.Exec(ctx, cleanupStuckSQL)
	if err != nil {
		return 0, fmt.Errorf("cleanup stuck runs: %w", err)
	}
	return tag.RowsAffected(), nil
}

// truncateDay drops the time-of-day component; the shorts "DATE" column is a
// timestamp but is only ever populated at midnight.
func truncateDay(t time.Time) time.Time {
	return time.Date(t.Year(), t.Month(), t.Day(), 0, 0, 0, 0, time.UTC)
}

// rowKey is the (date, code) identity of a shorts row.
func rowKey(d time.Time, code string) string {
	return d.Format("2006-01-02") + "|" + code
}
