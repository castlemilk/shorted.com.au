package shorts

import (
	"context"
	"errors"
	"fmt"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
)

// StrategyStatusAdminStore is the read-only view of the strategy engine's daily
// snapshot that the admin status tool reads. Every field is an aggregate or a
// session's own facts: no user identifier, no email address, no subscription.
type StrategyStatusAdminStore interface {
	StrategyDailyStatus(ctx context.Context, sessions int) (StrategyDailyStatus, error)
}

// StrategyDailyStatus is the daily job's state over the newest sessions.
type StrategyDailyStatus struct {
	// Sessions are the phase rows of the newest sessions, newest session first.
	Sessions []StrategyPhaseRow
	// LateLast30 counts sessions in the last 30 days the job backfilled (counts.late).
	LateLast30 int64
	// LastCompleted is the newest session whose every phase completed; "" when none.
	LastCompleted string
	// Versions are the canonical versions the database records, label and status only.
	Versions []StrategyVersionRow
	// Tables are the snapshot tables' estimated row counts and sizes in bytes.
	Tables []StrategyTableRow
	// Migrated is false when the snapshot tables do not exist yet (000156 not applied).
	Migrated bool
	// BacktestQueue is the request queue's length by kind and status (queued and running only).
	BacktestQueue []StrategyBacktestQueueRow
	// BacktestRuns are the newest canonical backtest runs; empty before 000158.
	BacktestRuns []StrategyBacktestRunRow
}

// StrategyPhaseRow is one phase of one session.
type StrategyPhaseRow struct {
	AsOf   string
	Phase  string
	Status string
	Note   string
	// Counts is the run's counts object as stored (aggregates the job writes).
	Counts string
}

// StrategyVersionRow is one canonical version: its strategy, label and status.
type StrategyVersionRow struct {
	StrategyID string
	Label      string
	Status     string
	LiveFrom   string
}

// StrategyTableRow is one snapshot table's size.
type StrategyTableRow struct {
	Name      string
	RowsEst   int64
	SizeBytes int64
}

// StrategyDailyStatus reads the newest `sessions` sessions' phases, the late
// count, the last complete session, the canonical versions and the table sizes.
// A database without 000156 answers Migrated=false, not an error.
func (s *postgresStore) StrategyDailyStatus(ctx context.Context, sessions int) (StrategyDailyStatus, error) {
	if sessions < 1 {
		sessions = 1
	}
	var out StrategyDailyStatus
	err := s.crawlOpsRead(ctx, func(tx pgx.Tx) error {
		rows, err := tx.Query(ctx, `
			SELECT as_of::text, phase, status, COALESCE(note, ''), COALESCE(counts::text, '{}')
			  FROM strategy_daily_runs
			 WHERE as_of IN (SELECT DISTINCT as_of FROM strategy_daily_runs ORDER BY as_of DESC LIMIT $1)
			 ORDER BY as_of DESC, phase`, sessions)
		if err != nil {
			return err
		}
		for rows.Next() {
			var r StrategyPhaseRow
			if err := rows.Scan(&r.AsOf, &r.Phase, &r.Status, &r.Note, &r.Counts); err != nil {
				rows.Close()
				return err
			}
			out.Sessions = append(out.Sessions, r)
		}
		rows.Close()
		if err := rows.Err(); err != nil {
			return err
		}
		out.Migrated = true

		var last *time.Time
		if err := tx.QueryRow(ctx, `
			SELECT max(as_of) FROM (
			  SELECT as_of FROM strategy_daily_runs WHERE status = 'completed'
			  GROUP BY as_of HAVING count(DISTINCT phase) = 3) complete`).Scan(&last); err != nil {
			return err
		}
		if last != nil {
			out.LastCompleted = last.Format("2006-01-02")
		}

		if err := tx.QueryRow(ctx, `
			SELECT count(DISTINCT as_of) FROM strategy_daily_runs
			 WHERE as_of >= current_date - 30 AND counts->>'late' = 'true'`).Scan(&out.LateLast30); err != nil {
			return err
		}

		vrows, err := tx.Query(ctx, `
			SELECT strategy_id, label, status, COALESCE(to_char(live_from, 'YYYY-MM-DD'), '')
			  FROM strategy_rule_versions WHERE kind = 'canonical' ORDER BY strategy_id, live_from DESC NULLS LAST`)
		if err != nil {
			return err
		}
		for vrows.Next() {
			var v StrategyVersionRow
			if err := vrows.Scan(&v.StrategyID, &v.Label, &v.Status, &v.LiveFrom); err != nil {
				vrows.Close()
				return err
			}
			out.Versions = append(out.Versions, v)
		}
		vrows.Close()
		if err := vrows.Err(); err != nil {
			return err
		}

		trows, err := tx.Query(ctx, `
			SELECT relname, n_live_tup, pg_total_relation_size(relid)
			  FROM pg_stat_user_tables WHERE relname LIKE 'strategy\_%' ORDER BY relname`)
		if err != nil {
			return err
		}
		for trows.Next() {
			var t StrategyTableRow
			if err := trows.Scan(&t.Name, &t.RowsEst, &t.SizeBytes); err != nil {
				trows.Close()
				return err
			}
			out.Tables = append(out.Tables, t)
		}
		trows.Close()
		return trows.Err()
	})
	if err != nil {
		var pgErr *pgconn.PgError
		if errors.As(err, &pgErr) && pgErr.Code == "42P01" {
			return StrategyDailyStatus{}, nil
		}
		return StrategyDailyStatus{}, fmt.Errorf("read strategy daily status: %w", err)
	}
	if err := s.strategyBacktestStatus(ctx, &out); err != nil {
		return StrategyDailyStatus{}, err
	}
	return out, nil
}
