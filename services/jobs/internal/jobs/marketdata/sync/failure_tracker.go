package sync

import (
	"context"
	"log"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
)

const (
	// MaxConsecutiveFailures before a symbol is blocked
	MaxConsecutiveFailures = 3
	// BlockDuration is how long a blocked symbol stays blocked before retry
	BlockDuration = 30 * 24 * time.Hour // 30 days
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
func (ft *FailureTracker) RecordFailure(ctx context.Context, symbol string, errMsg string) {
	now := time.Now()
	_, err := ft.db.Exec(ctx, `
		INSERT INTO stock_sync_failures (stock_code, consecutive_failures, last_failure_at, last_error, updated_at)
		VALUES ($1, 1, $2, $3, $2)
		ON CONFLICT (stock_code) DO UPDATE SET
			consecutive_failures = stock_sync_failures.consecutive_failures + 1,
			last_failure_at = $2,
			last_error = $3,
			blocked_until = CASE
				WHEN stock_sync_failures.consecutive_failures + 1 >= $4
				THEN $2 + INTERVAL '30 days'
				ELSE stock_sync_failures.blocked_until
			END,
			updated_at = $2
	`, symbol, now, errMsg, MaxConsecutiveFailures)
	if err != nil {
		log.Printf("⚠️ Failed to record failure for %s: %v", symbol, err)
	}
}

// RecordSuccess resets the failure counter for a symbol
func (ft *FailureTracker) RecordSuccess(ctx context.Context, symbol string) {
	now := time.Now()
	_, err := ft.db.Exec(ctx, `
		INSERT INTO stock_sync_failures (stock_code, consecutive_failures, last_success_at, updated_at)
		VALUES ($1, 0, $2, $2)
		ON CONFLICT (stock_code) DO UPDATE SET
			consecutive_failures = 0,
			blocked_until = NULL,
			last_success_at = $2,
			updated_at = $2
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
