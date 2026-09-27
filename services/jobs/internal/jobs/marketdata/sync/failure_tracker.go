package sync

import (
	"context"
	"log"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
)

const (
	// MaxConsecutiveFailures before a symbol is blocked. Only a "no data" answer
	// over a window that must have held a session counts (see RunWith); a
	// refused or failed request never does.
	MaxConsecutiveFailures = 3
	// BlockDuration is how long a blocked symbol stays blocked before retry.
	//
	// It was 30 days, but no block was ever written: RecordFailure's timestamp
	// arithmetic failed under the simple protocol prod uses (see there). So the
	// first blocks are only now being written, and a month is too long for what
	// actually collects three strikes: a stock halted for a week would come back
	// to three more weeks without prices. A week still spares a dead code six
	// requests in seven.
	BlockDuration = 7 * 24 * time.Hour
)

// FailureTracker tracks symbols that consistently fail Yahoo Finance fetches
// and auto-blocks them to avoid wasting time on known-bad symbols.
type FailureTracker struct {
	db *pgxpool.Pool
}

// NewFailureTracker creates a new failure tracker
func NewFailureTracker(db *pgxpool.Pool) *FailureTracker {
	return &FailureTracker{db: db}
}

// IsBlocked checks if a symbol is currently blocked (should be skipped)
func (ft *FailureTracker) IsBlocked(ctx context.Context, symbol string) bool {
	var blockedUntil *time.Time
	err := ft.db.QueryRow(ctx,
		`SELECT blocked_until FROM stock_sync_failures WHERE stock_code = $1`,
		symbol,
	).Scan(&blockedUntil)
	if err != nil {
		return false // Not tracked = not blocked
	}
	if blockedUntil == nil {
		return false
	}
	return time.Now().Before(*blockedUntil)
}

// GetBlockedSymbols returns all currently blocked symbols for efficient batch checking
func (ft *FailureTracker) GetBlockedSymbols(ctx context.Context) map[string]bool {
	blocked := make(map[string]bool)
	rows, err := ft.db.Query(ctx,
		`SELECT stock_code FROM stock_sync_failures WHERE blocked_until > NOW()`,
	)
	if err != nil {
		log.Printf("⚠️ Failed to query blocked symbols: %v", err)
		return blocked
	}
	defer rows.Close()

	for rows.Next() {
		var code string
		if err := rows.Scan(&code); err == nil {
			blocked[code] = true
		}
	}
	return blocked
}

// RecordFailure records a fetch failure for a symbol.
// After MaxConsecutiveFailures, the symbol is blocked for BlockDuration.
//
// Every parameter is cast. The pool uses the simple protocol (the Supabase
// transaction pooler needs it), which sends arguments as untyped literals, and
// the old `$2 + INTERVAL '30 days'` resolved the timestamp literal as an
// interval and failed: in prod this statement never wrote a row, so nothing
// was ever blocked. The block's end is now computed here rather than in SQL.
func (ft *FailureTracker) RecordFailure(ctx context.Context, symbol string, errMsg string) {
	now := time.Now()
	_, err := ft.db.Exec(ctx, `
		INSERT INTO stock_sync_failures (stock_code, consecutive_failures, last_failure_at, last_error, updated_at)
		VALUES ($1, 1, $2::timestamptz, $3, $2::timestamptz)
		ON CONFLICT (stock_code) DO UPDATE SET
			consecutive_failures = stock_sync_failures.consecutive_failures + 1,
			last_failure_at = $2::timestamptz,
			last_error = $3,
			blocked_until = CASE
				WHEN stock_sync_failures.consecutive_failures + 1 >= $4::int
				THEN $5::timestamptz
				ELSE stock_sync_failures.blocked_until
			END,
			updated_at = $2::timestamptz
	`, symbol, now, errMsg, MaxConsecutiveFailures, now.Add(BlockDuration))
	if err != nil {
		log.Printf("⚠️ Failed to record failure for %s: %v", symbol, err)
	}
}

// RecordSuccess resets the failure counter for a symbol
func (ft *FailureTracker) RecordSuccess(ctx context.Context, symbol string) {
	now := time.Now()
	_, err := ft.db.Exec(ctx, `
		INSERT INTO stock_sync_failures (stock_code, consecutive_failures, last_success_at, updated_at)
		VALUES ($1, 0, $2::timestamptz, $2::timestamptz)
		ON CONFLICT (stock_code) DO UPDATE SET
			consecutive_failures = 0,
			blocked_until = NULL,
			last_success_at = $2::timestamptz,
			updated_at = $2::timestamptz
	`, symbol, now)
	if err != nil {
		log.Printf("⚠️ Failed to record success for %s: %v", symbol, err)
	}
}

// EnsureTable creates the failure tracking table if it doesn't exist.
// This is a safety net — the migration should handle this, but we want
// the feature to work even if migrations haven't been run yet.
func (ft *FailureTracker) EnsureTable(ctx context.Context) {
	_, err := ft.db.Exec(ctx, `
		CREATE TABLE IF NOT EXISTS stock_sync_failures (
			stock_code VARCHAR(20) PRIMARY KEY,
			consecutive_failures INT NOT NULL DEFAULT 0,
			last_failure_at TIMESTAMPTZ,
			last_error TEXT,
			blocked_until TIMESTAMPTZ,
			last_success_at TIMESTAMPTZ,
			created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
			updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
		)
	`)
	if err != nil {
		log.Printf("⚠️ Failed to ensure stock_sync_failures table: %v", err)
	}
}
