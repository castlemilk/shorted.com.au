package strategies

import (
	"context"
	"fmt"
	"time"

	"cloud.google.com/go/civil"
	"github.com/jackc/pgx/v5/pgxpool"
)

// Retention of the snapshot (9.9). Feature rows are kept for the newest
// keepSessions completed sessions and for as long as the paper track has not yet
// read them; the events for three years. The cut-off is computed here, never in
// SQL, so the statements take one date each.

// keepSessions is how many completed sessions of feature rows are kept.
const keepSessions = 15

// eventRetentionYears is how long signal events are kept.
const eventRetentionYears = 3

// pruneStatementTimeout bounds each prune statement, which runs in its own transaction.
const pruneStatementTimeout = 60 * time.Second

// pruneCutoff is the date before which feature rows are deleted. completed is
// the completed sessions, newest first. The cut-off is the earlier of the
// keepSessions-th newest completed session and the earliest paper guard. Fewer
// than keepSessions completed sessions means nothing is old enough to delete: the
// zero date is returned. A nil guard list is no guard.
func pruneCutoff(completed []civil.Date, guards []civil.Date) civil.Date {
	if len(completed) < keepSessions {
		return civil.Date{}
	}
	cut := completed[keepSessions-1]
	for _, g := range guards {
		if g.Before(cut) {
			cut = g
		}
	}
	return cut
}

// paperGuardSessions is, for each live canonical version except v0, the session
// before its first live session, from the data calendar. The paper track (PR-15)
// will replace this with the newest session it has recorded; until then the
// guard keeps the session the track's first step reads. A version with no
// live_from has no guard.
func paperGuardSessions(liveFrom map[string]civil.Date, labels map[string]string) []civil.Date {
	var out []civil.Date
	for hash, from := range liveFrom {
		if labels[hash] == "v0" || from.IsZero() {
			continue
		}
		out = append(out, prevTradingDay(from))
	}
	sortDates(out)
	return out
}

// pruneRun deletes the snapshot rows the cut-off and the retention rules no
// longer need. Each statement runs in its own transaction with its own timeout,
// so a long one cannot hold the others.
func pruneRun(ctx context.Context, pool *pgxpool.Pool, cutoff civil.Date, logf func(string, ...any)) error {
	if cutoff.IsZero() {
		logf("strategies: prune: fewer than %d completed sessions, nothing to delete", keepSessions)
		return nil
	}
	statements := []struct {
		name string
		sql  string
		args []any
	}{
		{"feature rows", `DELETE FROM strategy_features_daily WHERE as_of < $1::date`, []any{cutoff.String()}},
		{"fundamentals blobs", `DELETE FROM strategy_fundamentals_blobs b
		   WHERE NOT EXISTS (SELECT 1 FROM strategy_features_daily f WHERE f.fundamentals_hash = b.hash)`, nil},
		{"signal events", fmt.Sprintf(`DELETE FROM strategy_signal_events WHERE as_of < current_date - interval '%d years'`, eventRetentionYears), nil},
	}
	for _, st := range statements {
		n, err := execWithTimeout(ctx, pool, st.sql, st.args...)
		if err != nil {
			return fmt.Errorf("prune %s: %w", st.name, err)
		}
		logf("strategies: prune %s: %d row(s) removed (feature rows before %s)", st.name, n, cutoff)
	}
	return nil
}

// execWithTimeout runs one statement in its own transaction under pruneStatementTimeout.
func execWithTimeout(ctx context.Context, pool *pgxpool.Pool, sql string, args ...any) (int64, error) {
	tctx, cancel := context.WithTimeout(ctx, pruneStatementTimeout)
	defer cancel()
	tx, err := pool.Begin(tctx)
	if err != nil {
		return 0, err
	}
	defer func() { _ = tx.Rollback(context.Background()) }()
	if _, err := tx.Exec(tctx, `SET LOCAL statement_timeout = '60s'`); err != nil {
		return 0, err
	}
	tag, err := tx.Exec(tctx, sql, args...)
	if err != nil {
		return 0, err
	}
	if err := tx.Commit(tctx); err != nil {
		return 0, err
	}
	return tag.RowsAffected(), nil
}
