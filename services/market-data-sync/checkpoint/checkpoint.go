package checkpoint

import (
	"context"
	"database/sql"
	"fmt"

	"github.com/jackc/pgx/v5/pgxpool"
)

// Checkpoint represents the current state of a sync run
type Checkpoint struct {
	RunID   string
	Status  string

	// Overall progress
	StocksTotal      int
	StocksProcessed  int
	StocksSuccessful int
	StocksFailed     int

	// Priority tracking
	PriorityTotal     int
	PriorityProcessed int
	PriorityCompleted bool

	// Per-syncer stats
	PricesRecordsUpdated int
	AlgoliaRecordsSynced int

	// Resume support
	ResumeFrom int
}

// Store handles checkpoint persistence
type Store struct {
	db *pgxpool.Pool
}

// NewStore creates a new checkpoint store
func NewStore(db *pgxpool.Pool) *Store {
	return &Store{db: db}
}

// StartRun initializes a new sync run with priority tracking
func (s *Store) StartRun(ctx context.Context, runID string, total, priorityCount int) error {
	// Check if run_id already exists
	var exists bool
	err := s.db.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM sync_status WHERE run_id = $1)`, runID).Scan(&exists)
	if err != nil {
		return fmt.Errorf("failed to check existing run: %w", err)
	}

	// Check if priority columns exist (for backward compatibility)
	var hasPriorityColumns bool
	err = s.db.QueryRow(ctx, `
		SELECT EXISTS (
			SELECT 1 FROM information_schema.columns 
			WHERE table_name = 'sync_status' 
			AND column_name = 'checkpoint_priority_total'
		)
	`).Scan(&hasPriorityColumns)
	if err != nil {
		// If we can't check, assume columns don't exist and use fallback
		hasPriorityColumns = false
	}

	if exists {
		// Update existing run
		if hasPriorityColumns {
			_, err = s.db.Exec(ctx, `
				UPDATE sync_status SET
					status = 'running',
					started_at = CURRENT_TIMESTAMP,
					checkpoint_stocks_total = $2,
					checkpoint_priority_total = $3,
					checkpoint_stocks_processed = 0,
					checkpoint_stocks_successful = 0,
					checkpoint_stocks_failed = 0,
					checkpoint_priority_processed = 0,
					checkpoint_priority_completed = false
				WHERE run_id = $1
			`, runID, total, priorityCount)
		} else {
			// Fallback: update without priority columns
			_, err = s.db.Exec(ctx, `
				UPDATE sync_status SET
					status = 'running',
					started_at = CURRENT_TIMESTAMP,
					checkpoint_stocks_total = $2,
					checkpoint_stocks_processed = 0,
					checkpoint_stocks_successful = 0,
					checkpoint_stocks_failed = 0
				WHERE run_id = $1
			`, runID, total)
		}
	} else {
		// Insert new run
		if hasPriorityColumns {
			_, err = s.db.Exec(ctx, `
				INSERT INTO sync_status (
					run_id, status, started_at,
					checkpoint_stocks_total, checkpoint_priority_total,
					checkpoint_stocks_processed, checkpoint_stocks_successful, checkpoint_stocks_failed,
					checkpoint_priority_processed, checkpoint_priority_completed
				) VALUES ($1, 'running', CURRENT_TIMESTAMP, $2, $3, 0, 0, 0, 0, false)
			`, runID, total, priorityCount)
		} else {
			// Fallback: insert without priority columns
			_, err = s.db.Exec(ctx, `
				INSERT INTO sync_status (
					run_id, status, started_at,
					checkpoint_stocks_total,
					checkpoint_stocks_processed, checkpoint_stocks_successful, checkpoint_stocks_failed
				) VALUES ($1, 'running', CURRENT_TIMESTAMP, $2, 0, 0, 0)
			`, runID, total)
		}
	}
	return err
}

// UpdateProgress updates the sync progress including priority tracking
func (s *Store) UpdateProgress(ctx context.Context, runID string, processed, successful, failed, priorityProcessed int) error {
	// Check if priority columns exist
	var hasPriorityColumns bool
	err := s.db.QueryRow(ctx, `
		SELECT EXISTS (
			SELECT 1 FROM information_schema.columns 
			WHERE table_name = 'sync_status' 
			AND column_name = 'checkpoint_priority_total'
		)
	`).Scan(&hasPriorityColumns)
	if err != nil {
		hasPriorityColumns = false
	}

	if hasPriorityColumns {
		_, err = s.db.Exec(ctx, `
			UPDATE sync_status SET
				checkpoint_stocks_processed = $2,
				checkpoint_stocks_successful = $3,
				checkpoint_stocks_failed = $4,
				checkpoint_priority_processed = $5,
				checkpoint_priority_completed = CASE
					WHEN checkpoint_priority_total > 0 AND $5 >= checkpoint_priority_total THEN true
					ELSE checkpoint_priority_completed
				END,
				status = CASE
					WHEN $2 >= checkpoint_stocks_total THEN 'completed'
					ELSE 'running'
				END,
				completed_at = CASE
					WHEN $2 >= checkpoint_stocks_total THEN CURRENT_TIMESTAMP
					ELSE NULL
				END
			WHERE run_id = $1
		`, runID, processed, successful, failed, priorityProcessed)
	} else {
		// Fallback: update without priority columns
		_, err = s.db.Exec(ctx, `
			UPDATE sync_status SET
				checkpoint_stocks_processed = $2,
				checkpoint_stocks_successful = $3,
				checkpoint_stocks_failed = $4,
				status = CASE
					WHEN $2 >= checkpoint_stocks_total THEN 'completed'
					ELSE 'running'
				END,
				completed_at = CASE
					WHEN $2 >= checkpoint_stocks_total THEN CURRENT_TIMESTAMP
					ELSE NULL
				END
			WHERE run_id = $1
		`, runID, processed, successful, failed)
	}
	return err
}

// UpdatePricesCount updates the prices records count
func (s *Store) UpdatePricesCount(ctx context.Context, runID string, count int) error {
	_, err := s.db.Exec(ctx, `
		UPDATE sync_status SET prices_records_updated = $2 WHERE run_id = $1
	`, runID, count)
	return err
}

// UpdateAlgoliaCount updates the Algolia records synced count
func (s *Store) UpdateAlgoliaCount(ctx context.Context, runID string, count int) error {
	_, err := s.db.Exec(ctx, `
		UPDATE sync_status SET algolia_records_synced = $2 WHERE run_id = $1
	`, runID, count)
	return err
}

// FailRun marks a sync run as failed with an error message
func (s *Store) FailRun(ctx context.Context, runID string, errMsg string) error {
	_, err := s.db.Exec(ctx, `
		UPDATE sync_status SET
			status = 'failed',
			error_message = $2,
			completed_at = CURRENT_TIMESTAMP
		WHERE run_id = $1
	`, runID, errMsg)
	return err
}

// CompleteRun marks a sync run as completed
func (s *Store) CompleteRun(ctx context.Context, runID string) error {
	_, err := s.db.Exec(ctx, `
		UPDATE sync_status SET
			status = 'completed',
			completed_at = CURRENT_TIMESTAMP
		WHERE run_id = $1
	`, runID)
	return err
}

// GetIncompleteRun retrieves the most recent incomplete sync run
func (s *Store) GetIncompleteRun(ctx context.Context) (*Checkpoint, error) {
	var cp Checkpoint
	var priorityTotal, priorityProcessed sql.NullInt32
	var priorityCompleted sql.NullBool

	err := s.db.QueryRow(ctx, `
		SELECT 
			run_id, 
			checkpoint_stocks_total, 
			checkpoint_stocks_processed, 
			checkpoint_stocks_successful, 
			checkpoint_stocks_failed, 
			status,
			COALESCE(checkpoint_priority_total, 0),
			COALESCE(checkpoint_priority_processed, 0),
			COALESCE(checkpoint_priority_completed, false)
		FROM sync_status
		WHERE status IN ('running', 'partial')
		ORDER BY started_at DESC
		LIMIT 1
	`).Scan(
		&cp.RunID,
		&cp.StocksTotal,
		&cp.StocksProcessed,
		&cp.StocksSuccessful,
		&cp.StocksFailed,
		&cp.Status,
		&priorityTotal,
		&priorityProcessed,
		&priorityCompleted,
	)

	if err != nil {
		return nil, fmt.Errorf("failed to get incomplete run: %w", err)
	}

	cp.PriorityTotal = int(priorityTotal.Int32)
	cp.PriorityProcessed = int(priorityProcessed.Int32)
	cp.PriorityCompleted = priorityCompleted.Bool
	cp.ResumeFrom = cp.StocksProcessed

	return &cp, nil
}

// GetRun retrieves a specific sync run by ID
func (s *Store) GetRun(ctx context.Context, runID string) (*Checkpoint, error) {
	var cp Checkpoint
	var priorityTotal, priorityProcessed sql.NullInt32
	var priorityCompleted sql.NullBool
	var pricesUpdated, algoliaUpdated sql.NullInt32

	err := s.db.QueryRow(ctx, `
		SELECT 
			run_id, 
			checkpoint_stocks_total, 
			checkpoint_stocks_processed, 
			checkpoint_stocks_successful, 
			checkpoint_stocks_failed, 
			status,
			COALESCE(checkpoint_priority_total, 0),
			COALESCE(checkpoint_priority_processed, 0),
			COALESCE(checkpoint_priority_completed, false),
			COALESCE(prices_records_updated, 0),
			COALESCE(algolia_records_synced, 0)
		FROM sync_status
		WHERE run_id = $1
	`, runID).Scan(
		&cp.RunID,
		&cp.StocksTotal,
		&cp.StocksProcessed,
		&cp.StocksSuccessful,
		&cp.StocksFailed,
		&cp.Status,
		&priorityTotal,
		&priorityProcessed,
		&priorityCompleted,
		&pricesUpdated,
		&algoliaUpdated,
	)

	if err != nil {
		return nil, fmt.Errorf("failed to get run %s: %w", runID, err)
	}

	cp.PriorityTotal = int(priorityTotal.Int32)
	cp.PriorityProcessed = int(priorityProcessed.Int32)
	cp.PriorityCompleted = priorityCompleted.Bool
	cp.PricesRecordsUpdated = int(pricesUpdated.Int32)
	cp.AlgoliaRecordsSynced = int(algoliaUpdated.Int32)

	return &cp, nil
}
