package shortdatasync

import (
	"context"
	"fmt"
	"log"
	"os"
	"time"

	"github.com/google/uuid"
)

// Statuses written to sync_status.status. The column has a CHECK constraint
// (running | completed | failed | partial), so these strings are load-bearing.
const (
	statusRunning   = "running"
	statusCompleted = "completed"
	statusFailed    = "failed"
	statusPartial   = "partial"
)

// recorder writes one sync_status row per run — the table the admin jobs
// dashboard reads. Column set and semantics are carried over verbatim from
// SyncStatusRecorder in comprehensive_daily_sync.py.
//
// The price/metric counters exist and are written as ZERO: this job no longer
// syncs prices (see the package doc), and leaving the columns unwritten would
// make an old partial row's numbers look like this run's.
type recorder struct {
	store     *pgStore
	runID     string
	startedAt time.Time
	env       string
	host      string

	shortsRecordsUpdated int
	algoliaRecordsSynced int
}

// newRecorder builds a recorder for runID, minting a fresh UUID when empty
// (i.e. when no in-progress run for this execution was found).
func newRecorder(store *pgStore, runID string) *recorder {
	if runID == "" {
		runID = uuid.NewString()
	}
	return &recorder{
		store: store,
		runID: runID,
		env:   envOr("ENVIRONMENT", "development"),
		host:  hostIdentity(),
	}
}

// hostIdentity resolves the value stored in sync_status.hostname.
//
// CLOUD_RUN_EXECUTION first, and that ordering is the PR #231 fix: the
// execution id ("shorts-data-sync-hztgm") is identical across every task retry
// of ONE execution but unique per day, which is what lets a retry find and
// resume its own row. CLOUD_RUN_JOB is the same string every day and must NOT
// be preferred — doing so is what made resume fall back to a calendar-date
// match, which broke whenever a retry crossed UTC midnight.
func hostIdentity() string {
	for _, key := range []string{"CLOUD_RUN_EXECUTION", "K_SERVICE", "CLOUD_RUN_JOB"} {
		if v := os.Getenv(key); v != "" {
			return v
		}
	}
	name, err := os.Hostname()
	if err != nil {
		return "unknown"
	}
	return name
}

func envOr(key, def string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return def
}

const findResumableByExecutionSQL = `
            SELECT run_id, checkpoint_stocks_processed, checkpoint_stocks_total
            FROM sync_status
            WHERE hostname = $1
              AND status IN ('running', 'partial')
            ORDER BY checkpoint_stocks_processed DESC, started_at DESC
            LIMIT 1`

const findResumableRecentSQL = `
            SELECT run_id, checkpoint_stocks_processed, checkpoint_stocks_total
            FROM sync_status
            WHERE started_at > NOW() - INTERVAL '20 hours'
              AND status IN ('running', 'partial')
            ORDER BY checkpoint_stocks_processed DESC, started_at DESC
            LIMIT 1`

// findResumableRun returns the in-progress run belonging to THIS Cloud Run
// execution, or "" for a fresh run — get_or_create_daily_sync_run().
//
// Keyed on the execution id (stored in hostname), never on the calendar date:
// a job that starts at 10:00 UTC and retries for hours inevitably crosses UTC
// midnight, and the date-scoped lookup it replaced then failed to see its own
// in-progress row, restarted from zero and burned the retry budget (PR #231).
// Off Cloud Run there is no execution id, so a 20-hour rolling window stands in
// — deliberately a window, not a date.
//
// A row whose processed count already covers its total is NOT adopted; that run
// finished its work and a new one starts fresh.
func (s *pgStore) findResumableRun(ctx context.Context, executionID string) (string, error) {
	sql, args := findResumableRecentSQL, []any(nil)
	if executionID != "" {
		sql, args = findResumableByExecutionSQL, []any{executionID}
	}
	var runID string
	var processed, total *int
	err := s.db.QueryRow(ctx, sql, args...).Scan(&runID, &processed, &total)
	if err != nil {
		// No row (or an unreadable one) simply means "start fresh"; the Python
		// treated both identically.
		return "", nil
	}
	p, t := deref(processed), deref(total)
	if p < t {
		log.Printf("🔄 Found incomplete sync run: %s", runID)
		log.Printf("   Progress: %d/%d stocks", p, t)
		return runID, nil
	}
	return "", nil
}

func deref(p *int) int {
	if p == nil {
		return 0
	}
	return *p
}

const insertRunSQL = `
                INSERT INTO sync_status (
                    run_id, status, environment, hostname,
                    checkpoint_stocks_total, checkpoint_batch_size, checkpoint_resume_from,
                    checkpoint_stocks_processed, checkpoint_stocks_successful, checkpoint_stocks_failed
                ) VALUES ($1, 'running', $2, $3, $4, $5, $6, 0, 0, 0)`

const resumeRunSQL = `
                UPDATE sync_status SET
                    status = 'running',
                    started_at = CURRENT_TIMESTAMP,
                    checkpoint_stocks_total = COALESCE($2, checkpoint_stocks_total),
                    checkpoint_batch_size = COALESCE($3, checkpoint_batch_size)
                WHERE run_id = $1`

// Start opens (or re-opens) the run row. batchSize is recorded for schema
// compatibility with the dashboard; totalStocks is 0 because the stock loop
// moved to `shorted market-data`.
func (r *recorder) Start(ctx context.Context, totalStocks, batchSize int, resumed bool) error {
	r.startedAt = time.Now()
	if resumed {
		var total, batch *int
		if totalStocks > 0 {
			total = &totalStocks
		}
		if batchSize > 0 {
			batch = &batchSize
		}
		if _, err := r.store.db.Exec(ctx, resumeRunSQL, r.runID, total, batch); err != nil {
			return fmt.Errorf("resume sync_status row: %w", err)
		}
		log.Printf("🔄 Resuming sync run %s from checkpoint", r.runID)
	} else if _, err := r.store.db.Exec(ctx, insertRunSQL,
		r.runID, r.env, r.host, totalStocks, batchSize, 0); err != nil {
		return fmt.Errorf("insert sync_status row: %w", err)
	}
	log.Printf("📝 Sync run started with ID: %s", r.runID)
	return nil
}

const completeRunSQL = `
                UPDATE sync_status SET
                    status = $2,
                    completed_at = CURRENT_TIMESTAMP,
                    shorts_records_updated = $3,
                    prices_records_updated = 0,
                    prices_alpha_success = 0,
                    prices_yahoo_success = 0,
                    prices_failed = 0,
                    prices_skipped = 0,
                    metrics_records_updated = 0,
                    metrics_failed = 0,
                    algolia_records_synced = $4,
                    total_duration_seconds = $5,
                    checkpoint_stocks_processed = 0,
                    checkpoint_stocks_successful = 0,
                    checkpoint_stocks_failed = 0,
                    checkpoint_resume_from = 0
                WHERE run_id = $1`

// Complete records the terminal state. allComplete=false writes 'partial',
// which is what makes Cloud Run's retry pick the run back up.
func (r *recorder) Complete(ctx context.Context, allComplete bool) error {
	status := statusCompleted
	if !allComplete {
		status = statusPartial
	}
	if _, err := r.store.db.Exec(ctx, completeRunSQL,
		r.runID, status, r.shortsRecordsUpdated, r.algoliaRecordsSynced, r.duration()); err != nil {
		return fmt.Errorf("complete sync_status row: %w", err)
	}
	log.Printf("📝 Sync run %s (%s): shorts_records_updated=%d", r.runID, status, r.shortsRecordsUpdated)
	return nil
}

const failRunSQL = `
            UPDATE sync_status SET
                status = 'failed',
                completed_at = CURRENT_TIMESTAMP,
                error_message = $2,
                total_duration_seconds = $3
            WHERE run_id = $1`

// Fail records a failed run. It is best-effort: the caller is already returning
// an error, and a second error from the status write must not replace it.
func (r *recorder) Fail(ctx context.Context, message string) {
	// The run context may already be cancelled (SIGTERM / task timeout), which
	// is exactly when this row matters most — write it on a detached context.
	writeCtx, cancel := context.WithTimeout(context.WithoutCancel(ctx), 15*time.Second)
	defer cancel()
	if _, err := r.store.db.Exec(writeCtx, failRunSQL, r.runID, message, r.duration()); err != nil {
		log.Printf("⚠️  failed to mark sync run %s as failed: %v", r.runID, err)
		return
	}
	log.Printf("📝 Sync run marked as failed: %s", message)
}

func (r *recorder) duration() float64 {
	if r.startedAt.IsZero() {
		return 0
	}
	return time.Since(r.startedAt).Seconds()
}
