package shorts

import (
	"context"
	"errors"
	"fmt"
	"time"

	"github.com/jackc/pgx/v5"
)

// Saved strategies (migration 000156): the signed-in user's My strategies list.
//
// Every write runs in one transaction that first takes a transaction-scoped
// advisory lock on the user. Two saves by the same user therefore run one
// after the other, so the cap is exact: the INSERT counts the user's rows and
// the count it sees is the count after every earlier save. The lock is per
// user, so one user's saves never wait on another's.

// MaxSavedStrategies is the most strategies one user may keep saved (OD-17).
// Saving one already saved is not a new strategy and never counts against it.
const MaxSavedStrategies = 20

// ErrStrategySaveLimit is returned when a user already holds MaxSavedStrategies
// and asks to save another strategy.
var ErrStrategySaveLimit = errors.New("saved strategy limit reached")

// ErrStrategyRefNotFound is returned for a variant reference the user does not
// own, or one that names no variant. The two cases are not told apart, so a
// reference to another user's variant reads the same as one that does not exist.
var ErrStrategyRefNotFound = errors.New("strategy reference not found")

// StrategySaveRow is one saved strategy as stored.
type StrategySaveRow struct {
	StrategyRef string
	SavedAt     time.Time
}

// StrategySavesStore is the part of the store the saved-strategy RPCs use. The
// Postgres store implements it; a store without the table cannot, and the
// handlers then answer as unavailable.
type StrategySavesStore interface {
	// SaveStrategy records the save and returns the row. A repeat save returns
	// the existing row unchanged. ErrStrategySaveLimit when the user is at the
	// cap and the strategy is not already saved; ErrStrategyRefNotFound for a
	// variant the user does not own.
	SaveStrategy(ctx context.Context, userID, strategyRef string) (StrategySaveRow, error)
	// UnsaveStrategy removes the save. Removing one that is not saved succeeds.
	UnsaveStrategy(ctx context.Context, userID, strategyRef string) error
	// ListStrategySaves returns the user's saves, most recent first. A database
	// without the table answers an empty list.
	ListStrategySaves(ctx context.Context, userID string) ([]StrategySaveRow, error)
}

// strategySavesLockKey is the advisory-lock key of one user's saves.
const strategySavesLockKey = "strategy_saves:"

func (s *postgresStore) SaveStrategy(ctx context.Context, userID, strategyRef string) (StrategySaveRow, error) {
	ctx, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()

	tx, err := s.db.Begin(ctx)
	if err != nil {
		return StrategySaveRow{}, fmt.Errorf("begin strategy save: %w", relationMissing(err))
	}
	defer func() { _ = tx.Rollback(ctx) }()

	if _, err := tx.Exec(ctx, `SELECT pg_advisory_xact_lock(hashtextextended($1::text, 0))`, strategySavesLockKey+userID); err != nil {
		return StrategySaveRow{}, fmt.Errorf("lock strategy saves: %w", relationMissing(err))
	}

	if len(strategyRef) > len(variantRefPrefix) && strategyRef[:len(variantRefPrefix)] == variantRefPrefix {
		owned, err := variantOwnedBy(ctx, tx, userID, strategyRef[len(variantRefPrefix):])
		if err != nil {
			return StrategySaveRow{}, err
		}
		if !owned {
			return StrategySaveRow{}, ErrStrategyRefNotFound
		}
	}

	var row StrategySaveRow
	err = tx.QueryRow(ctx, `
		INSERT INTO user_saved_strategies (user_id, strategy_ref)
		SELECT $1::text, $2::text
		WHERE (SELECT count(*) FROM user_saved_strategies WHERE user_id = $1::text) < $3::bigint
		ON CONFLICT (user_id, strategy_ref) DO NOTHING
		RETURNING strategy_ref, created_at`,
		userID, strategyRef, int64(MaxSavedStrategies),
	).Scan(&row.StrategyRef, &row.SavedAt)
	if err == nil {
		if err := tx.Commit(ctx); err != nil {
			return StrategySaveRow{}, fmt.Errorf("commit strategy save: %w", err)
		}
		return row, nil
	}
	if !errors.Is(err, pgx.ErrNoRows) {
		return StrategySaveRow{}, fmt.Errorf("save strategy: %w", relationMissing(err))
	}

	// No row was inserted: either the strategy is already saved (a repeat save
	// succeeds whatever the count), or the user is at the cap.
	err = tx.QueryRow(ctx, `
		SELECT strategy_ref, created_at FROM user_saved_strategies
		WHERE user_id = $1::text AND strategy_ref = $2::text`,
		userID, strategyRef,
	).Scan(&row.StrategyRef, &row.SavedAt)
	if errors.Is(err, pgx.ErrNoRows) {
		return StrategySaveRow{}, ErrStrategySaveLimit
	}
	if err != nil {
		return StrategySaveRow{}, fmt.Errorf("read existing strategy save: %w", relationMissing(err))
	}
	if err := tx.Commit(ctx); err != nil {
		return StrategySaveRow{}, fmt.Errorf("commit strategy save: %w", err)
	}
	return row, nil
}

// variantRefPrefix marks a saved reference to one of the user's variants.
const variantRefPrefix = "variant:"

// variantOwnedBy reports whether the variant exists and belongs to the user.
// A database without the strategy_variants table (migration 000157 not
// applied) has no variant the user could own, so the answer is false.
func variantOwnedBy(ctx context.Context, tx pgx.Tx, userID, variantID string) (bool, error) {
	// The catalog check comes first: Postgres resolves a table name when it
	// plans the statement, so an EXISTS over a missing table would fail even
	// behind a CASE that never reads it.
	var present *string
	if err := tx.QueryRow(ctx, `SELECT to_regclass('public.strategy_variants')::text`).Scan(&present); err != nil {
		return false, fmt.Errorf("check variant table: %w", err)
	}
	if present == nil {
		return false, nil
	}
	var exists bool
	if err := tx.QueryRow(ctx, `
		SELECT EXISTS (SELECT 1 FROM strategy_variants WHERE id = $2::text AND user_id = $1::text)`,
		userID, variantID,
	).Scan(&exists); err != nil {
		return false, fmt.Errorf("check variant owner: %w", relationMissing(err))
	}
	return exists, nil
}

func (s *postgresStore) UnsaveStrategy(ctx context.Context, userID, strategyRef string) error {
	ctx, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()
	if _, err := s.db.Exec(ctx, `
		DELETE FROM user_saved_strategies WHERE user_id = $1::text AND strategy_ref = $2::text`,
		userID, strategyRef,
	); err != nil {
		return fmt.Errorf("unsave strategy: %w", relationMissing(err))
	}
	return nil
}

func (s *postgresStore) ListStrategySaves(ctx context.Context, userID string) ([]StrategySaveRow, error) {
	ctx, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()
	rows, err := s.db.Query(ctx, `
		SELECT strategy_ref, created_at FROM user_saved_strategies
		WHERE user_id = $1::text
		ORDER BY created_at DESC, strategy_ref ASC`,
		userID,
	)
	if err != nil {
		if errors.Is(relationMissing(err), ErrRelationMissing) {
			logMissingRelationOnce("ListStrategySaves", err)
			return nil, nil
		}
		return nil, fmt.Errorf("list strategy saves: %w", err)
	}
	defer rows.Close()

	out := []StrategySaveRow{}
	for rows.Next() {
		var r StrategySaveRow
		if err := rows.Scan(&r.StrategyRef, &r.SavedAt); err != nil {
			return nil, fmt.Errorf("scan strategy save: %w", err)
		}
		out = append(out, r)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("read strategy saves: %w", err)
	}
	return out, nil
}
