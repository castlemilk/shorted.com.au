package strategies

import (
	"context"
	"errors"
	"fmt"
	"sort"
	"time"

	"cloud.google.com/go/civil"
	"github.com/jackc/pgx/v5"

	"github.com/castlemilk/shorted.com.au/services/pkg/strategy/engine"
)

// The paper track's tables (migration 000159). strategy_paper_trades and
// strategy_paper_equity are the record. strategy_paper_checkpoints holds the
// simulator's state after the last recorded session, one row per version and
// recipe: the state is not an outcome, and nothing reads it but the paper track.

// paperTableNames are the tables the paper phase needs. A database without them
// idles the phase rather than failing the run.
var paperTableNames = []string{"strategy_paper_trades", "strategy_paper_equity", "strategy_paper_checkpoints"}

// paperTablesMissing lists the paper tables the database does not have.
func (s store) paperTablesMissing(ctx context.Context) ([]string, error) {
	var missing []string
	for _, name := range paperTableNames {
		var exists bool
		if err := s.pool.QueryRow(ctx, `SELECT to_regclass('public.' || $1) IS NOT NULL`, name).Scan(&exists); err != nil {
			return nil, fmt.Errorf("check table %s: %w", name, err)
		}
		if !exists {
			missing = append(missing, name)
		}
	}
	return missing, nil
}

// paperCheckpoint is the stored state of one track.
type paperCheckpoint struct {
	AsOf          civil.Date
	Raw           []byte
	EngineVersion string
	StoppedOn     civil.Date
}

// paperCheckpointOf reads a track's checkpoint and checks it against the track's
// equity rows: its as_of must be the newest equity row's session. found is false
// when the track has no checkpoint. A track with equity rows and no checkpoint, or
// a checkpoint that does not match its newest row, is an error for that track.
func (s store) paperCheckpointOf(ctx context.Context, rulesHash, recipeHash string) (paperCheckpoint, bool, error) {
	var (
		asOf    time.Time
		raw     string
		engVer  string
		stopped *time.Time
	)
	err := s.pool.QueryRow(ctx, `
		SELECT as_of, checkpoint::text, engine_version, stopped_on FROM strategy_paper_checkpoints
		 WHERE rules_hash = $1 AND recipe_hash = $2`, rulesHash, recipeHash).Scan(&asOf, &raw, &engVer, &stopped)
	var newest *time.Time
	if err := s.pool.QueryRow(ctx, `
		SELECT max(as_of) FROM strategy_paper_equity WHERE rules_hash = $1 AND recipe_hash = $2`,
		rulesHash, recipeHash).Scan(&newest); err != nil {
		return paperCheckpoint{}, false, fmt.Errorf("read the newest paper equity row: %w", err)
	}
	if errors.Is(err, pgx.ErrNoRows) {
		if newest != nil {
			return paperCheckpoint{}, false, fmt.Errorf("the track has equity rows up to %s and no checkpoint", newest.Format("2006-01-02"))
		}
		return paperCheckpoint{}, false, nil
	}
	if err != nil {
		return paperCheckpoint{}, false, fmt.Errorf("read the paper checkpoint: %w", err)
	}
	cp := paperCheckpoint{AsOf: civil.DateOf(asOf), Raw: []byte(raw), EngineVersion: engVer}
	if stopped != nil {
		cp.StoppedOn = civil.DateOf(*stopped)
	}
	if newest == nil || civil.DateOf(*newest) != cp.AsOf {
		return paperCheckpoint{}, false, fmt.Errorf("checkpoint as_of %s does not match the newest equity row %s", cp.AsOf, dateOrEmpty(newest))
	}
	return cp, true, nil
}

func dateOrEmpty(t *time.Time) string {
	if t == nil {
		return "none"
	}
	return t.Format("2006-01-02")
}

// paperStop records that a superseded track has stopped: no later session is
// stepped on it. Idempotent.
func (s store) paperStop(ctx context.Context, rulesHash, recipeHash string, on civil.Date) error {
	if _, err := s.pool.Exec(ctx, `
		UPDATE strategy_paper_checkpoints SET stopped_on = $3::date, updated_at = now()
		 WHERE rules_hash = $1 AND recipe_hash = $2 AND stopped_on IS NULL`,
		rulesHash, recipeHash, on.String()); err != nil {
		return fmt.Errorf("record the paper track's stop: %w", err)
	}
	return nil
}

// snapshotSessions lists the sessions in [from, to] whose three snapshot phases
// completed, oldest first. The paper track steps only these.
func (s store) snapshotSessions(ctx context.Context, from, to civil.Date) ([]civil.Date, error) {
	rows, err := s.pool.Query(ctx, `
		SELECT as_of FROM strategy_daily_runs
		 WHERE as_of BETWEEN $1::date AND $2::date AND phase = ANY($3) AND status = 'completed'
		 GROUP BY as_of
		HAVING count(DISTINCT phase) = $4
		 ORDER BY as_of`, from.String(), to.String(), snapshotPhases, len(snapshotPhases))
	if err != nil {
		if isUndefinedTable(err) {
			return nil, nil
		}
		return nil, fmt.Errorf("read the complete sessions: %w", err)
	}
	defer rows.Close()
	var out []civil.Date
	for rows.Next() {
		var t time.Time
		if err := rows.Scan(&t); err != nil {
			return nil, fmt.Errorf("scan a complete session: %w", err)
		}
		out = append(out, civil.DateOf(t))
	}
	sort.Slice(out, func(i, j int) bool { return out[i].Before(out[j]) })
	return out, rows.Err()
}

// indexLevelOn is the index's close on or before t, zero when no bar exists on or
// before t. It is the batch's levelOn: a newer bar is never read.
//
// Accepted limitation: the benchmark is read from index_prices at the time of the
// paper step, not from a stored snapshot, so a later re-sync of XJT before t would
// not change a recorded row (rows are never updated) but would change a fresh
// batch run's benchmark. Documented in services/jobs/README.md, "Paper track".
//
// The same holds for the RBA cash rate, read by pgsource.CashRate as of the session
// at step time: a later correction changes a fresh batch run's interest, not a
// recorded row. Documented in services/jobs/README.md, "Paper track".
func (s store) indexLevelOn(ctx context.Context, code string, t civil.Date) (float64, error) {
	var close *float64
	err := s.pool.QueryRow(ctx, `
		SELECT close::float8 FROM index_prices
		 WHERE index_code = $1 AND date <= $2::date
		 ORDER BY date DESC LIMIT 1`, code, t.String()).Scan(&close)
	if errors.Is(err, pgx.ErrNoRows) {
		return 0, nil
	}
	if err != nil {
		return 0, fmt.Errorf("read the %s level on %s: %w", code, t, err)
	}
	if close == nil {
		return 0, nil
	}
	return *close, nil
}

// writePaperStep records one session of one track in one transaction: its trade
// rows, its equity row and the checkpoint the next session starts from.
func (s store) writePaperStep(ctx context.Context, t backtestTarget, strategyID string, out *paperStep) error {
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return fmt.Errorf("begin paper transaction for %s: %w", out.Session, err)
	}
	defer func() { _ = tx.Rollback(context.Background()) }()
	for _, row := range out.Trades {
		if err := applyPaperTrade(ctx, tx, t, strategyID, row); err != nil {
			return err
		}
	}
	var benchmark any
	if out.Benchmark > 0 {
		benchmark = out.Benchmark
	}
	if _, err := tx.Exec(ctx, `
		INSERT INTO strategy_paper_equity (rules_hash, recipe_hash, as_of, equity, cash, positions, benchmark, engine_version)
		VALUES ($1, $2, $3::date, $4, $5, $6, $7, $8)`,
		t.RulesHash, t.RecipeHash, out.Session.String(), out.Equity.Equity, out.Equity.Cash, out.Holds, benchmark, engine.Version); err != nil {
		return fmt.Errorf("insert paper equity %s %s: %w", t.Reg.Label, out.Session, err)
	}
	if _, err := tx.Exec(ctx, `
		INSERT INTO strategy_paper_checkpoints (rules_hash, recipe_hash, as_of, checkpoint, engine_version, updated_at)
		VALUES ($1, $2, $3::date, $4::jsonb, $5, now())
		ON CONFLICT (rules_hash, recipe_hash) DO UPDATE SET
			as_of = EXCLUDED.as_of, checkpoint = EXCLUDED.checkpoint,
			engine_version = EXCLUDED.engine_version, updated_at = now()`,
		t.RulesHash, t.RecipeHash, out.Session.String(), string(out.Raw), engine.Version); err != nil {
		return fmt.Errorf("write the paper checkpoint %s %s: %w", t.Reg.Label, out.Session, err)
	}
	if err := tx.Commit(ctx); err != nil {
		return fmt.Errorf("commit paper %s %s: %w", t.Reg.Label, out.Session, err)
	}
	return nil
}

// applyPaperTrade inserts a trade the first time it is recorded, which must be
// as a pending entry, and afterwards moves it forward along paperPath. A trade
// whose status does not change keeps it, but takes its flags when they grew. A
// row that already has the status and flags it is asked for is left as it is.
func applyPaperTrade(ctx context.Context, tx pgx.Tx, t backtestTarget, strategyID string, row paperTradeRow) error {
	var (
		old      string
		oldFlags []string
	)
	err := tx.QueryRow(ctx, `
		SELECT status, flags FROM strategy_paper_trades
		 WHERE rules_hash = $1 AND recipe_hash = $2 AND stock_code = $3 AND signal_date = $4::date
		 FOR UPDATE`, t.RulesHash, t.RecipeHash, row.Code, row.SignalDate.String()).Scan(&old, &oldFlags)
	if errors.Is(err, pgx.ErrNoRows) {
		if row.Status != "pending_entry" {
			return fmt.Errorf("paper trade %s signal %s is first recorded as %s, not pending_entry", row.Code, row.SignalDate, row.Status)
		}
		if _, err := tx.Exec(ctx, `
			INSERT INTO strategy_paper_trades (strategy_id, rules_hash, recipe_hash, engine_version, stock_code,
				signal_date, entry_date, entry_price, captured_pivot, quantity, exit_signal_date, exit_date,
				exit_price, exit_reason, flags, status, entry_score, sessions_held, gross_return_pct,
				net_return_pct, fees, dividends)
			VALUES ($1, $2, $3, $4, $5, $6::date, $7::date, $8, $9, $10, $11::date, $12::date, $13, $14, $15::text[], $16,
				$17, $18, $19, $20, $21, $22)`,
			strategyID, t.RulesHash, t.RecipeHash, engine.Version, row.Code, row.SignalDate.String(),
			dateOrNilArg(row.EntryDate), optArg(row.HasEntry, row.EntryPrice), optArg(row.HasPivot, row.CapturedPivot),
			optArg(row.HasQuantity, row.Quantity), dateOrNilArg(row.ExitSignalDate), dateOrNilArg(row.ExitDate),
			optArg(row.HasExitPrice, row.ExitPrice), textOrNil(row.ExitReason), flagsArg(row.Flags), row.Status,
			row.EntryScore, closedInt(row), closedFloat(row, row.GrossPct), closedFloat(row, row.NetPct),
			closedFloat(row, row.Fees), closedFloat(row, row.Dividends)); err != nil {
			return fmt.Errorf("insert paper trade %s signal %s: %w", row.Code, row.SignalDate, err)
		}
		return nil
	}
	if err != nil {
		return fmt.Errorf("read paper trade %s signal %s: %w", row.Code, row.SignalDate, err)
	}
	if old == row.Status {
		if sameFlags(oldFlags, row.Flags) {
			return nil
		}
		return updatePaperFlags(ctx, tx, t, row)
	}
	path, ok := paperPath(old, row.Status)
	if !ok {
		return fmt.Errorf("paper trade %s signal %s moves %s -> %s, which the lifecycle does not allow", row.Code, row.SignalDate, old, row.Status)
	}
	for i, status := range path {
		step := row
		step.Status = status
		if i < len(path)-1 {
			// The fill is recorded before the move it is followed by: the exit's and
			// the close's fields belong to the later row.
			step = openStep(step)
		}
		if err := updatePaperTrade(ctx, tx, t, step); err != nil {
			return err
		}
	}
	return nil
}

// openStep is a row as the open status records it: the entry and the position,
// without the exit or the economics that only a close carries.
func openStep(r paperTradeRow) paperTradeRow {
	r.ExitSignalDate, r.ExitDate = civil.Date{}, civil.Date{}
	r.HasExitPrice, r.ExitPrice, r.ExitReason = false, 0, ""
	r.Closed = false
	r.SessionsHeld, r.GrossPct, r.NetPct, r.Fees, r.Dividends = 0, 0, 0, 0, 0
	return r
}

// updatePaperTrade moves a recorded trade to the row's status. A field the row
// does not carry keeps the value it has, and the flags are the row's when it
// carries any.
func updatePaperTrade(ctx context.Context, tx pgx.Tx, t backtestTarget, row paperTradeRow) error {
	if _, err := tx.Exec(ctx, `
		UPDATE strategy_paper_trades SET
			status = $5,
			entry_date = COALESCE($6::date, entry_date),
			entry_price = COALESCE($7, entry_price),
			captured_pivot = COALESCE($8, captured_pivot),
			quantity = COALESCE($9, quantity),
			exit_signal_date = COALESCE($10::date, exit_signal_date),
			exit_date = COALESCE($11::date, exit_date),
			exit_price = COALESCE($12, exit_price),
			exit_reason = COALESCE($13, exit_reason),
			flags = CASE WHEN cardinality($14::text[]) > 0 THEN $14::text[] ELSE flags END,
			entry_score = COALESCE($15, entry_score),
			sessions_held = COALESCE($16, sessions_held),
			gross_return_pct = COALESCE($17, gross_return_pct),
			net_return_pct = COALESCE($18, net_return_pct),
			fees = COALESCE($19, fees),
			dividends = COALESCE($20, dividends),
			updated_at = now()
		 WHERE rules_hash = $1 AND recipe_hash = $2 AND stock_code = $3 AND signal_date = $4::date`,
		t.RulesHash, t.RecipeHash, row.Code, row.SignalDate.String(), row.Status,
		dateOrNilArg(row.EntryDate), optArg(row.HasEntry, row.EntryPrice), optArg(row.HasPivot, row.CapturedPivot),
		optArg(row.HasQuantity, row.Quantity), dateOrNilArg(row.ExitSignalDate), dateOrNilArg(row.ExitDate),
		optArg(row.HasExitPrice, row.ExitPrice), textOrNil(row.ExitReason), flagsArg(row.Flags),
		row.EntryScore, closedInt(row), closedFloat(row, row.GrossPct), closedFloat(row, row.NetPct),
		closedFloat(row, row.Fees), closedFloat(row, row.Dividends)); err != nil {
		return fmt.Errorf("move paper trade %s signal %s to %s: %w", row.Code, row.SignalDate, row.Status, err)
	}
	return nil
}

// updatePaperFlags sets a trade's flags without moving its status.
func updatePaperFlags(ctx context.Context, tx pgx.Tx, t backtestTarget, row paperTradeRow) error {
	if _, err := tx.Exec(ctx, `
		UPDATE strategy_paper_trades SET flags = $5::text[], updated_at = now()
		 WHERE rules_hash = $1 AND recipe_hash = $2 AND stock_code = $3 AND signal_date = $4::date`,
		t.RulesHash, t.RecipeHash, row.Code, row.SignalDate.String(), flagsArg(row.Flags)); err != nil {
		return fmt.Errorf("update the flags of paper trade %s signal %s: %w", row.Code, row.SignalDate, err)
	}
	return nil
}

// sameFlags reports whether two flag sets hold the same flags.
func sameFlags(a, b []string) bool {
	if len(a) != len(b) {
		return false
	}
	x := append([]string(nil), a...)
	y := append([]string(nil), b...)
	sort.Strings(x)
	sort.Strings(y)
	for i := range x {
		if x[i] != y[i] {
			return false
		}
	}
	return true
}

// closedFloat is v for a closed trade, NULL otherwise.
func closedFloat(r paperTradeRow, v float64) any {
	if !r.Closed {
		return nil
	}
	return v
}

// closedInt is the sessions a closed trade was held, NULL otherwise.
func closedInt(r paperTradeRow) any {
	if !r.Closed {
		return nil
	}
	return r.SessionsHeld
}

// optArg is v as a query argument, or NULL when it is not present.
func optArg(present bool, v float64) any {
	if !present {
		return nil
	}
	return v
}

// flagsArg is a trade's flags as a text array, never NULL.
func flagsArg(flags []string) []string {
	if flags == nil {
		return []string{}
	}
	return flags
}

// snapshotCARecorded reports whether a session's feature rows were all written after
// the corporate-action suspects were stored: each carries the ca_known key. A
// session with no rows reads false.
func (s store) snapshotCARecorded(ctx context.Context, d civil.Date) (bool, error) {
	var all *bool
	if err := s.pool.QueryRow(ctx, `
		SELECT bool_and(features ? 'ca_known') FROM strategy_features_daily
		 WHERE as_of = $1::date AND feature_set = $2`, d.String(), snapshotFeatureSet).Scan(&all); err != nil {
		return false, fmt.Errorf("read the ca_known rows of %s: %w", d, err)
	}
	return all != nil && *all, nil
}
