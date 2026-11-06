package strategies

import (
	"context"
	"errors"
	"fmt"
	"time"

	"cloud.google.com/go/civil"
	"github.com/jackc/pgx/v5"

	"github.com/castlemilk/shorted.com.au/services/pkg/strategy/engine"
)

// The paper track's tables (migration 000159). strategy_paper_trades and
// strategy_paper_equity are the record. strategy_paper_checkpoints holds the
// simulator's state after the last recorded session, one row per version and
// recipe, replaced by each session's: the simulator's carried state is not an
// outcome, and nothing reads it but the paper track.

// paperCheckpoint is the stored state of one track.
type paperCheckpoint struct {
	AsOf civil.Date
	Raw  []byte
}

// paperCheckpointOf reads a track's checkpoint. found is false when the track
// has none yet, including when the table does not exist (a database that has not
// applied 000159): the track then starts from its live_from.
func (s store) paperCheckpoint(ctx context.Context, rulesHash, recipeHash string) (paperCheckpoint, bool, error) {
	var (
		asOf time.Time
		raw  string
	)
	err := s.pool.QueryRow(ctx, `
		SELECT as_of, checkpoint::text FROM strategy_paper_checkpoints
		 WHERE rules_hash = $1 AND recipe_hash = $2`, rulesHash, recipeHash).Scan(&asOf, &raw)
	if errors.Is(err, pgx.ErrNoRows) || isUndefinedTable(err) {
		return paperCheckpoint{}, false, nil
	}
	if err != nil {
		return paperCheckpoint{}, false, fmt.Errorf("read the paper checkpoint: %w", err)
	}
	return paperCheckpoint{AsOf: civil.DateOf(asOf), Raw: []byte(raw)}, true, nil
}

// paperRecordedAsOf is, per rules hash, the newest session the paper track has
// recorded, over its recipes: the earliest of them when a version has several.
// A version with no recorded session is absent from the map.
func (s store) paperRecordedAsOf(ctx context.Context) (map[string]civil.Date, error) {
	rows, err := s.pool.Query(ctx, `
		SELECT rules_hash, min(last_as_of) FROM (
		  SELECT rules_hash, recipe_hash, max(as_of) AS last_as_of
		    FROM strategy_paper_equity GROUP BY rules_hash, recipe_hash
		) per_recipe
		GROUP BY rules_hash`)
	if err != nil {
		if isUndefinedTable(err) {
			return map[string]civil.Date{}, nil
		}
		return nil, fmt.Errorf("read the paper track's recorded sessions: %w", err)
	}
	defer rows.Close()
	out := map[string]civil.Date{}
	for rows.Next() {
		var (
			hash string
			last time.Time
		)
		if err := rows.Scan(&hash, &last); err != nil {
			return nil, fmt.Errorf("scan the paper track's recorded session: %w", err)
		}
		out[hash] = civil.DateOf(last)
	}
	return out, rows.Err()
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
	if _, err := tx.Exec(ctx, `
		INSERT INTO strategy_paper_equity (rules_hash, recipe_hash, as_of, equity, cash, positions, benchmark)
		VALUES ($1, $2, $3::date, $4, $5, $6, NULL)`,
		t.RulesHash, t.RecipeHash, out.Session.String(), out.Equity.Equity, out.Equity.Cash, out.Holds); err != nil {
		return fmt.Errorf("insert paper equity %s %s: %w", t.Reg.Label, out.Session, err)
	}
	if _, err := tx.Exec(ctx, `
		INSERT INTO strategy_paper_checkpoints (rules_hash, recipe_hash, as_of, checkpoint, updated_at)
		VALUES ($1, $2, $3::date, $4::jsonb, now())
		ON CONFLICT (rules_hash, recipe_hash) DO UPDATE SET
			as_of = EXCLUDED.as_of, checkpoint = EXCLUDED.checkpoint, updated_at = now()`,
		t.RulesHash, t.RecipeHash, out.Session.String(), string(out.Raw)); err != nil {
		return fmt.Errorf("write the paper checkpoint %s %s: %w", t.Reg.Label, out.Session, err)
	}
	if err := tx.Commit(ctx); err != nil {
		return fmt.Errorf("commit paper %s %s: %w", t.Reg.Label, out.Session, err)
	}
	return nil
}

// applyPaperTrade inserts a trade the first time it is recorded, which must be
// as a pending entry, and afterwards moves it forward along paperPath. A row that
// already has the status it is asked for is left as it is.
func applyPaperTrade(ctx context.Context, tx pgx.Tx, t backtestTarget, strategyID string, row paperTradeRow) error {
	var old string
	err := tx.QueryRow(ctx, `
		SELECT status FROM strategy_paper_trades
		 WHERE rules_hash = $1 AND recipe_hash = $2 AND stock_code = $3 AND signal_date = $4::date
		 FOR UPDATE`, t.RulesHash, t.RecipeHash, row.Code, row.SignalDate.String()).Scan(&old)
	if errors.Is(err, pgx.ErrNoRows) {
		if row.Status != "pending_entry" {
			return fmt.Errorf("paper trade %s signal %s is first recorded as %s, not pending_entry", row.Code, row.SignalDate, row.Status)
		}
		if _, err := tx.Exec(ctx, `
			INSERT INTO strategy_paper_trades (strategy_id, rules_hash, recipe_hash, engine_version, stock_code,
				signal_date, entry_date, entry_price, captured_pivot, quantity, exit_signal_date, exit_date,
				exit_price, exit_reason, flags, status)
			VALUES ($1, $2, $3, $4, $5, $6::date, $7::date, $8, $9, $10, $11::date, $12::date, $13, $14, $15::text[], $16)`,
			strategyID, t.RulesHash, t.RecipeHash, engine.Version, row.Code, row.SignalDate.String(),
			dateOrNilArg(row.EntryDate), optArg(row.HasEntry, row.EntryPrice), optArg(row.HasPivot, row.CapturedPivot),
			optArg(row.HasQuantity, row.Quantity), dateOrNilArg(row.ExitSignalDate), dateOrNilArg(row.ExitDate),
			optArg(row.HasExitPrice, row.ExitPrice), textOrNil(row.ExitReason), flagsArg(row.Flags), row.Status); err != nil {
			return fmt.Errorf("insert paper trade %s signal %s: %w", row.Code, row.SignalDate, err)
		}
		return nil
	}
	if err != nil {
		return fmt.Errorf("read paper trade %s signal %s: %w", row.Code, row.SignalDate, err)
	}
	if old == row.Status {
		return nil
	}
	path, ok := paperPath(old, row.Status)
	if !ok {
		return fmt.Errorf("paper trade %s signal %s moves %s -> %s, which the lifecycle does not allow", row.Code, row.SignalDate, old, row.Status)
	}
	for i, status := range path {
		step := row
		step.Status = status
		if status == "open" && i < len(path)-1 {
			// The fill is recorded before the exit it is followed by: the exit's
			// fields belong to the later row.
			step.ExitSignalDate, step.ExitDate = civil.Date{}, civil.Date{}
			step.HasExitPrice, step.ExitReason = false, ""
		}
		if err := updatePaperTrade(ctx, tx, t, step); err != nil {
			return err
		}
	}
	return nil
}

// updatePaperTrade moves a recorded trade to the row's status. A field the row
// does not carry keeps the value it has.
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
			updated_at = now()
		 WHERE rules_hash = $1 AND recipe_hash = $2 AND stock_code = $3 AND signal_date = $4::date`,
		t.RulesHash, t.RecipeHash, row.Code, row.SignalDate.String(), row.Status,
		dateOrNilArg(row.EntryDate), optArg(row.HasEntry, row.EntryPrice), optArg(row.HasPivot, row.CapturedPivot),
		optArg(row.HasQuantity, row.Quantity), dateOrNilArg(row.ExitSignalDate), dateOrNilArg(row.ExitDate),
		optArg(row.HasExitPrice, row.ExitPrice), textOrNil(row.ExitReason), flagsArg(row.Flags)); err != nil {
		return fmt.Errorf("move paper trade %s signal %s to %s: %w", row.Code, row.SignalDate, row.Status, err)
	}
	return nil
}

// writePaperRunDone records the paper phase of a session complete.
func (s store) writePaperRunDone(ctx context.Context, d civil.Date, hashes []string, stepped int) error {
	counts, err := counts(map[string]any{"tracks": len(hashes), "stepped": stepped})
	if err != nil {
		return err
	}
	return s.writeRun(ctx, s.pool, runRow{
		AsOf: d, Phase: phasePaper, Status: "completed", EngineVersion: engine.Version,
		RulesHashes: hashes, Counts: counts,
	})
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
