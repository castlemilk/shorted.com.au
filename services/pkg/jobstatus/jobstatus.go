// Package jobstatus provides best-effort job-run tracking to the job_runs table.
// All writes are NON-FATAL: if the table or columns don't exist (the job-watchdog
// migration may not be applied), calls silently no-op so callers never break.
package jobstatus

import (
	"context"
	"encoding/json"
	"log"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
)

// Run is a handle to an in-progress job run. A nil/empty Run is safe to call.
type Run struct {
	db   *pgxpool.Pool
	id   string
	name string
}

// Start records the beginning of a job run. Best-effort: always returns a usable
// *Run even if the insert fails, so callers can defer Fail/CompleteWith safely.
func Start(db *pgxpool.Pool, name, trigger string) *Run {
	r := &Run{db: db, name: name}
	if db == nil {
		return r
	}
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	if err := db.QueryRow(ctx, `
		INSERT INTO job_runs (job_name, trigger, status, started_at)
		VALUES ($1, $2, 'running', now())
		RETURNING id::text`, name, trigger).Scan(&r.id); err != nil {
		log.Printf("jobstatus: start %q (non-fatal): %v", name, err)
	}
	return r
}

func (r *Run) finish(status string, processed, failed int, metadata map[string]any, errMsg string) {
	if r == nil || r.db == nil || r.id == "" {
		return
	}
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	var meta []byte
	if metadata != nil {
		meta, _ = json.Marshal(metadata)
	}
	if _, err := r.db.Exec(ctx, `
		UPDATE job_runs
		SET status=$2, completed_at=now(), items_processed=$3, items_failed=$4,
		    metadata=$5, error_message=$6
		WHERE id=$1::uuid`, r.id, status, processed, failed, meta, errMsg); err != nil {
		log.Printf("jobstatus: finish %q (non-fatal): %v", r.name, err)
	}
}

// Fail marks the run as failed (best-effort).
func (r *Run) Fail(err error) {
	msg := ""
	if err != nil {
		msg = err.Error()
	}
	r.finish("failed", 0, 0, nil, msg)
}

// CompleteWith marks the run completed with counts + metadata (best-effort).
func (r *Run) CompleteWith(processed, failed int, metadata map[string]any) {
	r.finish("completed", processed, failed, metadata, "")
}
